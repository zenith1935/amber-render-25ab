/**
 * Bộ thông dịch nhiệm vụ — bản JS của `QuestEngine.cs`.
 *
 * Đây là NƠI DUY NHẤT biết một nhiệm vụ được "thực hiện" ra sao, nên thêm nhiệm vụ mới là
 * thuần dữ liệu, không phải thêm code. Hồ sơ quest (`quests.json`, schema 41) đi thẳng từ
 * bản desktop sang đây mà không cần dịch: cả hai bản cùng đọc một tệp, nên tri thức về site
 * chỉ có một bản gốc và không thể trôi lệch giữa hai nơi.
 *
 * Những chỗ tinh tế đã trả giá mới biết, giữ nguyên ngữ nghĩa của bản desktop:
 *
 *  • Option giải SỐNG tại từng bước, không nướng sẵn đầu lượt. Bản đầu nướng sẵn cho gọn, và
 *    đó là lý do một người xem lượt Mê Cung hai tiếng đổi ngưỡng trục xuất, tab Nhiệm vụ ghi
 *    nhận giá trị mới, còn script đang chạy vẫn trục xuất theo giá trị cũ tới ~95 phút.
 *  • Bản sao để thực thi là NÔNG có chủ ý: `steps` và `until` giữ nguyên tham chiếu gốc, để
 *    thân vòng lặp giải lại mỗi vòng và điều kiện thoát giải lại mỗi lần kiểm.
 *  • `when` là guard kiểm TRƯỚC khi bước chạy — khác hẳn `optional` (vẫn LÀM rồi mới tha
 *    lỗi) và khác hẳn việc gấp trạng thái vào selector (`#btn-start.ready-glow`), thứ khiến
 *    bước lặng lẽ không bao giờ với tới được ngay khi marker biến mất.
 */

import {
  conditionProbe,
  conditionWaitSource,
  guideProbe,
  labelMatchSweep,
  menuProbe,
  quizCorrectAnswer,
  quizProbe,
  selectorPresence,
} from "./boardScripts.mjs";

/** Lồng một repeat trong một repeat là hợp lệ; sâu hơn là lỗi cấu hình. */
const MAX_REPEAT_DEPTH = 2;

/**
 * Một script hỏng vì TRANG CHƯA DỰNG XONG được chạy lại từ đầu, tối đa bấy nhiêu lượt.
 *
 * Vì sao chạy lại CẢ nhiệm vụ chứ không chỉ bước hỏng: bước hỏng thường đứng sau một trạng
 * thái do các bước trước dựng nên. Ca 07/08 là ví dụ đúng nhất — Hỷ Sự Đường trượt
 * `#blessing-default-options`, mà phần tử ấy nằm trong MODAL vừa được bước liền trước mở ra.
 * Tải lại trang rồi thử lại đúng bước ấy là thử lại trong một thế giới mà modal đã biến mất:
 * hỏng chắc chắn, ba lần liền, tốn thêm ba lần thời gian chờ.
 *
 * Chạy lại từ bước 0 thì an toàn vì MỌI nhiệm vụ customSteps trong hồ sơ đều mở màn bằng
 * `navigate` tới trang của chính nó — nên "chạy lại nhiệm vụ" ĐÃ LÀ "tải lại trang", cộng
 * thêm việc dựng lại đủ trạng thái mà bước hỏng cần. Phần việc đã làm xong ở lượt trước
 * không bị làm lại: các script tự phát hiện bằng `stopIf`/`until` và bằng trạng thái site
 * giữ phía server (Hỷ Sự Đường thấy "Đã chúc", Hoang Vực thấy đồng hồ cooldown).
 */
const MAX_PAGE_RENDER_ATTEMPTS = 3;

/**
 * DẤU NGÀY — kênh thứ ba của một script, bên cạnh tường thuật (`!`) và số liệu (không dấu).
 *
 * Một dòng `@khoá` nghĩa là「việc mang tên KHOÁ này đã làm xong hôm nay cho đàn này」. Engine
 * gom các khoá ấy lên tới `runCycle`, khôi lỗi gửi về cùng lời khai cuối vòng, và server ghi
 * vào `automation_jobs.daily_done` — nên dấu sống qua CẢ việc đàn nhảy sang khôi lỗi khác.
 *
 * Vì sao phải là một kênh riêng thay vì dò chữ trong câu tường thuật: sổ ngày là thứ quyết
 * định tiêu tiền thật (Linh Quang Phù), và một phép dò chữ sẽ chết lặng vào ngày ai đó sửa
 * lời văn của script — đúng lập luận đã viết cho `dailyCapReached` ở nhánh `stopIf`.
 *
 * Cố ý CHỈ MỘT ký tự và không có cú pháp nào khác: mọi engine đời cũ (bản desktop, khôi lỗi
 * GitHub chưa cập nhật) đọc dòng ấy như một dòng số liệu và ghi nó vào Debug — không hiểu thì
 * cũng không hỏng.
 */
const MARK_PREFIX = "@";

/**
 * Một `stopIf` dạng VẮNG MẶT được cho bao lâu để trang chứng minh nó chỉ đang vẽ chậm.
 *
 * Chỉ tiêu tốn khi selector KHÔNG khớp phần tử nào — tức đúng những lúc câu trả lời còn mơ
 * hồ. Nút đã có mặt mà đang ẩn thì trang đã trả lời rồi, và lượt dừng đi thẳng như trước.
 * Tám giây phủ trọn đợt vẽ thứ hai đo được (2–4 giây, dài hơn khi ba tab cùng dựng trang),
 * mà vẫn là một con số hữu hạn cho ngày trang thật sự bỏ hẳn một control.
 */
const STOP_CONFIRM_MS = 8000;

/**
 * Ngân sách theo dõi dấu "đáp án đúng", và nhịp nhìn lại.
 *
 * Phải POLL chứ không ngủ một phát: dấu ấy chóng tàn — site thay cả câu hỏi một nhịp sau khi
 * trả lời, mang dấu đi theo. Một cái chờ cố định sẽ đua với việc thay ấy và thua lặng lẽ, mà
 * thua nó là khác biệt giữa một kho đáp án lớn dần và một kho không bao giờ lớn.
 */
const QUIZ_FEEDBACK_TIMEOUT_MS = 5000;
const QUIZ_FEEDBACK_POLL_MS = 60;

/** Lượt chạy bị người dùng dừng — không phải lỗi, nên mang kiểu riêng. */
export class QuestAborted extends Error {
  constructor() {
    super("Lượt chạy đã bị dừng.");
    this.name = "QuestAborted";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function describeCondition(c) {
  if (!c) return "-";
  return c.kind === "textMatches" || c.kind === "textNotMatches"
    ? `${c.selector || "page"} ${c.kind} "${c.text}"`
    : `${c.selector} ${c.kind}`;
}

const VERBS = {
  click: "click",
  clickByText: "click-by-text",
  waitForCondition: "wait",
  waitForSelector: "wait-for",
  readText: "read",
  readCooldownSeconds: "cooldown read",
};
const verb = (action) => VERBS[action] ?? String(action).toLowerCase();

/** Chuẩn hoá để so tên: NFC, thường, gộp khoảng trắng. */
function normalizeText(s) {
  if (!s || !s.trim()) return "";
  return s.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------------------
// Option: bảng thay thế {{key}}
// ---------------------------------------------------------------------------------------

/**
 * Đọc option của quest thành bảng thay thế — GỌI LẠI MỖI LẦN GIẢI, nên giá trị là thứ người
 * dùng đang chọn ở khoảnh khắc này, không phải lúc script khởi động.
 */
function buildOptionValues(quest) {
  const values = new Map();

  for (const option of quest.options ?? []) {
    if (!option.key || !option.key.trim()) continue;

    // Option mà lựa chọn đã lưu không còn tồn tại thì rơi về lựa chọn đầu, chứ không thay
    // bằng chuỗi rỗng — chuỗi rỗng lặng lẽ sinh ra ".cr-mode-btn.". Ngoại lệ là option
    // AllowCustom: giá trị không lựa chọn nào mang chính là cái người dùng tự gõ, và nó
    // được thay nguyên văn, trừ các ký tự có thể phá chuỗi JS hoặc selector mà nó rơi vào.
    let chosen = (option.choices ?? []).find((c) => c.value === option.selectedValue);

    if (!chosen && option.allowCustom && option.selectedValue?.trim()) {
      values.set(
        option.key,
        option.selectedValue.replace(/['\\\n\r]/g, "").trim(),
      );
      continue;
    }

    chosen ??= (option.choices ?? [])[0];
    values.set(option.key, chosen?.value ?? "");
  }

  return values;
}

const hasPlaceholder = (s) => typeof s === "string" && s.includes("{{");

function fillString(value, values) {
  if (!value || !value.includes("{{")) return value;
  let out = value;
  for (const [key, replacement] of values) {
    out = out.split(`{{${key}}}`).join(replacement);
  }
  return out;
}

function fillCondition(condition, values) {
  if (!condition) return condition;
  return {
    ...condition,
    selector: fillString(condition.selector, values),
    text: fillString(condition.text, values),
  };
}

function stepHasPlaceholder(step) {
  return (
    hasPlaceholder(step.selector) ||
    hasPlaceholder(step.text) ||
    hasPlaceholder(step.script) ||
    hasPlaceholder(step.optionsSelector) ||
    hasPlaceholder(step.when?.selector) ||
    hasPlaceholder(step.when?.text) ||
    hasPlaceholder(step.condition?.selector) ||
    hasPlaceholder(step.condition?.text)
  );
}

/**
 * Trả về bước ở dạng nó PHẢI CHẠY ngay bây giờ. Bản sao là NÔNG có chủ ý, và hai thành viên
 * cố tình giữ tham chiếu gốc: `steps`, để thân một repeat được giải lại từng bước ở mỗi
 * vòng thay vì đóng băng lúc vào vòng; và `until`, thứ mà chính handler của repeat tự giải
 * ở mỗi lần kiểm, cùng một lý do. Giải sâu ở đây sẽ lặng lẽ dựng lại đúng cái đóng băng mà
 * thiết kế này gỡ bỏ.
 */
function resolveForExecution(step, quest) {
  if (!(quest.options?.length > 0) || !stepHasPlaceholder(step)) return step;

  const values = buildOptionValues(quest);
  return {
    ...step,
    selector: fillString(step.selector, values),
    text: fillString(step.text, values),
    script: fillString(step.script, values),
    optionsSelector: fillString(step.optionsSelector, values),
    condition: fillCondition(step.condition, values),
    when: fillCondition(step.when, values),
    steps: step.steps,
    until: step.until,
  };
}

/** Giải một điều kiện theo option sống — dùng cho `until` của repeat. */
function resolveCondition(condition, quest) {
  if (!condition) return null;
  const needs = hasPlaceholder(condition.selector) || hasPlaceholder(condition.text);
  if (!(quest.options?.length > 0) || !needs) return condition;
  return fillCondition(condition, buildOptionValues(quest));
}

// ---------------------------------------------------------------------------------------
// Kết quả một lượt chạy
// ---------------------------------------------------------------------------------------

const result = (quest, outcome, extra = {}) => ({
  questId: quest.id,
  questName: quest.name,
  outcome,
  ...extra,
});

// ---------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {{info:Function, debug:Function, warning:Function}} deps.log  nhận (scope, message)
 * @param {() => boolean} [deps.shouldStop]   true khi người dùng đã bấm dừng
 * @param {{resolve:Function, learn:Function}} [deps.quiz]  kho đáp án, nếu có
 */
export function createQuestEngine(deps) {
  const log = deps.log;
  const shouldStop = deps.shouldStop ?? (() => false);
  const quiz = deps.quiz ?? null;

  const throwIfStopped = () => {
    if (shouldStop()) throw new QuestAborted();
  };

  const checkCondition = async (session, condition) => {
    const value = await session.evaluate(conditionProbe, {
      selector: condition.selector ?? null,
      kind: condition.kind,
      text: condition.text ?? null,
    });
    return value === true;
  };

  /**
   * Một `stopIf` dạng VẮNG MẶT vừa khớp — nhưng nó có thật không, hay trang chưa vẽ tới đó?
   *
   * Trả về true khi lượt dừng là THẬT. Đây là chỗ đắt giá nhất của cả bộ thông dịch, nên nói
   * rõ vì sao nó tồn tại: `hidden` của `conditionProbe` là「không phần tử nào khớp mà đang
   * hiện」, và một selector CHƯA CÓ MẶT trong DOM cũng thoả mãn nguyên văn câu đó. Trang game
   * vẽ làm hai đợt — vỏ do server dựng, còn ruột do một XHR trạng thái vẽ 2–4 giây sau — nên
   * giữa hai đợt ấy MỌI nút của trang đều「hidden」. Lấy đúng một mẫu trong khoảng đó là đọc
   *「trang chưa nói gì」thành「trang nói không có gì để làm」, và một `stopIf` thì kết thúc cả
   * nhiệm vụ trong im lặng, ở mức alreadyDone — không một dòng lỗi nào.
   *
   * Đó chính là vụ Hoang Vực: bật chạy song song, ba tab cùng dựng trang, `#battle-button`
   * tới muộn, và nhiệm vụ dừng ở「chưa đánh được (đang chờ lượt hoặc đã hết 5 lượt hôm nay)」
   * mỗi vòng, suốt cả ngày, trong khi「Lượt đánh còn lại」không hề nhúc nhích khỏi 5.
   *
   * Phép phân biệt là SỰ CÓ MẶT TRONG DOM, không phải sự hiển thị: nút đang mang
   * `display:none` là trang ĐÃ trả lời (đang cooldown / hết lượt) — dừng ngay, không tốn một
   * mili giây nào. Chỉ khi selector không khớp gì cả ta mới nán lại chờ nó xuất hiện; nó hiện
   * ra thì lượt dừng bị huỷ và nhiệm vụ đi tiếp, còn hết ngân sách thì lượt dừng là thật.
   */
  async function stopIsReal(session, condition, scope) {
    if (condition.kind !== "hidden" || !condition.selector?.trim()) return true;

    const present = await session.evaluate(selectorPresence, { selector: condition.selector });
    if (typeof present === "number" && present > 0) return true;

    log.debug(
      scope,
      `'${condition.selector}' chưa có mặt trong DOM — chờ tối đa ${Math.round(STOP_CONFIRM_MS / 1000)}s ` +
        "xem trang có đang vẽ chậm không, trước khi tin là không có gì để làm.",
    );

    // Chờ điều kiện LẬT NGƯỢC: `visible` trên cùng selector thức dậy ngay khoảnh khắc phần tử
    // được gắn vào và vẽ ra. Cắt lát để lệnh Thu Đàn vẫn cầm quyền từ ngoài này.
    const deadline = Date.now() + STOP_CONFIRM_MS;
    for (;;) {
      throwIfStopped();

      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;

      const appeared = await session.evaluate(
        conditionWaitSource(
          { kind: "visible", selector: condition.selector, text: null },
          Math.min(remaining, 2000),
        ),
      );

      if (appeared === true) {
        log.debug(scope, `'${condition.selector}' đã hiện ra — trang chỉ vẽ chậm, không phải hết lượt.`);
        return false;
      }

      if (appeared === undefined) await sleep(300);
    }
  }

  // -------------------------------------------------------------------------------------

  async function run(session, profile, quest) {
    try {
      if (quest.kind === "labelMatch") return await runLabelMatch(session, profile, quest);
      if (quest.kind === "customSteps") return await runCustomSteps(session, quest);
      return result(quest, "skipped", { message: `Loại nhiệm vụ lạ: ${quest.kind}` });
    } catch (err) {
      if (err instanceof QuestAborted) throw err;
      return result(quest, "failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  // -------------------------------------------------------------------------------------

  async function runLabelMatch(session, profile, quest) {
    if (!(quest.matchTexts?.length > 0)) {
      return result(quest, "skipped", { message: "Nhiệm vụ này chưa khai nhãn để khớp." });
    }

    const scope = `Quest:${quest.name}`;
    const { url, via } = await resolveQuestPage(session, profile, quest);

    // Điều hướng LUÔN LUÔN, kể cả khi trình duyệt đã đậu sẵn ở URL này — xem ghi chú trong
    // session.navigate: "đang ở đúng trang rồi" chính là cách một lượt thừa kế một cái xác.
    await session.humanDelay();
    const nav = await session.navigate(url);
    if (!nav.ok) {
      return result(quest, "failed", { message: `Không mở được trang nhiệm vụ (${url}): ${nav.error}` });
    }

    log.debug(scope, `Trang: ${url} (${via})`);

    const guide = await session.evaluate(guideProbe);
    if (guide && guide.trim()) log.info(scope, `Hướng dẫn trên trang: ${guide}`);

    await session.humanDelay();

    const args = {
      matchTexts: quest.matchTexts,
      postClickWaitMs: session.postClickWaitMs,
      maxClicks: 15,
    };

    let res = await session.evaluate(labelMatchSweep, args);

    // Bảng nhiệm vụ nạp danh sách bằng client ("Đang tải danh sách nhiệm vụ..."). Nếu lượt
    // quét đầu không thấy gì thì cho việc render một nhịp rồi thử lại đúng một lần. An toàn:
    // lượt đầu chưa bấm gì cả.
    if (!res || (!res.found && res.clickedCount === 0)) {
      await sleep(2500);
      res = (await session.evaluate(labelMatchSweep, args)) ?? res;
    }

    if (!res) {
      return result(quest, "failed", { message: "Script quét không chạy được (trang chưa sẵn sàng)." });
    }

    if (res.lastPopup?.trim()) log.debug(scope, `Popup: ${res.lastPopup}`);

    if (res.clickedCount > 0) {
      const cooldown = res.cooldownSeconds ?? quest.fallbackCooldownSeconds;
      const message = res.confirmedCount > 0 ? `${res.message} (+${res.confirmedCount} popup confirm)` : res.message;
      return result(quest, "completed", { matchedLabel: res.matchedText, cooldownSeconds: cooldown, message });
    }

    if (res.pendingCount > 0) {
      return typeof res.cooldownSeconds === "number"
        ? result(quest, "onCooldown", { cooldownSeconds: res.cooldownSeconds, message: res.message })
        : result(quest, "alreadyDone", { cooldownSeconds: quest.fallbackCooldownSeconds, message: res.message });
    }

    if (res.found) {
      return result(quest, "alreadyDone", { cooldownSeconds: quest.fallbackCooldownSeconds, message: res.message });
    }

    return result(quest, "notAvailable", { message: describeMiss(res) });
  }

  /** Khi không khớp gì, nói xem trên trang ĐANG có gì, để hiệu chỉnh nhãn từ nhật ký. */
  function describeMiss(res) {
    if (!(res.samples?.length > 0)) return res.message ?? "không có control nào khớp";
    let shown = res.samples.slice(0, 8).join(" | ");
    if (shown.length > 220) shown = shown.slice(0, 220) + "…";
    return `${res.message ?? "không có control nào khớp"} — control đang hiện: ${shown}`;
  }

  /** Trang khai sẵn → trang dò từ menu của site → bảng nhiệm vụ hằng ngày. */
  async function resolveQuestPage(session, profile, quest) {
    if (quest.pagePath?.trim()) {
      return { url: session.resolveUrl(quest.pagePath), via: "trang khai sẵn" };
    }

    const links = (await session.evaluate(menuProbe)) ?? [];
    const hit = findMenuLink(links, quest);
    if (hit) return { url: session.resolveUrl(hit.href), via: `menu site '${hit.text}'` };

    log.debug(`Quest:${quest.name}`, `Không mục menu nào khớp; dùng bảng nhiệm vụ. (đã quét ${links.length} link)`);
    return { url: session.resolveUrl(profile.dailyQuestPath), via: "bảng nhiệm vụ" };
  }

  /** Khớp đúng tên menu thắng; khớp một phần chỉ là phương án dự phòng. */
  function findMenuLink(links, quest) {
    const keys = [quest.name, ...(quest.matchTexts ?? [])];
    const wanted = [...new Set(keys.map(normalizeText).filter((k) => k.length >= 3))];

    for (const key of wanted) {
      const exact = links.find((l) => normalizeText(l.text) === key);
      if (exact) return exact;
    }
    for (const key of wanted) {
      const partial = links.find((l) => normalizeText(l.text).includes(key));
      if (partial) return partial;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------

  async function runCustomSteps(session, quest) {
    if (!(quest.steps?.length > 0)) {
      return result(quest, "skipped", { message: "Nhiệm vụ tuỳ biến không có bước nào." });
    }

    const scope = `Quest:${quest.name}`;
    let state;
    let error;

    /**
     * DẤU NGÀY nhặt được trong lượt chạy này — xem `MARK_PREFIX`.
     *
     * Sống NGOÀI vòng thử lại, khác mọi thứ trong `state`: một dấu nghĩa là「việc ấy đã làm
     * rồi ngoài đời」, và một lượt thử lại không hoàn tác được nó. Đặt trong `state` thì lượt
     * thử lại sau một trang chưa dựng xong sẽ quên mất rằng phù vừa được mua — rồi mua lần nữa.
     */
    const dailyMarks = new Set();

    // Chạy lại từ bước 0 khi — và CHỈ khi — script gục vì trang chưa dựng xong. Xem
    // MAX_PAGE_RENDER_ATTEMPTS để biết vì sao đơn vị thử lại là cả nhiệm vụ.
    //
    // `state` dựng MỚI mỗi lượt, không tái dùng: cooldown/lastRead/stopReason của lượt hỏng
    // mà sống sót sang lượt sau thì kết quả cuối cùng sẽ kể chuyện của một lượt đã chết.
    //
    // Thu Đàn giữa chừng ném QuestAborted từ `throwIfStopped` và KHÔNG bị bắt ở đây — nó
    // xuyên thẳng lên `run`, đúng như trước. Một vòng thử lại nuốt mất tín hiệu dừng là cách
    // biến nút Thu Đàn thành nút gợi ý.
    for (let attempt = 1; ; attempt++) {
      state = {
        cooldown: null,
        lastRead: null,
        stopReason: null,
        pageNotRendered: false,
        dailyCapReached: false,
        dailyMarks,
      };
      error = await executeSteps(session, quest, quest.steps, state, 0);

      if (!error || !state.pageNotRendered || attempt >= MAX_PAGE_RENDER_ATTEMPTS) break;

      // Mức info: đây là thứ giải thích vì sao một nhiệm vụ tốn gấp đôi, gấp ba thời gian —
      // im lặng ở đây là để người đọc nhật ký tự đoán.
      log.info(
        scope,
        `${error} — tải lại trang rồi thử lại (lượt ${attempt + 1}/${MAX_PAGE_RENDER_ATTEMPTS}).`,
      );
    }

    /**
     * Dấu ngày đi kèm MỌI kết cục, kể cả `failed`.
     *
     * Không có ngoại lệ nào cho lượt hỏng, và đó là chủ ý: dấu nói về một việc ĐÃ XẢY RA
     * ngoài đời (một lá phù đã trả tiền), không phải về việc nhiệm vụ có chạy trót lọt hay
     * không. Giữ lại dấu của một vòng hỏng là cùng lắm mất một lá phù của hôm ấy; đánh rơi nó
     * là mua lá thứ hai — đúng cái lỗi bản này sinh ra để chữa.
     */
    const withMarks = (outcome) =>
      dailyMarks.size > 0 ? { ...outcome, dailyMarks: [...dailyMarks] } : outcome;

    if (error) return withMarks(result(quest, "failed", { message: error }));

    if (state.stopReason) {
      // Hai trạng thái khác nhau cùng kết thúc sớm một script, và chúng đáng được kể khác
      // nhau. Còn giữ một đồng hồ đếm ngược thật nghĩa là nhiệm vụ đang CHỜ — đó là
      // onCooldown, ghi ở mức Info kèm thời gian còn lại. Dừng mà không có đồng hồ nghĩa là
      // hết lượt hôm nay: hôm nay sẽ không có gì nữa, nên nó ở yên mức alreadyDone.
      return withMarks(
        state.cooldown > 0
          ? result(quest, "onCooldown", { cooldownSeconds: state.cooldown, message: state.stopReason })
          : result(quest, "alreadyDone", {
              cooldownSeconds: quest.fallbackCooldownSeconds,
              message: state.stopReason,
              // Thứ quyết định là NGUỒN của câu「không còn gì để làm」, không phải bản thân câu
              // ấy. `true` = một bước `stopIf` khớp, tức chính TRANG GAME trả lời; các ngả khác
              // cùng về `alreadyDone` (Vấn Đáp gặp câu chưa biết đáp án) là giới hạn của khôi
              // lỗi, và nhớ chúng thành「đã đủ lượt」là khoá nhầm cả ngày — xem dailyQuota.mjs.
              dailyCapReached: state.dailyCapReached === true,
            }),
      );
    }

    return withMarks(
      result(quest, "completed", {
        matchedLabel: quest.name,
        cooldownSeconds: state.cooldown ?? quest.fallbackCooldownSeconds,
        message: state.lastRead,
      }),
    );
  }

  /** Chạy một danh sách bước theo thứ tự. Trả null khi xong, hoặc câu báo lỗi. */
  async function executeSteps(session, quest, steps, state, depth) {
    const scope = `Quest:${quest.name}`;

    for (const original of steps) {
      throwIfStopped();

      // Giải Ở ĐÂY, không phải lúc script khởi động: đây chính là thứ khiến một thay đổi
      // option rơi vào giữa lượt đang chạy.
      const step = resolveForExecution(original, quest);

      // Guard trước tiên: bước nào chưa hội đủ điều kiện thì KHÔNG được thử. Ghi lại kèm
      // nguyên văn điều kiện, để một guard không bao giờ đúng lộ ra trong nhật ký thay vì
      // trông như một control chỉ đơn giản là vắng mặt.
      if (step.when && !(await checkCondition(session, step.when))) {
        log.debug(
          scope,
          `Bỏ qua ${verb(step.action)} trên '${step.selector ?? step.text ?? "-"}' — ` +
            `chưa hội đủ điều kiện: ${describeCondition(step.when)}`,
        );
        continue;
      }

      const error = await executeStep(session, quest, step, state, depth);

      if (state.stopReason) break;
      if (!error) continue;

      if (step.optional === true) {
        // Cố ý không diễn đạt như một thất bại: một bước tuỳ chọn không áp dụng là đường đi
        // bình thường, và đọc "Click hỏng" trong nhật ký là gây hiểu nhầm.
        log.debug(scope, `Bỏ qua bước tuỳ chọn ${verb(step.action)} trên '${step.selector ?? step.text ?? "-"}' — không có.`);
        continue;
      }

      // Ghi NGUYÊN NHÂN lên state, ngay tại chỗ duy nhất một bước bắt buộc kết liễu script.
      //
      // Dùng state chứ không dò chữ trong thông điệp lỗi: `repeat` bọc lỗi của thân vòng
      // thành "repeat vòng 3: …", nên một phép so chuỗi sẽ phải đoán qua nhiều lớp bọc và sẽ
      // chết lặng vào ngày ai đó sửa lời văn. `state` là CÙNG MỘT object đi xuyên mọi tầng
      // repeat, nên cờ dựng ở đáy nổi thẳng lên `runCustomSteps` không cần trung gian nào.
      //
      // Chỉ `waitForSelector`, KHÔNG phải `waitForCondition`: hai thứ nghe giống nhau nhưng
      // một cái hỏi "trang vẽ xong chưa" (thử lại là vô hại), còn cái kia hỏi "chuyện đó xảy
      // ra chưa" — và bước bằng-chứng-đòn-đánh của Hoang Vực chính là loại thứ hai. Chạy lại
      // nó nghĩa là đánh boss thêm một lần nữa, đốt một lượt trong ngày của đạo hữu.
      if (step.action === "waitForSelector") state.pageNotRendered = true;

      return error;
    }

    return null;
  }

  async function executeStep(session, quest, step, state, depth) {
    const scope = `Quest:${quest.name}`;

    switch (step.action) {
      case "navigate": {
        const nav = await session.navigate(session.resolveUrl(step.text ?? step.selector ?? "/"));
        return nav.ok ? null : `Điều hướng hỏng: ${nav.error}`;
      }

      case "waitForSelector":
        return (await session.waitForSelector(step.selector ?? "", step.timeoutMs))
          ? null
          // Nói ra CẢ thời gian đã chờ. "Selector không bao giờ xuất hiện" đọc như thể trang
          // thiếu hẳn phần đó, và ngày 05/08 nó khiến mấy tab thua cuộc đua CPU trông y hệt
          // một tính năng chưa mở — hai chuyện cần cách chữa hoàn toàn khác nhau.
          : `Trang chưa dựng xong sau ${Math.round((step.timeoutMs ?? 15000) / 1000)}s — không thấy ${step.selector}`;

      case "click":
        await session.humanDelay();
        return (await session.click(step.selector ?? "", step.timeoutMs, step.forceClick === true))
          ? null
          : `Click hỏng: ${step.selector}`;

      case "clickByText":
        await session.humanDelay();
        return (await session.clickByText(step.text ?? "", step.timeoutMs))
          ? null
          : `Không bấm được chữ: ${step.text}`;

      case "waitMilliseconds":
        await sleep(clamp(step.timeoutMs, 0, 60_000));
        return null;

      case "readText":
        state.lastRead = await session.getText(step.selector ?? "");
        return null;

      case "readCooldownSeconds": {
        if (step.script?.trim()) {
          const value = await session.evaluate(step.script);
          if (typeof value === "number" && Number.isFinite(value)) state.cooldown = Math.round(value);
        } else {
          const text = await session.getText(step.selector ?? "");
          state.cooldown = session.parseCooldownSeconds(text) ?? state.cooldown;
        }
        return null;
      }

      case "evaluateJavaScript": {
        state.lastRead = await session.evaluate(step.script ?? "");

        // Giá trị trả về của một script là TIẾNG NÓI của nó, trên BA kênh. Dòng bắt đầu
        // bằng '!' là TƯỜNG THUẬT — thứ người theo dõi nên đọc ("X vừa vào phòng", "Trục
        // xuất Y — HP dưới ngưỡng") — và đi vào Info. Dòng bắt đầu bằng '@' là một DẤU NGÀY
        // (xem MARK_PREFIX). Còn lại là số liệu ("kick-scan thr=…") và đi vào Debug. Một
        // script, một lần trả về, phục vụ cả ba người đọc; '' nghĩa là nó không có gì để nói.
        if (typeof state.lastRead === "string" && state.lastRead.trim()) {
          const debugLines = [];
          for (const raw of state.lastRead.split("\n")) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith("!")) log.info(scope, line.slice(1).trim());
            else if (line.startsWith(MARK_PREFIX)) {
              const key = line.slice(MARK_PREFIX.length).trim();
              // Dấu rỗng là script viết hỏng, không phải một sự thật — vứt, và để nó lộ ra ở
              // Debug thay vì lặng lẽ ghi một chuỗi rỗng vào sổ của đàn.
              if (key) {
                state.dailyMarks?.add(key);
                debugLines.push(`dấu ngày: ${key}`);
              } else {
                debugLines.push(`dấu ngày RỖNG từ ${line} — script viết hỏng?`);
              }
            } else debugLines.push(line);
          }
          if (debugLines.length > 0) {
            const text = debugLines.join(" | ");
            log.debug(scope, `eval: ${text.length > 300 ? text.slice(0, 300) + "…" : text}`);
          }
        }

        return null;
      }

      case "expectVisible":
        return (await session.waitForSelector(step.selector ?? "", step.timeoutMs))
          ? null
          : `Phần tử cần thấy lại không hiện: ${step.selector}`;

      case "stopIf": {
        if (!step.condition) return "stopIf không có điều kiện.";

        if (
          (await checkCondition(session, step.condition)) &&
          (await stopIsReal(session, step.condition, scope))
        ) {
          state.stopReason = step.text?.trim() ? step.text : `không có gì để làm (${describeCondition(step.condition)})`;
          // Đánh dấu NGUỒN của lượt dừng ngay tại đây, chỗ duy nhất trang game tự phán. Không
          // có cờ này thì nơi trên chỉ còn cách dò chữ trong `stopReason` để đoán xem lượt
          // dừng là「hết lượt hôm nay」hay「ta chưa biết đáp án」— một phép đoán chết lặng vào
          // ngày ai đó sửa lời văn của một quest trong hồ sơ.
          state.dailyCapReached = true;
          // KHÔNG kể ở đây, và đó là chủ ý — xem `stopReason` đi tiếp vào `result.message`.
          //
          // Lý do dừng vẫn phải tới tay người đọc bằng lời TRẦN ("đã đủ huyền tinh hôm nay",
          // chứ không phải "stopIf khớp" — ngôn ngữ của người viết flow; ảnh 05/08 là bằng
          // chứng nó gây khó hiểu). Nhưng người kể là VÒNG CHẠY, không phải chỗ này: mọi kết
          // cục đều đi qua `OUTCOME_TEXT` của runCycle và ra đúng một dòng tổng kết
          //「<tên>: <lý do>」, cùng khuôn với mọi nhiệm vụ khác.
          //
          // Kể ở CẢ HAI nơi là cái lỗi vừa gỡ: nhật ký hiện hai dòng y hệt nhau cách nhau vài
          // mili giây, chỉ khác mỗi tiền tố `Quest:` của scope này —「Quest:Mê Cung: đã đủ
          // huyền tinh hôm nay」ngay trên「Mê Cung: đã đủ huyền tinh hôm nay」. Đo trên bản ghi
          // thật 19/08/2026: 323 đôi trong ba ngày, trải khắp 11 nhiệm vụ. Và vì hai lượt gửi
          // đều là POST bắn-rồi-quên, thứ tự hai dòng còn đảo qua đảo lại giữa các lượt.
        }

        return null;
      }

      case "answerQuiz":
        return await answerQuiz(session, step, state, scope);

      case "waitForCondition": {
        if (!step.condition) return "waitForCondition không có điều kiện.";

        // Chờ lâu là chính đáng ở đây (một sảnh đang đầy dần), nên trần cao — nhưng không
        // bao giờ vô hạn.
        const timeout = clamp(step.timeoutMs, 500, 30 * 60 * 1000);
        const deadline = Date.now() + timeout;

        // Cái chờ sống TRONG TRANG (conditionWaitSource): MutationObserver đánh thức nó
        // ngay tại khoảnh khắc DOM đổi, nên trạng thái ngắn hơn một nhịp poll không còn
        // lọt lưới — vòng lấy mẫu 300ms cũ mù đúng những ca đó, mà Mê Cung thì dựng toàn
        // bằng chúng. Cắt lát thay vì một evaluate dài, để lệnh dừng và ngân sách bước
        // vẫn cầm quyền từ ngoài này; trong một lát, phản ứng là tức thời.
        for (;;) {
          throwIfStopped();

          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return `Hết ${Math.round(timeout / 1000)}s chờ: ${describeCondition(step.condition)}`;
          }

          const hit = await session.evaluate(
            conditionWaitSource(step.condition, Math.min(remaining, 2000)),
          );

          if (hit === true) return null;

          // undefined = chính evaluate hỏng — thường là một cú điều hướng rút trang khỏi
          // chân cái chờ. Lùi một nhịp ngắn để trang hỏng thành một timeout có tên, không
          // phải một vòng xoay nóng.
          if (hit === undefined) await sleep(300);
        }
      }

      case "repeat": {
        if (depth >= MAX_REPEAT_DEPTH) return `repeat lồng sâu quá ${MAX_REPEAT_DEPTH} tầng.`;

        const body = step.steps;
        if (!(body?.length > 0)) return "repeat không có bước nào.";

        const maxIterations = clamp(step.maxIterations ?? 10, 1, 200);
        const maxSeconds = clamp(step.maxSeconds ?? 600, 5, 6 * 3600);
        const deadline = Date.now() + maxSeconds * 1000;
        let done = 0;
        let reason;

        for (;;) {
          throwIfStopped();

          // Kiểm TRƯỚC thân vòng, nên một vòng lặp đã đạt mục tiêu sẵn thì không chạy lần
          // nào. Giải lại mỗi vòng: vòng ngoài của Mê Cung chạy tới 35 phút trên điều kiện
          // này, và "{{capCheck}}" đổi giữa chừng thì phải tính.
          const until = resolveCondition(step.until, quest);
          if (until && (await checkCondition(session, until))) {
            reason = "điều kiện until đã đạt";
            break;
          }

          if (done >= maxIterations) {
            reason = `trần số vòng (${maxIterations})`;
            break;
          }

          if (Date.now() >= deadline) {
            reason = `trần thời gian (${maxSeconds}s)`;
            break;
          }

          const error = await executeSteps(session, quest, body, state, depth + 1);
          if (error) return `repeat vòng ${done + 1}: ${error}`;

          done++;
          log.debug(scope, `repeat: xong ${done} vòng.`);

          // Một stopIf trong thân kết thúc CẢ script, không chỉ vòng này.
          if (state.stopReason) {
            reason = state.stopReason;
            break;
          }
        }

        // Debug chứ không Info: "repeat", "until", "trần số vòng" là ngôn ngữ của script.
        // Câu chuyện người đọc cần đã nằm ở lời kể "!" của chính quest (Giữ lửa 1/3…) và
        // dòng kết quả cuối lượt; chi tiết vòng lặp thuộc về console của máy đang chạy.
        log.debug(scope, `repeat kết thúc sau ${done} vòng — ${reason}.`);
        return null;
      }

      default:
        return `Bước không hỗ trợ: ${step.action}`;
    }
  }

  // -------------------------------------------------------------------------------------

  /**
   * Trả lời một câu trắc nghiệm, rồi đọc lại xem site nói đáp án nào đúng.
   *
   * Một câu không giải được sẽ KẾT THÚC script qua `stopReason` chứ không làm hỏng nó và
   * cũng không đoán bừa: trả lời sai tiêu một lượt trong ngày mà chẳng được gì, nên những
   * câu còn lại tốt hơn hết là để dành cho người dùng.
   */
  async function answerQuiz(session, step, state, scope) {
    const probe = await session.evaluate(quizProbe, {
      question: step.selector ?? null,
      options: step.optionsSelector ?? null,
    });

    if (!probe || !probe.question?.trim() || !(probe.options?.length > 0)) {
      return `Không đọc được câu hỏi từ ${step.selector} / ${step.optionsSelector}.`;
    }

    // Đáp án bị khoá lại sau khi đã trả lời; không còn cái nào mở nghĩa là bài đố đã đi tiếp
    // dưới chân ta.
    if (probe.enabled.length === probe.options.length && !probe.enabled.includes(true)) {
      state.stopReason = "câu hỏi đã bị khoá — không còn lượt trả lời";
      return null;
    }

    if (!quiz) {
      state.stopReason = "chưa có kho đáp án trên bản web — để dành lượt cho bạn";
      log.warning(scope, `Bỏ qua "${shorten(probe.question)}": bản web chưa có kho đáp án.`);
      return null;
    }

    const answer = await quiz.resolve({ text: probe.question, options: probe.options });

    if (!answer) {
      state.stopReason = `chưa biết đáp án: "${shorten(probe.question)}"`;
      log.warning(scope, `Không có đáp án cho "${shorten(probe.question)}" — dừng để dành lượt còn lại cho bạn.`);
      return null;
    }

    // Qua đường nhập liệu thật, không bao giờ bằng el.click() trong trang — xem ghi chú ở
    // session.clickOptionByText.
    await session.humanDelay();
    const clicked = await session.clickOptionByText(
      step.optionsSelector ?? "",
      answer.option,
      answer.index ?? -1,
      5000,
    );

    if (!clicked) return `Không bấm được đáp án '${answer.option}'.`;

    log.info(scope, `"${shorten(probe.question)}" → ${answer.option} (${answer.source ?? "?"})`);

    // Bắt lấy lúc site đánh dấu đáp án đúng, rồi nhớ nó. Đây là cách DUY NHẤT kho lớn lên,
    // và nó đúng bất kể câu vừa rồi trả lời đúng hay sai.
    const confirmed = await watchForCorrectOption(session, step.optionsSelector);
    if (confirmed?.trim()) await quiz.learn(probe.question, confirmed);

    return null;
  }

  /**
   * Rình dấu đáp-án-đúng và trả về ngay khi nó hiện, bỏ cuộc lặng lẽ sau ngân sách. Không
   * thấy KHÔNG phải lỗi — nó chỉ nghĩa là câu này chưa được học.
   */
  async function watchForCorrectOption(session, optionsSelector) {
    const deadline = Date.now() + QUIZ_FEEDBACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const text = await session.evaluate(quizCorrectAnswer, { options: optionsSelector ?? null });
      if (typeof text === "string" && text.trim()) return text;
      await sleep(QUIZ_FEEDBACK_POLL_MS);
    }
    return null;
  }

  const shorten = (v) => (v.length <= 60 ? v : v.slice(0, 60) + "…");

  return { run };
}

/** Các nhiệm vụ chạy trong lượt này, theo thứ tự — đúng như bản desktop sắp. */
export function enabledQuestsInOrder(profile) {
  return (profile.quests ?? [])
    .filter((q) => q.enabled)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)));
}

/**
 * Kế hoạch của một lượt, sau khi đã biết hạng tài khoản.
 *
 * Hai tab VIP / Thường là hai bộ flow loại trừ nhau, không phải quan hệ cha-con. Ba quest
 * cùng mục tiêu dùng selector hoàn toàn khác giữa hai hạng; cho VIP chạy luôn flow Thường
 * sẽ nhận thưởng hai lần và báo lỗi giả. `requiresVip` vắng mặt vẫn được đọc là TRUE để hồ
 * sơ cũ không bất ngờ chạy trên tài khoản thường.
 */
export function questsForAccount(profile, { isVip }) {
  return enabledQuestsInOrder(profile).filter((q) =>
    isVip ? q.requiresVip !== false : q.requiresVip === false,
  );
}
