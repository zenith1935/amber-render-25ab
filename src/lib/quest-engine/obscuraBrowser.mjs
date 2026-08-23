/**
 * OBSCURA — trình duyệt thứ hai mà khôi lỗi được phép dùng, chọn bằng một ô trong trang Tông Môn.
 *
 * Obscura (github.com/h4ckf0r0day/obscura, Apache-2.0) là một trình duyệt headless viết bằng Rust:
 * V8 thật, CDP thật, và một bản dựng `-stealth` mang dấu tay TLS/fingerprint nhất quán. Nó KHÔNG
 * phải một bản Chromium vá lại — nên nó không mang theo cái tật đã hành hạ tông môn suốt tuần
 * 20/08: Chromium tự khai「HeadlessChrome」trong client hints, và `chrome-headless-shell` thì bị
 * Cloudflare chặn thẳng (xem khối PREFERRED_CHANNEL trong runCycle.mjs).
 *
 * ĐÃ ĐO TRÊN TRANG GAME THẬT trước khi viết một dòng nào của tệp này (23/08/2026, VM aarch64,
 * cookie thật của Gia chủ, luôn kèm ca đối chứng Chromium):
 *
 *   trang                obscura                     Chromium
 *   /                    200 · html 84.172 · login ✓ 200 · html 84.216 · login ✓
 *   /nhiem-vu-hang-ngay  200 · html 163.871 · ✓      200 · html 165.137 · ✓
 *   /diem-danh           200 · html 137.215 · ✓      200 · html 130.889 · ✓
 *
 * Không trang nào bị Cloudflare chặn, và `Browser.getVersion` của nó trả `Chrome/145.0.0.0` —
 * đúng dạng `wearRealBrowserIdentity` cần, nên phép đè client hints chạy nguyên si, không phải
 * rẽ nhánh. Đây là lý do tệp này KHÔNG đụng vào engine: nó chỉ dựng ra một `context` rồi trao
 * lại, mọi thứ phía sau y hệt đường Chromium.
 *
 * ── VÌ SAO MỖI ĐÀN MỘT TIẾN TRÌNH ─────────────────────────────────────────────────────────
 *
 * Tài liệu obscura nói thẳng: mọi phiên CDP nối vào MỘT `serve` đều đọc-ghi CHUNG một
 * `--storage-dir`. Mà tông môn chạy tới hai đàn song song trong một tiến trình khôi lỗi, mỗi đàn
 * một tài khoản game khác nhau — dùng chung kho cookie là hai tài khoản đăng nhập đè lên nhau,
 * thứ hỏng im lặng và chỉ lộ ra dưới dạng「tự nhiên tài khoản kia bị đăng xuất」.
 *
 * Nên: một đàn = một tiến trình `obscura serve` = một cổng = một `--storage-dir` riêng, đặt ngay
 * TRONG thư mục hồ sơ mà `profileDirForJob` đã cấp cho đàn ấy. Cách ly y hệt Chromium, và cái giá
 * là một tiến trình cho mỗi đàn — trần 2 đàn nên trần cũng chỉ hai.
 *
 * ── VÌ SAO KHÔNG TỰ TẢI BINARY ────────────────────────────────────────────────────────────
 *
 * Gói release nặng 43–86 MB. Tải nó GIỮA một vòng chạy là bắt một đàn đứng chờ mạng, và tệ hơn:
 * lượt tải hỏng giữa chừng để lại một tệp cụt mà lượt sau vẫn tưởng là binary. Việc cài đặt thuộc
 * về lúc DỰNG MÁY — workflow của khôi lỗi tông môn và bộ cài máy nhà lo — còn tệp này chỉ đi TÌM.
 * Không thấy thì nói ra và trả `null`, để nơi gọi lui về Chromium: một lựa chọn cấu hình không
 * bao giờ được phép biến thành một vòng chạy chết.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Tên trình duyệt, hiện trong nhật ký khôi lỗi (`opened.via`). */
export const OBSCURA_LABEL = "Obscura";

/** Chờ `serve` mở cổng tối đa ngần này rồi coi như hỏng. Bản stealth khởi động ~1s trên VM ARM. */
export const OBSCURA_READY_TIMEOUT_MS = 25_000;

/** Nhịp hỏi cổng trong lúc chờ. */
const READY_POLL_MS = 250;

/** Chờ tiến trình tự đóng sau SIGTERM trước khi cắt cứng — xem `disposeChild`. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Hạn cho cú `browser.close()` lúc dọn.
 *
 * Cùng bài học với `browserShutdown.mjs`: một lời hứa KHÔNG BAO GIỜ ngã ngũ giam luôn cái ghế của
 * khôi lỗi, và đủ `WORKER_MAX_JOBS` lần là nó tê liệt trong im lặng. Ở đây ta còn ở thế tốt hơn
 * bên Chromium — PID nằm sẵn trong tay, nên hết hạn thì cứ hạ tiến trình, khỏi phải dò `/proc`.
 */
const CLOSE_TIMEOUT_MS = 8_000;

/**
 * Tên tệp release ứng với máy đang chạy.
 *
 * Bốn biến thể mỗi nền tảng (có/không render × có/không stealth); ta luôn lấy bản ĐỦ RENDER kèm
 * STEALTH: trang game là WordPress + JS nặng nên bản `-no-render` vô dụng, còn `-stealth` chính
 * là lý do người ta chọn obscura thay Chromium.
 *
 * Hàm THUẦN để `verify:obscura` đóng đinh được từng nền tảng mà không cần máy thật — nhất là cái
 * bẫy đã trả giá ngay trong lượt đo đầu tiên: VM của tông môn là **aarch64** (Oracle Ampere) còn
 * runner GitHub là x86_64, nên một danh sách gõ cứng theo「linux」là tải về một binary không
 * chạy nổi, báo lỗi `Exec format error` giữa vòng chạy.
 */
export function obscuraReleaseAsset(platform, arch) {
  const cpu = arch === "arm64" || arch === "aarch64" ? "aarch64" : "x86_64";
  if (platform === "win32") {
    // Windows chỉ có bản x86_64; máy nhà đạo hữu đều thuộc loại này.
    return "obscura-x86_64-windows-stealth.zip";
  }
  if (platform === "darwin") return `obscura-${cpu}-macos-stealth.tar.gz`;
  return `obscura-${cpu}-linux-stealth.tar.gz`;
}

/** Tên tệp thực thi theo nền tảng. */
export function obscuraExecutableName(platform) {
  return platform === "win32" ? "obscura.exe" : "obscura";
}

/**
 * Những chỗ đi tìm binary, THEO THỨ TỰ.
 *
 * `OBSCURA_BIN` đứng đầu vì nó là phủ quyết của người vận hành máy ấy — cùng lẽ với mọi biến
 * môi trường khác của khôi lỗi. Rồi tới hai chỗ mà bộ cài đặt đặt nó vào: cạnh chính gói khôi lỗi
 * (gói phẳng, `worker.mjs` nằm cùng thư mục) và thư mục `bin/` của cây mã nguồn. Cuối cùng mới
 * tới tên trần, để `PATH` của hệ thống lo — ai đã `apt install`/`brew install` thì khỏi khai gì.
 *
 * Hàm THUẦN: nhận sẵn `env`, `platform`, và thư mục của chính module, nên lưới kiểm dựng được
 * mọi tình huống mà không đụng đĩa.
 */
export function obscuraBinaryCandidates({ env = {}, platform = process.platform, moduleDir }) {
  const exe = obscuraExecutableName(platform);
  const out = [];
  const declared = String(env.OBSCURA_BIN ?? "").trim();
  if (declared) out.push(declared);

  // Gói khôi lỗi giải nén PHẲNG: `worker.mjs` + `quest-engine/` cạnh nhau, nên thư mục cha của
  // module này chính là gốc gói — đúng chỗ bộ cài đặt thả binary vào.
  const bundleRoot = path.resolve(moduleDir, "..");
  out.push(path.join(bundleRoot, exe));
  out.push(path.join(bundleRoot, "obscura", exe));

  // Cây mã nguồn: `src/lib/quest-engine/` → lùi ba nấc là gốc repo.
  const repoRoot = path.resolve(moduleDir, "..", "..", "..");
  out.push(path.join(repoRoot, "bin", exe));

  out.push(exe); // để PATH lo
  return out;
}

/** Tệp có tồn tại và chạy được không. Tên trần (không có dấu phân cách) thì để PATH phân xử. */
function isRunnable(candidate, platform) {
  const bare = !candidate.includes("/") && !candidate.includes("\\");
  if (bare) return true;
  try {
    // X_OK trên Windows luôn đúng với tệp đọc được — đó là hành vi của Node, không phải sơ suất.
    accessSync(candidate, platform === "win32" ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Binary đầu tiên dùng được, hoặc `null`.
 *
 * `spawnSync(bin, ["--version"])` là phép thử cuối và là phép thử THẬT: một tệp đúng tên, đúng
 * quyền, mà sai kiến trúc CPU vẫn nằm im ở đó cho tới lúc chạy mới nổ (`Exec format error`).
 * Hỏi nó một câu rẻ ngay bây giờ thì lượt chạy khỏi phải chết để biết.
 */
export function resolveObscuraBinary({ env = process.env, platform = process.platform, moduleDir } = {}) {
  const dir = moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of obscuraBinaryCandidates({ env, platform, moduleDir: dir })) {
    if (!isRunnable(candidate, platform)) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error || probe.status !== 0) continue;
    const version = String(probe.stdout ?? "").trim().split(/\s+/).pop() ?? "";
    return { bin: candidate, version };
  }
  return null;
}

/** Binary này có bản dựng stealth không — hỏi chính nó, đừng suy từ tên tệp. */
export function obscuraSupportsStealth(bin) {
  const help = spawnSync(bin, ["serve", "--help"], { encoding: "utf8", timeout: 10_000 });
  if (help.error || help.status !== 0) return false;
  return `${help.stdout ?? ""}${help.stderr ?? ""}`.includes("--stealth");
}

/**
 * Đối số cho `obscura serve`. Hàm THUẦN — lưới kiểm đọc thẳng, khỏi phải chạy tiến trình nào.
 *
 * `--host` để nguyên mặc định `127.0.0.1`: cổng CDP là quyền điều khiển trình duyệt vô điều kiện,
 * mở nó ra mạng là mở cả kho cookie của tông môn cho bất kỳ ai gõ đúng cổng.
 */
export function buildObscuraServeArgs({ port, storageDir, userAgent, stealth }) {
  const args = ["serve", "--port", String(port), "--storage-dir", storageDir];
  if (stealth) args.push("--stealth");
  // UA đặt ngay từ lúc khởi động, TRƯỚC cả phép đè client hints qua CDP: request đầu tiên của
  // một phiên là request bị soi kỹ nhất, mà phép đè kia chỉ kịp chạy sau khi trang đầu đã mở.
  if (userAgent) args.push("--user-agent", userAgent);
  return args;
}

/** Một cổng đang rảnh trên loopback, do chính hệ điều hành chọn. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Những tiến trình obscura lượt chạy này đang giữ.
 *
 * Có sổ này vì `dispose()` chỉ chạy khi vòng chạy đi tới `finally` — còn một cú `SIGTERM` vào
 * chính khôi lỗi (Actions hết giờ, systemd restart, Ctrl-C) thì không ai gọi nó, và mỗi lần như
 * vậy là một tiến trình obscura ở lại giữ cổng cho tới khi máy tắt.
 */
const liveChildren = new Set();
let reaperInstalled = false;

function installReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const reap = () => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Tiến trình đã đi rồi thì thôi — đây là lượt dọn cuối, không phải chỗ để ném.
      }
    }
    liveChildren.clear();
  };
  process.once("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      reap();
      // Không tự thoát: khôi lỗi có lễ thu đàn riêng của nó (`beginDrain`), cắt ngang ở đây là
      // giết những đàn đang chạy dở — đúng thứ lễ ấy sinh ra để tránh.
    });
  }
}

/** Đóng tiến trình cho SẠCH: SIGTERM trước, chờ, rồi mới cắt cứng. */
async function disposeChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  // SIGTERM chứ KHÔNG SIGKILL: obscura ghi cookie + localStorage xuống `--storage-dir` lúc thoát
  // sạch. Cắt cứng ngay là vứt cf_clearance vừa lấy được, và vòng sau lại phải qua cửa Cloudflare
  // từ đầu — đúng thứ hồ sơ bền sinh ra để tránh.
  const ended = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill("SIGTERM");
  } catch {
    liveChildren.delete(child);
    return;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
  });
  const raced = await Promise.race([ended.then(() => "exit"), timeout.then(() => "timeout")]);
  clearTimeout(timer);
  if (raced === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // Đã chết giữa hai lượt kiểm — không sao.
    }
  }
  liveChildren.delete(child);
}

/** Cổng đã trả lời `/json/version` chưa. Dùng chính HTTP của CDP, không đoán theo dòng log. */
async function waitForCdp(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`tiến trình obscura thoát sớm (mã ${child.exitCode ?? child.signalCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // Chưa lên — đó là trạng thái BÌNH THƯỜNG của vòng chờ này, không phải sự cố.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`obscura không mở cổng ${port} sau ${Math.round(timeoutMs / 1000)} giây`);
}

/**
 * Đã kêu「máy này chưa có obscura」lần nào trong tiến trình này chưa.
 *
 * Có cờ này vì cái ồn: một khôi lỗi tông môn chạy hai đàn, mỗi đàn nhiều vòng mỗi giờ. Nếu mỗi
 * vòng đều đẩy một dòng cảnh báo lên Hoạt động thì Gia chủ vừa bật obscura là cả tông môn ngập
 * cảnh báo — đúng cái bẫy「info ồn」mà nhật ký hai tầng sinh ra để tránh. Nói MỘT lần cho mỗi
 * tiến trình là đủ để người ta biết mà đi cài; những lần sau đã có nhật ký tầng khôi lỗi.
 */
let announcedMissing = false;

/** Trả `true` đúng MỘT lần cho mỗi tiến trình khôi lỗi — xem `announcedMissing`. */
export function shouldAnnounceObscuraMissing() {
  if (announcedMissing) return false;
  announcedMissing = true;
  return true;
}

/** Chỉ dùng cho lưới kiểm: trả cờ ấy về trắng giữa hai kịch bản. */
export function _resetObscuraAnnounce() {
  announcedMissing = false;
}

/**
 * Mở một trình duyệt Obscura và trao lại `context` y như đường Chromium.
 *
 * Trả `null` khi máy này KHÔNG có obscura — đó là câu trả lời hợp lệ, không phải lỗi: nơi gọi lui
 * về Chromium. Còn khi có binary mà dựng hỏng thì NÉM, kèm lý do đọc được — im lặng nuốt một cái
 * hỏng ở tầng này là để người ta ngồi đoán vì sao lựa chọn trong trang Tông Môn không có hiệu lực.
 *
 * @param {object} input
 * @param {import("playwright-core").BrowserType} input.chromium
 * @param {string} input.storageDir  thư mục cookie/localStorage RIÊNG của đàn này
 * @param {string} [input.userAgent] UA khai từ request đầu tiên
 * @param {{width:number,height:number}} [input.viewport]
 * @param {{debug:(scope:string,msg:string)=>void}} [input.log]
 */
export async function openObscuraBrowser({ chromium, storageDir, userAgent, viewport, log }) {
  const found = resolveObscuraBinary();
  if (!found) return null;

  mkdirSync(storageDir, { recursive: true });
  const stealth = obscuraSupportsStealth(found.bin);
  const port = await pickFreePort();
  const args = buildObscuraServeArgs({ port, storageDir, userAgent, stealth });

  log?.debug?.(
    "Trình duyệt",
    `Obscura ${found.version || "(không rõ bản)"} tại ${found.bin} — cổng ${port}` +
      `${stealth ? ", chế độ stealth" : ", KHÔNG có stealth (bản dựng thiếu cờ)"}.`,
  );

  const child = spawn(found.bin, args, { stdio: "ignore", windowsHide: true });
  liveChildren.add(child);
  installReaper();

  // Một tiến trình con không ai nghe `error` sẽ ném ra ngoài mọi try/catch và giết cả khôi lỗi.
  child.on("error", () => {});

  try {
    await waitForCdp(port, child, OBSCURA_READY_TIMEOUT_MS);
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}`);
    // Context SẴN CÓ, không phải context mới: `--storage-dir` gắn với context đầu tiên, nên mở
    // context mới là vứt đúng cái kho cookie vừa dựng ra để dùng.
    const context = browser.contexts()[0] ?? (await browser.newContext());
    if (viewport) {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize(viewport);
    }
    return {
      browser,
      context,
      via: `${OBSCURA_LABEL}${stealth ? " (stealth)" : ""}`,
      dispose: async () => {
        // Đóng cho lịch sự TRONG HẠN: `browser.close()` chỉ cắt kết nối CDP — theo tài liệu
        // obscura, `serve` vẫn sống tiếp — nên nó là bước phụ, còn bước thật là hạ tiến trình
        // ngay dưới. Treo ở bước phụ không được phép giữ chân bước thật.
        await Promise.race([
          browser.close().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
        ]);
        await disposeChild(child);
      },
    };
  } catch (err) {
    await disposeChild(child);
    throw new Error(`không mở được Obscura: ${err instanceof Error ? err.message : String(err)}`);
  }
}
