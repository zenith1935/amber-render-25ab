/**
 * Một lượt trọn vẹn: mở trình duyệt, nạp cookie, đi hết các nhiệm vụ đang bật, rồi dọn.
 *
 * Trình duyệt được TIÊM VÀO chứ không import ở đây. Nhờ vậy `src/lib/quest-engine` không hề
 * phụ thuộc Playwright: worker máy nhà và worker trong VM mỗi bên tự nạp bản Chromium của
 * mình rồi đưa vào, còn bundle của Next — vốn chỉ đọc mấy tệp này để gửi sang VM — không
 * bao giờ kéo theo một thư viện trình duyệt nặng nề mà nó không dùng.
 */

import { readinessProbe, vipProbe } from "./boardScripts.mjs";
import { closeBrowserWithin } from "./browserShutdown.mjs";
import { computeNextDelaySeconds } from "./cooldown.mjs";
import { DEFAULT_GAME_BASE_URL, parseCookieString } from "./cookies.mjs";
import { isDailyQuotaQuest, peersDoneForQuota, reachedDailyQuota } from "./dailyQuota.mjs";
import { createQuestEngine, enabledQuestsInOrder, questsForAccount, QuestAborted } from "./engine.mjs";
import { profileForConfig } from "./profile.mjs";
import { acquireQuestSlot, isDedicatedPageQuest } from "./questGate.mjs";
import { createReferenceQuiz, DEFAULT_QUIZ_REFERENCE_URL } from "./quizReference.mjs";
import { createSession } from "./session.mjs";

// Base URL + parser cookie sống ở module LÁ cookies.mjs (không import gì, không đụng đĩa)
// để server action của Next dùng được mà không kéo cả engine — và cả profile.json — vào
// bundle. Re-export để mọi nơi đang import từ đây vẫn nguyên, và để gói khôi lỗi chỉ cần
// biết một cửa.
export { DEFAULT_GAME_BASE_URL, parseCookieString } from "./cookies.mjs";

/**
 * UA của một Chrome desktop thật, chờ điền số hiệu bản. Chrome thật từ lâu chỉ khai major
 * (`x.0.0.0`) trong UA, nên dạng này không lệch gì với đời thật.
 */
const desktopUserAgent = (major) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

/**
 * Bản GHIM của UA trên — chỉ còn là đường DỰ PHÒNG, dùng lúc mở context trước khi hỏi được
 * chính binary nó là bản mấy (xem `wearRealBrowserIdentity`).
 *
 * Số 151 khớp bản Chromium mà playwright-core 1.62 tải về, và cái ghim ấy chính là chỗ dễ
 * trôi: nâng playwright là số này lệch mà không ai thấy. Từ 19/08/2026 nó không còn là nguồn
 * sự thật — lượt chạy hỏi `Browser.getVersion` rồi tự viết lại UA theo đúng binary.
 */
const DESKTOP_USER_AGENT = desktopUserAgent(151);

/**
 * ── CHROMIUM TỰ KHAI「HeadlessChrome」TRONG CLIENT HINTS, VÀ ĐÓ LÀ CỚ ĐỂ CLOUDFLARE ĐÁNH CAPTCHA ──
 *
 * Đè `userAgent` lúc mở context chỉ sửa được HEADER `User-Agent` và `navigator.userAgent`. Bộ
 * client hints (`Sec-CH-UA`, `Sec-CH-UA-Full-Version-List`, `navigator.userAgentData`) do CHÍNH
 * BINARY tự khai và KHÔNG đi theo phép đè ấy. Đo trên VM ngày 19/08/2026, đúng cấu hình khôi lỗi
 * đang chạy:
 *
 *     user-agent : … Chrome/151.0.0.0 Safari/537.36          ← thứ ta đè
 *     sec-ch-ua  : "Not=A?Brand";v="99", "HeadlessChrome";v="151", "Chromium";v="151"
 *
 * Hai dòng ấy nói hai chuyện khác nhau, và dòng thứ hai còn tự xưng là trình duyệt không đầu.
 * Cloudflare đối chiếu đúng cặp này — nên lời tự thú mà chú thích cũ tưởng đã gỡ (bằng cách đè
 * UA) vẫn còn nguyên, chỉ chuyển sang một cái cửa khác.
 *
 * Chữa bằng CDP, cửa duy nhất Chromium mở cho việc này: `Emulation.setUserAgentOverride` nhận
 * `userAgentMetadata`, tức đè được CẢ client hints. Ba luật của phép đè:
 *
 *   1. MỌI con số lấy từ chính binary (`Browser.getVersion`) — hết ghim tay, hết trôi. Nâng
 *      playwright lên bản khác là UA lẫn brand tự đi theo.
 *   2. Chỉ thay ĐÚNG chữ「HeadlessChrome」thành「Google Chrome」, giữ nguyên brand GREASE và
 *      「Chromium」của chính bản dựng ấy. Bịa cả danh sách là dựng một dấu vân tay không tồn tại
 *      ngoài đời; giữ nguyên phần còn lại thì nó khớp với mọi thứ khác binary tự khai.
 *   3. Hỏng thì KÊU rồi đi tiếp. Không có phép đè này lượt chạy vẫn chạy được (và trước
 *      19/08/2026 nó vẫn chạy như thế) — chỉ là dễ ăn captcha hơn. Ném ở đây là đổi một cái bất
 *      lợi lấy một lượt chạy chết hẳn.
 *
 * KHÔNG `detach()` phiên CDP: phép đè sống theo phiên, gỡ phiên là trả trang về lời tự thú cũ.
 * Nó tự tan khi trang/trình duyệt đóng.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function wearRealBrowserIdentity(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    const info = await cdp.send("Browser.getVersion");
    // "HeadlessChrome/151.0.7922.34" → full "151.0.7922.34" → major "151"
    const full = String(info?.product ?? "").split("/")[1] ?? "";
    const major = full.split(".")[0] ?? "";
    if (!/^\d+$/.test(major)) {
      return { ok: false, detail: `không đọc được số hiệu Chromium từ「${info?.product ?? "(rỗng)"}」` };
    }

    /**
     * Brand GREASE của chính bản dựng này. Chuỗi ấy đổi theo đời Chromium ("Not=A?Brand",
     * "Not(A:Brand", "Not_A Brand"…) nên chép cứng là hẹn ngày lệch; nhưng CDP không trả nó ra,
     * và nó phải khớp với thứ binary vẫn gửi. Lấy đúng chuỗi bản dựng đang dùng, đo được ở
     * `verify:browser-fingerprint`.
     */
    const GREASE = { brand: "Not=A?Brand", version: "99", full: "99.0.0.0" };
    const brands = [
      { brand: GREASE.brand, version: GREASE.version },
      { brand: "Google Chrome", version: major },
      { brand: "Chromium", version: major },
    ];
    const fullVersionList = [
      { brand: GREASE.brand, version: GREASE.full },
      { brand: "Google Chrome", version: full },
      { brand: "Chromium", version: full },
    ];

    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: desktopUserAgent(major),
      acceptLanguage: "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
      platform: "Win32",
      userAgentMetadata: {
        brands,
        fullVersionList,
        fullVersion: full,
        platform: "Windows",
        platformVersion: "10.0",
        architecture: "x86",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
      },
    });
    return { ok: true, detail: `Chrome ${full} (Windows)` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 160) : "lỗi lạ" };
  }
}

/**
 * Cấu hình mở trình duyệt — port TRUNG THỰC từ PlaywrightBrowserSession.cs của bản desktop.
 *
 * Bản web trước đây mở `chromium.launch({ headless: true })` trần trụi: UA "HeadlessChrome",
 * cờ automation bật nguyên, không timezone. Không phải thủ phạm của vụ #lobby-overview
 * (thủ phạm là cookie parse ra rỗng), nhưng là món nợ trước sau gì cũng phải trả — và
 * desktop đã trả từ đầu.
 */
export function launchProfile(headless) {
  return {
    headless,
    userAgent: DESKTOP_USER_AGENT,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    viewport: { width: 1366, height: 768 },
    // Tắt cờ `navigator.webdriver` và banner "being controlled by automated software" —
    // hai dấu automation mà desktop cũng đã tắt từ đầu.
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
}

/** Outcome của engine → câu người đọc, và mức độ để hiện trên Hoạt động. */
const OUTCOME_TEXT = {
  completed: { level: "success", say: (r) => r.message?.trim() || "xong" },
  onCooldown: {
    level: "info",
    say: (r) => `đang chờ${r.cooldownSeconds ? ` — còn ${formatDuration(r.cooldownSeconds)}` : ""}${r.message ? ` (${r.message})` : ""}`,
  },
  alreadyDone: { level: "info", say: (r) => r.message?.trim() || "hôm nay xong rồi" },
  notAvailable: { level: "warn", say: (r) => r.message?.trim() || "không tìm thấy chỗ để bấm" },
  skipped: { level: "info", say: (r) => r.message?.trim() || "bỏ qua" },
  failed: { level: "error", say: (r) => r.message?.trim() || "trắc trở không rõ" },
};

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}


/** Mọi kết quả không-phải-stop đều mang theo lịch vòng kế để server tái xếp đúng nhịp. */
function scheduledCycleResult(outcome, message, results = []) {
  return {
    outcome,
    message,
    nextDelaySeconds: computeNextDelaySeconds(results, { cycleFailed: outcome === "failed" }),
  };
}

/**
 * Thức dậy SAU mốc sang ngày một nhịp, không đúng vào giây ấy: đồng hồ của khôi lỗi và đồng hồ
 * của site không bao giờ khớp tới từng giây, và ghé sớm nửa giây là một vòng nữa đọc ra
 *「vẫn đủ lượt」rồi lại ngủ tiếp.
 */
const DAILY_RESET_OVERSHOOT_SECONDS = 60;

/**
 * Ngủ tới lượt kiểm kế tiếp khi cả vòng chẳng còn gì để làm vì mọi nhiệm vụ đã đủ lượt ngày.
 *
 * Đi qua đúng bộ lập lịch của mọi vòng khác (sàn 30 giây, trần 24 giờ, jitter) thay vì tự kẹp
 * lấy — một nhánh lịch thứ hai là một nhánh sẽ trôi lệch. Server gửi `resetsInSeconds` kèm lúc
 * phát việc; vắng nó (server đời cũ, hoặc lượt chạy tay) thì rơi về nhịp ghé lại mặc định,
 * nghĩa là mất phần tiết kiệm chứ không mất tính đúng đắn.
 */
function delayUntilDailyReset(resetsInSeconds) {
  return Number.isFinite(resetsInSeconds) && resetsInSeconds > 0
    ? computeNextDelaySeconds([
        { outcome: "alreadyDone", cooldownSeconds: resetsInSeconds + DAILY_RESET_OVERSHOOT_SECONDS },
      ])
    : computeNextDelaySeconds([]);
}

/**
 * Cổng sẵn sàng — port của EnsureReadyAsync bên desktop, và là lớp còn thiếu thứ hai.
 *
 * Không có nó, lượt chạy lao thẳng vào quest trên một trang có thể đang là màn Cloudflare
 * hoặc màn đăng nhập, rồi chết ở selector đầu tiên với một thông điệp chẳng nói gì về
 * nguyên nhân. Ở đây: đứng trước cổng, chờ màn kiểm tra tự qua (có hạn), rồi phán rõ —
 * bị chặn là nói bị chặn, hết phiên là nói hết phiên.
 *
 * Trả `{ ok, loginConfirmed }`. `loginConfirmed` là lời thú nhận có chủ ý: cổng này CHỈ đọc
 * được trang chủ, mà trang chủ có thể im lặng về cả hai phía. Nó nói ra mình biết chắc tới
 * đâu thay vì làm tròn thành「xong」, và người gọi — vốn ghé hub ngay sau đó — mới là chỗ có
 * bằng chứng dứt điểm. Đêm 07/08 mất bốn phút mỗi vòng chỉ vì chỗ này từng làm tròn.
 */
async function ensureReady(session, baseUrl, say, log, { context, cookieJar }) {
  /**
   * Tên miền mà lượt điều hướng THẬT SỰ dừng chân, nếu nó khác nơi ta gõ cửa. Site đổi TLD
   * định kỳ (mx → am → …) và tên miền cũ 301 sang tên miền mới; cookie thì gắn chặt vào
   * tên miền, nên chúng KHÔNG đi theo cú nhảy ấy và trang mới nhìn khôi lỗi như khách lạ.
   * Bắt được sự thật này ở đây biến một đêm truy vết thành một dòng nhật ký.
   */
  let movedTo = null;

  /** Vào trang chủ rồi đọc trạng thái, chờ màn Cloudflare tự qua nếu có. */
  async function probeOnce() {
    // Dọn trước mỗi lượt: hàm này chạy tới HAI lần (lượt sau là sau khi tiêm lại cookie),
    // và `movedTo` phải kể về lượt điều hướng CUỐI chứ không giữ lại kết luận của lượt đầu.
    movedTo = null;

    const nav = await session.navigate(baseUrl);
    if (!nav.ok) return { navError: nav.error };

    if (nav.url) {
      try {
        const landed = new URL(nav.url).origin;
        if (landed !== new URL(baseUrl).origin) movedTo = landed;
      } catch {
        // URL không phân tích được thì thôi — đây là phép chẩn đoán thêm, không phải cổng.
      }
    }

    const deadline = Date.now() + 45_000;
    let probe = null;
    let saidChallenge = false;

    while (Date.now() < deadline) {
      probe = await session.evaluate(readinessProbe);
      if (probe == null) {
        await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }

      if (!probe.challenge) break;

      if (!saidChallenge) {
        // Nói MỘT lần rồi chờ trong im lặng — màn kiểm tra dạng managed đôi khi tự qua
        // sau vài giây, nhưng mỗi nhịp poll mà một dòng nhật ký thì thành rác.
        await say("Trang game đang dựng màn kiểm tra (Cloudflare) — khôi lỗi đứng chờ trước cổng…", "warn");
        saidChallenge = true;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return { probe };
  }

  let { probe, navError } = await probeOnce();
  if (navError) {
    return { ok: false, message: `Không mở được trang game (${navError}).` };
  }

  /**
   * Hồ sơ bền không đăng nhập được thì TIÊM LẠI cookie người dùng đã dán, rồi thử lần nữa.
   *
   * Đây là chỗ vụ 02/08 nổ ra. Hồ sơ bền giữ cookie phiên do site tự làm mới, nên lúc mở
   * ta cố ý KHÔNG đè chuỗi dán-tay lên trên — đè là tự tay đăng xuất một phiên đang lành.
   * Nhưng phép kiểm ấy chỉ hỏi "có cookie đăng nhập không", không hỏi "nó còn sống không".
   * Một cookie đã chết vẫn thoả mãn câu hỏi đó, nên khôi lỗi ôm cái xác đi tiếp, và trang lò
   * render ở dạng chưa đăng nhập — `#ld-app` không bao giờ hiện. Lỗi nổi lên ở tên một
   * selector vô tội, mười bước sau nguyên nhân thật.
   *
   * Cách chữa đúng là ĐỪNG TIN, HÃY THỬ: dùng hồ sơ khi nó còn chạy, quay về chuỗi người
   * dùng dán khi nó chết. Không cần đoán, vì trang vừa trả lời rồi.
   */
  if (context && cookieJar?.length && probe && !probe.challenge && probe.loggedIn !== true) {
    log.debug("Sẵn sàng", "Hồ sơ không đăng nhập được — tiêm lại cookie đã lưu rồi thử lần nữa.");
    await context.clearCookies().catch(() => {});
    await context.addCookies(cookieJar);
    ({ probe, navError } = await probeOnce());
    if (navError) {
      return { ok: false, message: `Không mở được trang game (${navError}).` };
    }
  }

  if (probe == null) {
    return { ok: false, message: "Không đọc được trạng thái trang game sau khi tải." };
  }

  if (probe.challenge) {
    return {
      ok: false,
      message:
        "Màn kiểm tra (Cloudflare) của trang game không tự qua — lượt này đành dừng, lượt sau sẽ thử lại.",
    };
  }

  if (probe.loggedIn === false) {
    return {
      ok: false,
      message:
        "Tài khoản hoathinh3d đã hết phiên đăng nhập — dán chuỗi cookie mới ở Ngọc Giản Cấu Hình rồi khai đàn lại.",
    };
  }

  if (probe.loggedIn !== true) {
    // KHÔNG nói gì ở đây, và tuyệt đối không nói「phiên đăng nhập còn hiệu lực」— đó chính là
    // lỗi đêm 07/08: `loggedIn == null` nghĩa là trang không phát tín hiệu nào về PHÍA NÀO
    // (không dấu đã-đăng-nhập, cũng không form đăng nhập), thế mà cổng vẫn phát ra một dòng
    // xanh khẳng định điều nó chưa hề chứng minh, rồi thả cả vòng chạy vào 9 nhiệm vụ. Mỗi
    // nhiệm vụ chết sau 25 giây ở một selector vô tội — bốn phút đỏ rực mỗi vòng, nửa tiếng
    // một lần, mà nhật ký không một lần nhắc tới nguyên nhân thật.
    //
    // Không cứng rắn hoá thành LỖI ở đây, vì mấy cái dấu kia chỉ là suy đoán: hôm nào site
    // đổi markup của người ĐANG đăng nhập, một phán quyết cứng sẽ chặn đứng mọi automation
    // dù tài khoản hoàn toàn lành. Thay vào đó trả sự thật「chưa xác nhận được」lên trên, để
    // chỗ có bằng chứng TỐT HƠN phân xử: ngay sau đây vòng chạy vốn đã ghé hub và poll
    // `.nv-quest` để dò hạng — bảng nhiệm vụ chỉ dựng cho thành viên đã đăng nhập, nên nó
    // trả lời được đúng câu hỏi này mà không tốn thêm một lượt tải trang nào.
    log.debug("Sẵn sàng", "Không xác nhận được trạng thái đăng nhập — để hub phân xử.");
    return { ok: true, loginConfirmed: false, movedTo };
  }

  await say("Đã vào được trang game — phiên đăng nhập còn hiệu lực.", "success");
  return { ok: true, loginConfirmed: true, movedTo };
}

/**
 * @param {object} deps
 * @param {import('playwright-core').BrowserType} deps.chromium
 * @param {object} deps.config           UserConfig đã giải mã (gameCookie là plaintext)
 * @param {(message: string, level?: string) => Promise<void>|void} deps.say
 * @param {(tier: "vip"|"free") => Promise<void>|void} [deps.reportAccountTier]
 * @param {() => boolean} deps.shouldStop  ĐỒNG BỘ — được gọi trong vòng lặp chặt
 * @param {(progress: {running: string[], done: number, total: number}) => void} [deps.reportProgress]
 *   Vòng này đang chạy nhiệm vụ nào — Hàng Đợi Công Việc hiển thị nó. ĐỒNG BỘ, cùng lý do
 *   với `shouldStop`: nó được gọi ở mỗi lần một nhiệm vụ vào/ra tay, tức trong đường chạy
 *   nóng, và không có gì ở đây đáng để chờ một request. Người gọi chỉ việc gán vào một biến;
 *   nhịp tim sẵn có sẽ mang nó đi.
 * @param {string} [deps.baseUrl]
 * @param {number} [deps.budgetMs]       hết ngân sách thì dừng TỬ TẾ giữa hai nhiệm vụ
 * @param {string} [deps.profileDir]     hồ sơ Chromium BỀN trên đĩa — xem ghi chú bên dưới
 * @param {{questIds?: string[], resetsInSeconds?: number}} [deps.dailyDone]
 *   SỔ ĐỦ LƯỢT HÔM NAY của chính đàn này, do server gửi kèm lúc phát việc: những nhiệm vụ đã
 *   chứng minh là hết lượt trong ngày ở một vòng TRƯỚC, cộng số giây còn lại tới mốc sang
 *   ngày. Vắng mặt = vòng đầu của một lần Khai Đàn (sổ trắng, kiểm lại tất) hoặc server đời
 *   cũ chưa biết gửi. Xem dailyQuota.mjs cho phạm vi.
 */
export async function runCycle(deps) {
  const {
    chromium,
    config,
    say,
    reportAccountTier = async () => {},
    reportProgress = () => {},
    shouldStop = () => false,
    // Thứ tự nguồn có chủ ý: người gọi truyền thẳng (smoke) > tên miền server gửi kèm job >
    // env của máy chạy khôi lỗi > hằng số trong mã nguồn. Server đứng TRÊN env vì đó là chỗ
    // duy nhất trưởng môn sửa được mà không phải đụng vào từng máy; env vẫn giữ nguyên quyền
    // phủ quyết cục bộ cho ai muốn trỏ khôi lỗi nhà mình đi chỗ khác để thử.
    baseUrl = deps.config?.gameBaseUrl?.trim() || process.env.GAME_BASE_URL || DEFAULT_GAME_BASE_URL,
    budgetMs = 0,
    headless = true,
    profileDir = process.env.BROWSER_PROFILE_DIR || "",
    dailyDone = null,
  } = deps;

  if (!config?.gameCookie?.trim()) {
    return scheduledCycleResult(
      "failed",
      "Chưa có tài khoản hoathinh3d — hãy dán chuỗi cookie đăng nhập trước.",
    );
  }

  // Parse NGAY và coi số không là lỗi to — không bao giờ để browser đi tay trắng rồi chết
  // ở một selector vô tội mười bước sau (đúng kịch bản 02/08).
  const cookieJar = parseCookieString(config.gameCookie, baseUrl);
  if (cookieJar.length === 0) {
    return scheduledCycleResult(
      "failed",
      (
        "Chuỗi cookie đã lưu không đọc được — vào Ngọc Giản Cấu Hình dán lại tài khoản " +
        "hoathinh3d (dạng 'a=1; b=2' từ DevTools hoặc bản xuất JSON đều được)."
      ),
    );
  }

  const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;

  // Nhật ký hai tầng, y như bản desktop. Info trở lên đi lên Hoạt động cho người đọc; Debug
  // chỉ vào console của máy đang chạy. Không có tầng này thì mỗi lượt Mê Cung đổ hàng nghìn
  // dòng selector vào bảng job_events và chôn mất phần kể chuyện.
  const log = {
    info: (scope, message) => { void say(`${scope}: ${message}`); },
    warning: (scope, message) => { void say(`${scope}: ${message}`, "warn"); },
    debug: (scope, message) => { console.log(`  [debug] ${scope}: ${message}`); },
  };

  const translationNotes = [];
  // Sổ ngày đi CÙNG lúc dịch cấu hình, không phải một phép kiểm rời rạc ở đâu đó sau này:
  // một tuỳ chọn đã hết suất hôm nay thì phải TẮT ngay trong hồ sơ, để không script nào còn
  // nhánh cân nhắc nó. Xem `PHU_DAILY_MARK`.
  const profile = profileForConfig(config, (m) => translationNotes.push(m), dailyDone?.questIds);
  const enabled = enabledQuestsInOrder(profile);

  if (enabled.length === 0) {
    return scheduledCycleResult("done", "Không có nhiệm vụ nào được bật — sẽ kiểm tra lại ở vòng kế.");
  }

  for (const note of translationNotes) await say(note, "warn");

  /**
   * Cắt khỏi kế hoạch những nhiệm vụ đã đủ lượt hôm nay, và nói ra đã cắt cái gì.
   *
   * Lọc LẠI theo danh sách nhiệm vụ ngày dù server đã lọc trước khi ghi: sổ sống lâu hơn một
   * lần deploy, nên một ID bị rút khỏi `DAILY_QUOTA_QUEST_IDS` phải hết hiệu lực NGAY chứ
   * không đợi tới mốc sang ngày.
   */
  const doneToday = new Set(dailyDone?.questIds ?? []);
  const splitPlanForToday = (plan) => {
    const keep = [];
    const skipped = [];
    for (const quest of plan) {
      (doneToday.has(quest.id) && isDailyQuotaQuest(quest) ? skipped : keep).push(quest);
    }
    return { keep, skipped };
  };

  /** Vòng không còn gì để làm — ngủ tới sau mốc sang ngày thay vì ghé lại mỗi năm phút. */
  const nothingLeftToday = (skipped) => ({
    outcome: "done",
    message:
      `Cả ${skipped.length} nhiệm vụ đều đã đủ lượt hôm nay — vòng này không đụng tới cái nào. ` +
      "Sẽ kiểm lại sau khi sang ngày mới; muốn kiểm ngay thì Thu Đàn rồi Khai Đàn lại.",
    nextDelaySeconds: delayUntilDailyReset(dailyDone?.resetsInSeconds),
    // Không khai gì mới: những cái này đã nằm sẵn trong sổ, và một lượt ghi lặp chỉ tốn một
    // câu UPDATE để viết lại đúng thứ đang có.
    dailyCapQuestIds: [],
  });

  /**
   * KHÔNG mở trình duyệt cho một vòng chẳng có gì để làm — phần tiết kiệm lớn nhất của cả
   * tính năng, vì dựng Chromium và qua cổng Cloudflare đắt hơn mọi nhiệm vụ ngày cộng lại.
   *
   * Chỉ được phép tắt máy sớm khi hạng tài khoản đã được CHỨNG MINH: hạng quyết định kế hoạch
   * (hai bộ flow loại trừ nhau), nên đoán hạng ở đây là có ngày bỏ trắng cả một ngày chạy vì
   * một phỏng đoán. `accountTier` là verdict hub đã dò, server ghép vào snapshot ở mỗi lần
   * phát việc; chưa từng dò được thì nó là null và vòng này cứ mở như thường — phép lọc thật
   * vẫn nằm sau cổng hub, chỗ hạng đã chắc.
   */
  const provenTier =
    config.accountTier === "vip" ? true : config.accountTier === "free" ? false : null;
  if (provenTier !== null) {
    const presumed = questsForAccount(profile, { isVip: provenTier });
    const { keep, skipped } = splitPlanForToday(presumed);
    if (presumed.length > 0 && keep.length === 0) {
      await say(
        `Đã đủ lượt hôm nay cả ${skipped.length} nhiệm vụ (${skipped.map((q) => q.name).join(" · ")}) — ` +
          "vòng này không mở trình duyệt.",
      );
      return nothingLeftToday(skipped);
    }
  }

  // Hồ sơ BỀN trên đĩa khi có chỗ đặt nó (worker truyền vào; smoke và các lượt một-lần thì
  // không). Đây là lớp thứ ba học từ desktop: token cf_clearance mà Cloudflare cấp sau một
  // lần kiểm tra SỐNG TRONG HỒ SƠ — context ẩn danh mở mới mỗi lượt là mỗi lượt lại trình
  // diện trước Cloudflare như người lạ, còn hồ sơ bền thì một lần qua cửa là những lượt sau
  // đi thẳng. Cookie phiên được site làm mới cũng nhờ vậy mà không bị chuỗi dán-tay cũ dần.
  const fingerprint = launchProfile(headless);
  let browser = null;
  let context;
  if (profileDir) {
    context = await chromium.launchPersistentContext(profileDir, fingerprint);
  } else {
    browser = await chromium.launch({
      headless,
      args: fingerprint.args,
      ignoreDefaultArgs: fingerprint.ignoreDefaultArgs,
    });
    context = await browser.newContext({
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      viewport: fingerprint.viewport,
    });
  }

  let done = 0;
  let failed = 0;
  const results = [];

  try {
    // Chỉ tiêm cookie khi hồ sơ CHƯA có phiên đăng nhập — đúng luật của desktop
    // (InjectCookiesIfNeededAsync): site tự làm mới cookie phiên trong hồ sơ bền, và đè
    // chuỗi dán-tay cũ hơn lên trên là tự tay đăng xuất một phiên đang lành lặn.
    const existing = profileDir ? await context.cookies(baseUrl) : [];
    const hasLogin = existing.some((c) => c.name.startsWith("wordpress_logged_in"));
    if (hasLogin) {
      // Chỉ là phỏng đoán ban đầu, KHÔNG phải phán quyết: có cookie đăng nhập không có
      // nghĩa là nó còn sống. `ensureReady` sẽ hỏi thẳng trang, và tự tiêm lại chuỗi đã lưu
      // nếu hồ sơ hoá ra đang ôm một cái xác.
      log.debug("Trình duyệt", "Hồ sơ đã có phiên đăng nhập — thử dùng lại trước.");
    } else {
      await context.addCookies(cookieJar);
    }

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    // TRƯỚC mọi lượt điều hướng, bằng không lượt tải đầu tiên đã kịp khai「HeadlessChrome」với
    // Cloudflare — và lượt tải đầu tiên chính là lượt bị soi kỹ nhất.
    const identity = await wearRealBrowserIdentity(context, page, log);
    if (identity.ok) {
      log.debug("Trình duyệt", `Danh tính trình duyệt: ${identity.detail}.`);
    } else {
      log.warning(
        "Trình duyệt",
        `Không đè được client hints (${identity.detail}) — trình duyệt sẽ tự xưng HeadlessChrome, ` +
          "dễ bị Cloudflare chặn hơn. Lượt chạy vẫn tiếp tục.",
      );
    }

    const session = createSession(page, {
      baseUrl,
      log: {
        info: (m) => log.info("Trình duyệt", m),
        warning: (m) => log.warning("Trình duyệt", m),
        debug: (m) => log.debug("Trình duyệt", m),
      },
    });

    // Cổng sẵn sàng TRƯỚC mọi quest: bị Cloudflare chặn hay hết phiên đăng nhập phải được
    // gọi đúng tên ở đây, không phải chết ở selector đầu tiên của một quest vô tội. Đưa cả
    // context và cookieJar vào để nó tự chữa được một hồ sơ mang cookie đã chết.
    const ready = await ensureReady(session, baseUrl, say, log, { context, cookieJar });
    if (!ready.ok) {
      return scheduledCycleResult("failed", ready.message);
    }

    // Hạng tài khoản quyết định kế hoạch, nên đọc nó TRƯỚC khi hứa hẹn gì. Ghé hub một lần —
    // trang duy nhất mang tín hiệu — và poll thay vì đọc một phát: hub render làm hai đợt,
    // probe tự trả null chừng nào chưa chứng minh được sự vắng mặt (xem vipProbe). Mọi ngả
    // thất bại giữ bằng chứng của cookie này từ vòng trước; cookie chưa từng được dò mới
    // mặc định VIP để tương thích với hồ sơ cũ.
    let isVip = config?.accountTier !== "free";
    // Hub có DỰNG NỔI bảng nhiệm vụ không — hỏi tiện thể trong đúng vòng poll dò hạng, vì
    // `vipProbe` chỉ trả boolean khi `.nv-quest` đã có mặt. Trước đây vòng lặp này hết giờ
    // trong im lặng: nó vừa bỏ ra 20 giây CHỨNG MINH hub không dựng, rồi không nói với ai.
    let hubRendered = false;
    const nav = await session.navigate(session.resolveUrl(profile.dailyQuestPath));
    if (nav.ok) {
      const probeDeadline = Date.now() + 20_000;
      while (Date.now() < probeDeadline) {
        const verdict = await session.evaluate(vipProbe);
        if (typeof verdict === "boolean") {
          hubRendered = true;
          isVip = verdict;
          await reportAccountTier(verdict ? "vip" : "free");
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } else {
      await say(
        `Không mở được hub để xem hạng tài khoản (${nav.error}) — giữ hạng ${isVip ? "VIP" : "thường"} đã biết.`,
        "warn",
      );
    }

    // Hai nhân chứng cùng câm thì DỪNG, đừng đoán. Cổng sẵn sàng không tìm thấy dấu đăng
    // nhập nào, và hub cũng không dựng nổi bảng nhiệm vụ — cộng lại nghĩa là thứ đang mở
    // không phải trang game của một thành viên đã đăng nhập. Chạy tiếp là đốt 25 giây mỗi
    // nhiệm vụ để rồi kể một câu chuyện sai về selector, đúng như đêm 07/08.
    //
    // Phải là PHÉP HỘI của hai điều kiện, không phải phép tuyển: hub không dựng mà phiên
    // vẫn xác nhận được thì đó là site trở chứng chứ không phải chuyện đăng nhập, và các
    // nhiệm vụ có trang riêng vẫn có thể chạy ngon — cắt vòng lúc ấy là phá hoại.
    if (!hubRendered && !ready.loginConfirmed) {
      return scheduledCycleResult(
        "failed",
        ready.movedTo
          ? `Site đã dời tên miền: ${baseUrl} chuyển hướng sang ${ready.movedTo}. Cookie gắn theo ` +
            "tên miền nên KHÔNG đi theo — trang mới nhìn khôi lỗi như khách lạ. Cần cập nhật tên " +
            "miền game rồi dán lại chuỗi cookie lấy từ tên miền mới ở Ngọc Giản Cấu Hình."
          : "Không xác nhận được phiên đăng nhập, và hub cũng không dựng nổi bảng nhiệm vụ — " +
            "nhiều khả năng cookie đã hết hạn hoặc site đang chắn khôi lỗi. Dán chuỗi cookie mới ở " +
            "Ngọc Giản Cấu Hình; lượt sau khôi lỗi vẫn sẽ tự thử lại.",
      );
    }

    if (!ready.loginConfirmed) {
      // Hub dựng được = thành viên đã đăng nhập, vì bảng nhiệm vụ không bao giờ hiện cho
      // khách. Giờ mới được phép nói câu này — và nó là câu THẬT.
      await say("Đã vào được trang game — phiên đăng nhập còn hiệu lực.", "success");
    } else if (!hubRendered) {
      await say(
        "Hub không dựng xong bảng nhiệm vụ trong 20 giây — phiên đăng nhập vẫn còn, nên cứ đi " +
          "tiếp; nhiệm vụ nào có trang riêng thì không phụ thuộc hub.",
        "warn",
      );
    }

    const tierPlan = questsForAccount(profile, { isVip });
    const leftOut = enabled.length - tierPlan.length;

    if (!isVip) {
      await say(
        leftOut > 0
          ? `Tài khoản thường — để yên ${leftOut} flow VIP; dùng các flow riêng ở tab cùng tên.`
          : "Tài khoản thường.",
      );
    }

    if (tierPlan.length === 0) {
      return scheduledCycleResult(
        "done",
        "Không có nhiệm vụ nào được bật cho hạng tài khoản này — vòng này chưa có gì để chạy.",
      );
    }

    // Sổ đủ lượt cắt lần thứ hai. Nhánh tắt máy sớm phía trên chạy trên hạng ĐÃ BIẾT từ trước;
    // đây là hạng hub vừa chứng minh, và nó mới là hạng có thẩm quyền. Cùng một luật, hai chỗ
    // áp, vì phần thưởng của mỗi chỗ khác nhau: chỗ kia tiết kiệm cả một trình duyệt, chỗ này
    // tiết kiệm từng trang nhiệm vụ.
    const { keep: quests, skipped: skippedToday } = splitPlanForToday(tierPlan);
    if (skippedToday.length > 0) {
      await say(
        `Bỏ qua ${skippedToday.length} nhiệm vụ đã đủ lượt hôm nay: ` +
          `${skippedToday.map((q) => q.name).join(" · ")}.`,
      );
    }

    if (quests.length === 0) {
      return nothingLeftToday(skippedToday);
    }

    /**
     * Nhiệm vụ nào VỪA khai là đã đủ lượt hôm nay — server nhận ở cuối vòng rồi ghi vào sổ, để
     * vòng sau khỏi mở trang của chúng. Chỉ chứa cái quan sát được TRONG vòng này; những cái
     * đã nằm sẵn trong sổ không lặp lại, vì server hợp nhất chứ không ghi đè.
     */
    const cappedToday = [];

    await say(`Sẽ hành sự: ${quests.map((q) => q.name).join(" · ")}.`);

    // Tiến độ vòng này, cho Hàng Đợi Công Việc. `runningNow` là SỐ NHIỀU vì nhánh song song
    // có thể cầm tới ba nhiệm vụ cùng lúc — báo cáo một cái là nói dối về hai cái kia.
    //
    // `finished` đếm nhiệm vụ đã RỜI TAY, thuận hay trắc trở đều tính: câu hỏi trên màn hình
    // là "còn bao nhiêu nữa", không phải "bao nhiêu cái thành công" (dòng kết quả cuối vòng
    // mới là chỗ trả lời câu đó). Nó phải là biến riêng chứ không tái dùng `done`/`failed`:
    // hai biến ấy chỉ được cộng SAU khi cả nhóm song song đã xong, nên chúng đứng im suốt
    // quãng người dùng thật sự cần nhìn.
    // Khoá theo ID chứ không theo TÊN, dù thứ hiện ra màn hình là tên: tên nhiệm vụ không
    // hứa hẹn là duy nhất — cặp twin VIP/thường trong hồ sơ CỐ Ý trùng tên nhau. Hôm nay
    // `questsForAccount` lọc theo hạng nên mỗi vòng chỉ còn một bản, nhưng một Set khoá theo
    // tên đặt cược cả tính đúng đắn vào phép lọc ấy: ngày nào hai nhiệm vụ cùng tên cùng
    // hạng gặp nhau, cái xong trước sẽ xoá tên của cái đang chạy. ID là khoá chính của hồ sơ.
    const runningNow = new Map();
    let finished = 0;
    const publishProgress = () =>
      reportProgress({ running: [...runningNow.values()], done: finished, total: quests.length });

    // Phát ngay một lần: từ đây tới lúc nhiệm vụ đầu tiên vào tay còn cả quãng mở tab và
    // dựng trang, và trong quãng đó hàng đợi nên nói "0/8" thay vì không nói gì.
    publishProgress();

    const quiz = createReferenceQuiz({
      url: process.env.QUIZ_DIRECTORY_URL?.trim() || DEFAULT_QUIZ_REFERENCE_URL,
      log,
    });

    // MỘT nhịp hành sự: tuần tự, mỗi nhiệm vụ một lượt, theo đúng thứ tự hồ sơ.
    //
    // Nhánh song song (mỗi nhiệm vụ một tab) đã bị gỡ ngày 12/08/2026 theo chỉ đạo. Nó rút
    // ngắn vòng chạy, nhưng đổi lại thứ tự hành sự trở thành thứ tự GIÀNH ĐƯỢC CỔNG chứ không
    // phải thứ tự trong hồ sơ — và tông môn cần điều ngược lại: Mê Cung (tới 35 phút, giữ một
    // phòng 5 người) phải là nhiệm vụ CUỐI CÙNG, Luyện Đan Đường áp chót, để chúng không giam
    // tài nguyên của những nhiệm vụ một phút đứng sau. Chạy tuần tự thì thứ tự ấy là hệ quả
    // trực tiếp của `order` trong hồ sơ, không cần thêm cơ chế nào canh giữ.
    //
    // Cổng điều phối toàn cục VẪN còn và vẫn cần: một VM chạy nhiều đàn cùng lúc, nên hai
    // nhiệm vụ trang riêng của HAI đàn khác nhau vẫn có thể dẫm chân nhau trên cùng hai nhân.
    {
      const engine = createQuestEngine({ log, shouldStop, quiz });

      for (const quest of quests) {
        if (shouldStop()) {
          return { outcome: "stopped", message: `Đã thu đàn giữa chừng — xong ${done}/${quests.length}.` };
        }

        if (Date.now() >= deadline) {
          return {
            ...scheduledCycleResult(
              "done",
              `Hết ngân sách của lát này — xong ${done}/${quests.length}, phần còn lại để vòng sau.`,
              results,
            ),
            dailyCapQuestIds: cappedToday,
          };
        }

        // Tuần tự trong đàn NÀY không có nghĩa là một mình trên máy: các đàn khác của cùng
        // khôi lỗi vẫn chạy cạnh bên, nên nhánh này cũng phải qua cổng toàn cục như ai.
        const slot = await acquireQuestSlot({
          dedicated: isDedicatedPageQuest(profile, quest),
          name: quest.name,
          shouldStop,
          onWait: ({ holder }) =>
            log.debug(
              `Quest:${quest.name}`,
              holder
                ? `nhường tài nguyên cho「${holder}」đang giữ trang riêng — xếp hàng chờ lượt.`
                : "xếp hàng ở cổng điều phối — một nhiệm vụ trang riêng đang đợi phía trước.",
            ),
        });
        if (slot.aborted) {
          return { outcome: "stopped", message: `Đã thu đàn giữa chừng — xong ${done}/${quests.length}.` };
        }

        runningNow.set(quest.id, quest.name);
        publishProgress();

        let outcome;
        try {
          outcome = await engine.run(session, profile, quest);
        } catch (err) {
          if (err instanceof QuestAborted) {
            return { outcome: "stopped", message: `Đã thu đàn giữa chừng — xong ${done}/${quests.length}.` };
          }
          throw err;
        } finally {
          slot.release();
          // Rời tay ở mọi ngả. Hai ngả bất thường (Thu Đàn, lỗi ném ra) đều kết thúc cả vòng
          // ngay sau đây, nên `finished` chỉ cộng trên đường đi bình thường bên dưới.
          runningNow.delete(quest.id);
        }

        finished++;
        publishProgress();

        results.push(outcome);
        // `peersDone` chỉ đổi số phận của Vòng Quay Phúc Vận (xem `PEER_GATED_QUEST_IDS`): lượt
        // thứ 4 của nó chỉ mở sau khi các nhiệm vụ ngày khác xong, nên「hết lượt」nghe được TRƯỚC
        // lúc ấy là lời khai đúng về hiện tại và sai về cả ngày. Tính ngay tại đây, không cầm
        // sẵn từ đầu vòng: `cappedToday` mọc dần trong lúc vòng chạy.
        const peersDone = peersDoneForQuota(quest, quests, cappedToday);
        if (reachedDailyQuota(quest, outcome, { peersDone })) cappedToday.push(quest.id);

        /**
         * DẤU NGÀY của nhiệm vụ vừa chạy — đi CHUNG một sổ với「đã đủ lượt hôm nay」, vì
         * chúng là cùng một loại sự thật: một việc của hôm nay, của đàn này, đã xong.
         *
         * Khác nhau ở phạm vi, và đó là lý do khoá phải mang tiền tố không thể trùng một
         * ID nhiệm vụ: `cappedToday` khoá cả NHIỆM VỤ khỏi vòng sau, còn một dấu chỉ khoá
         * một VIỆC BÊN TRONG nhiệm vụ (mua phù) — nhiệm vụ vẫn phải chạy để đào tiếp.
         * `splitPlanForToday` lọc lại bằng `isDailyQuotaQuest` nên một dấu không bao giờ
         * cắt nhầm nhiệm vụ nào.
         */
        for (const mark of outcome.dailyMarks ?? []) {
          if (!cappedToday.includes(mark)) cappedToday.push(mark);
        }

        const shape = OUTCOME_TEXT[outcome.outcome] ?? OUTCOME_TEXT.skipped;
        await say(`${quest.name}: ${shape.say(outcome)}`, shape.level);

        if (outcome.outcome === "failed") failed++;
        else done++;
      }
    }

    if (cappedToday.length > 0) {
      await say(
        `Đã đủ lượt hôm nay: ${quests
          .filter((quest) => cappedToday.includes(quest.id))
          .map((quest) => quest.name)
          .join(" · ")} — từ vòng sau khôi lỗi không mở lại trang của chúng nữa.`,
      );
    }

    return {
      ...(failed > 0
        ? scheduledCycleResult("done", `Đi hết một vòng — ${done} thuận, ${failed} trắc trở.`, results)
        : scheduledCycleResult("done", `Đi hết một vòng — ${done} nhiệm vụ thuận lợi.`, results)),
      dailyCapQuestIds: cappedToday,
    };
  } finally {
    // Đóng trong finally, có HẠN GIỜ, và không bao giờ ném: một trình duyệt không đóng được
    // không được phép ghi đè lên kết quả thật của lượt chạy — mà cũng không được phép treo
    // luôn cả cái ghế của worker. Xem browserShutdown.mjs cho lý do đầy đủ.
    await closeBrowserWithin({ context, browser, profileDir, log });
  }
}
