/**
 * JavaScript chạy BÊN TRONG trang game.
 *
 * Port từ `BoardScripts.cs` của bản desktop (JarvisHH3D.Infrastructure). Bản C# buộc phải
 * giữ chúng dưới dạng CHUỖI; ở đây chúng là HÀM THẬT, vì Playwright bản JS nhận thẳng
 * function và tự chuyển vào trang. Khác biệt đó không phải chuyện thẩm mỹ: dạng chuỗi bắt
 * mọi `\s`, `\p{L}`, `${` phải escape thêm một tầng, và một dấu gạch chéo sai ở đó lặng lẽ
 * đổi nghĩa regex — chỗ nguy nhất là bảng phân loại nút popup, nơi regex hỏng nghĩa là bấm
 * nhầm vào "Huỷ" thay vì "Đồng ý". Ở dạng hàm, thứ bạn đọc đúng là thứ trang chạy.
 *
 * Vì hàm được serialize rồi mới chạy trong trang nên KHÔNG có closure: mọi helper phải nằm
 * trong thân hàm. Các script gốc vốn đã tự chứa, nên đây là port thẳng.
 *
 * Comment tiếng Anh bên trong thân hàm là comment gốc, giữ nguyên để hai bản còn đối chiếu
 * được với nhau bằng mắt. Sửa ở đây thì sửa cả BoardScripts.cs.
 */

/**
 * Quét theo nhãn. Tìm mọi control đang hiện và bấm được có text khớp một trong các nhãn
 * mong muốn, bấm từng cái (query lại giữa các lần bấm vì DOM đổi), rồi báo về đã bấm bao
 * nhiêu, bao nhiêu cái khớp nhưng đang cooldown, và countdown gần nhất trên trang.
 */
export async function labelMatchSweep(args) {
  const cfg = args && typeof args === "object" ? args : {};
  const matchTexts = cfg.matchTexts ?? [];
  const postClickWaitMs = cfg.postClickWaitMs ?? 1400;
  const maxClicks = cfg.maxClicks ?? 15;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nfc = (s) => (s && s.normalize ? s.normalize("NFC") : s || "");
  const norm = (s) => nfc(s).replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = matchTexts.map(norm).filter(Boolean);

  const parseCooldown = (text) => {
    if (!text) return null;
    const t = text.toLowerCase();
    let m = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
    m = t.match(/(\d{1,2}):(\d{2})(?!:)/);
    if (m) return +m[1] * 60 + +m[2];
    let s = 0;
    let any = false;
    // Lookahead chứ không `\b`: `\b` của JavaScript chỉ biết [A-Za-z0-9_], nên sau "giờ" —
    // kết thúc bằng "ờ" — nó không thấy ranh giới nào, và "còn 2 giờ 5 phút" đọc ra 5 phút.
    // Bản C# dùng `\b` mà vẫn đúng vì `\w` của .NET nhận cả chữ Unicode; chỗ này là JS nên
    // phải nói ra điều đó bằng tay. (Bản in-page của desktop vẫn còn lỗi này.)
    const h = t.match(/(\d+)\s*(?:giờ|gio|hour|hrs|hr|h)(?![\p{L}\p{N}])/u);
    if (h) { s += +h[1] * 3600; any = true; }
    const mn = t.match(/(\d+)\s*(?:phút|phut|minutes|minute|mins|min|m)(?![\p{L}\p{N}])/u);
    if (mn) { s += +mn[1] * 60; any = true; }
    const sc = t.match(/(\d+)\s*(?:giây|giay|seconds|second|secs|sec|s)(?![\p{L}\p{N}])/u);
    if (sc) { s += +sc[1]; any = true; }
    return any ? s : null;
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const isDisabled = (el) =>
    el.disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    /(^|\s)(disabled|cooldown|done|completed|claimed|received|is-done)(\s|$)/.test(el.className || "");

  const collect = () =>
    Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], input[type="button"], input[type="submit"], .btn, .button, .btn-claim, .claim',
      ),
    );

  // ---- Popup handling -------------------------------------------------------------
  // Wording differs per quest, so classification is by keyword + class heuristics.
  // Safety rule: a negative (cancel/decline) button is NEVER clicked, and the settle
  // loop stops as soon as a round finds nothing it can positively identify.

  const popupRoots = () => {
    const sel =
      '.swal2-container, .swal2-popup, [role="dialog"], [role="alertdialog"], ' +
      ".modal, .modal-dialog, .modal-content, .popup, .dialog, " +
      '[class*="swal"], [class*="modal"], [class*="popup"]';
    const roots = [];
    for (const el of document.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      const st = getComputedStyle(el);
      const z = parseInt(st.zIndex, 10);
      const floating =
        st.position === "fixed" ||
        st.position === "absolute" ||
        (Number.isFinite(z) && z >= 100) ||
        /(^|\s)swal2-/.test(el.className || "");
      if (!floating) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 40) continue;
      roots.push(el);
    }
    return roots;
  };

  // Word lists are checked on whole-word boundaries for the short/ambiguous tokens so
  // e.g. "không" never lights up the "có" positive, and "nhận xét" stays excluded.
  const hasWord = (text, word) =>
    new RegExp(
      "(^|[^\\p{L}\\p{N}])" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^\\p{L}\\p{N}])",
      "u",
    ).test(text);
  const NEG_WORDS = ["hủy bỏ", "huỷ bỏ", "hủy", "huỷ", "không đồng ý", "không", "từ chối",
    "để sau", "quay lại", "thôi", "cancel", "decline", "deny", "no"];
  const POS_WORDS = ["đồng ý", "xác nhận", "chấp nhận", "chắc chắn", "tiếp tục", "nhận thưởng",
    "nhận ngay", "nhận", "đúng", "có", "ok", "okay", "yes", "confirm"];
  const CLOSE_WORDS = ["đóng", "tắt", "bỏ qua", "đã hiểu", "close", "dismiss", "skip", "x", "×", "✕"];
  const NEG_CLASS = /(swal2-cancel|swal2-deny|btn-cancel|cancel|decline|deny)/;
  const POS_CLASS = /(swal2-confirm|btn-confirm|btn-ok|btn-yes|confirm|agree|accept)/;
  const CLOSE_CLASS = /(swal2-close|btn-close|modal-close|close)/;

  const classifyPopupButton = (el) => {
    const label =
      norm(el.innerText || el.value || el.textContent || "") ||
      norm(el.getAttribute("aria-label") || el.getAttribute("title") || "");
    const cls = (el.className || "").toString().toLowerCase();
    if (NEG_WORDS.some((w) => hasWord(label, w)) || NEG_CLASS.test(cls)) return "neg";
    if (POS_WORDS.some((w) => hasWord(label, w)) || POS_CLASS.test(cls)) return "pos";
    if (CLOSE_WORDS.some((w) => hasWord(label, w)) || CLOSE_CLASS.test(cls)) return "close";
    return "other";
  };

  let confirmed = 0;
  let lastPopup = null;

  const settlePopups = async () => {
    for (let round = 0; round < 5; round++) {
      const roots = popupRoots();
      if (roots.length === 0) return;

      const seen = new Set();
      const buttons = [];
      for (const root of roots) {
        for (const b of root.querySelectorAll(
          'button, [role="button"], input[type="button"], input[type="submit"], a.btn, .btn, .button',
        )) {
          if (seen.has(b)) continue;
          seen.add(b);
          if (!isVisible(b) || isDisabled(b)) continue;
          buttons.push(b);
        }
      }
      if (buttons.length === 0) return;

      const pos = buttons.find((b) => classifyPopupButton(b) === "pos");
      const target = pos ?? buttons.find((b) => classifyPopupButton(b) === "close");
      if (!target) return; // only neg/unknown left → leave it alone

      const root = roots.find((r) => r.contains(target)) ?? roots[0];
      lastPopup = norm(root.innerText || root.textContent || "").slice(0, 160) || lastPopup;
      try {
        target.click();
        if (pos) confirmed++;
      } catch (e) {
        return; // click failed → do not spin on it
      }
      await sleep(500);
    }
  };
  // ---------------------------------------------------------------------------------

  let clicked = 0;
  let pending = 0;
  let found = false;
  let lastLabel = null;
  const clickedLabels = new Set();

  await settlePopups(); // clear any leftover popup first

  for (let pass = 0; pass < maxClicks; pass++) {
    const nodes = collect();
    let actedThisPass = false;

    for (const el of nodes) {
      const label = norm(el.innerText || el.value || el.textContent);
      if (!label) continue;
      if (!wanted.some((w) => label.includes(w))) continue;

      found = true;
      lastLabel = label;

      if (!isVisible(el)) continue;
      if (isDisabled(el)) { pending++; continue; }

      // Avoid clicking the exact same element twice within one sweep.
      if (el.dataset.jarvisClicked === "1") continue;
      el.dataset.jarvisClicked = "1";

      try {
        el.scrollIntoView({ block: "center" });
        el.click();
        clicked++;
        clickedLabels.add(label);
        actedThisPass = true;
        await sleep(postClickWaitMs);
        await settlePopups(); // quest click → confirm/result popups
      } catch (e) {
        // ignore this control and continue the sweep
      }
      break; // re-query the DOM after each click
    }

    if (!actedThisPass) break;
  }

  await settlePopups(); // catch a late-appearing result popup

  // Soonest remaining countdown anywhere on the board → when to come back.
  let soonest = null;
  const timerNodes = document.querySelectorAll(
    '[class*="countdown"], [class*="cooldown"], [class*="timer"], [id*="countdown"], [data-countdown], time',
  );
  for (const n of timerNodes) {
    const cd = parseCooldown(n.innerText || n.textContent);
    if (cd != null && cd > 0) soonest = soonest == null ? cd : Math.min(soonest, cd);
  }
  if (soonest == null) {
    const bodyCd = parseCooldown(document.body ? document.body.innerText : "");
    if (bodyCd != null && bodyCd > 0) soonest = bodyCd;
  }

  // Diagnostics: what IS clickable on this page right now (helps calibrate labels when
  // nothing matched — e.g. wrong page, renamed buttons, or content still loading).
  const samples = [];
  const seenSamples = new Set();
  for (const el of collect()) {
    if (!isVisible(el)) continue;
    const t = (el.innerText || el.value || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 48 || seenSamples.has(t)) continue;
    seenSamples.add(t);
    samples.push(t);
    if (samples.length >= 12) break;
  }

  const labels = Array.from(clickedLabels);
  const message =
    clicked > 0
      ? "clicked " + clicked + (labels.length ? ": " + labels.join(", ") : "")
      : pending > 0
        ? "matched but on cooldown/disabled"
        : found
          ? "already claimed"
          : "no matching control";

  return {
    found,
    clickedCount: clicked,
    pendingCount: pending,
    cooldownSeconds: soonest,
    matchedText: lastLabel,
    message,
    confirmedCount: confirmed,
    lastPopup,
    samples,
  };
}

/**
 * Đọc hạng tài khoản trên hub nhiệm vụ ngày. Trả `true` (VIP), `false` (thường) — hoặc
 * `null` khi CHƯA CHỨNG MINH ĐƯỢC sự vắng mặt, và người gọi phải hiểu null là "chưa biết",
 * không bao giờ là "thường".
 *
 * Tín hiệu là thẻ Phúc Lợi VIP `#nv-pt-vip-quest`: site chỉ phục vụ thẻ này cho tài khoản
 * VIP. Kiểm SỰ TỒN TẠI trong DOM chứ không kiểm hiển thị — thẻ có thể nằm dưới nếp gấp.
 *
 * Cổng hai tầng vì hub render làm HAI ĐỢT: bốn thẻ đầu tới ngay, đợt chứa thẻ VIP tới sau
 * vài giây (đo được ~2.5s trong bản ghi thực địa — chính là bẫy V5 của suite Phúc Lợi VIP
 * bên desktop). Probe chỉ gate bằng `.nv-quest` sẽ phán "thường" ngay trong khe hở đó, và
 * một lần phán nhầm là một tài khoản VIP mất trọn chu kỳ. Nên sự vắng mặt chỉ được tính khi
 * một thẻ CÙNG ĐỢT đã có mặt — Luyện Đan / Khoáng Mạch / Thí Luyện / Tế Lễ / Hỷ Sự, những
 * tên mà hạng nào cũng thấy. "Phúc lợi" KHÔNG dùng làm bằng chứng được: Phúc Lợi Đường nằm
 * ở đợt MỘT và sẽ bảo lãnh cho một đợt chưa hề tới.
 */
export function vipProbe() {
  if (!document.querySelector(".nv-quest")) return null;
  const norm = (s) =>
    (s == null ? "" : String(s)).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
  const text = norm(document.body ? document.body.innerText : "");
  if (!/(luyen dan|khoang mach|thi luyen|te le|hy su)/.test(text)) return null;
  return !!document.querySelector("#nv-pt-vip-quest");
}

/**
 * Còn thấy màn chắn Cloudflare không, và phiên WordPress đã đăng nhập chưa. `loggedIn` là
 * null khi trang không phát tín hiệu rõ ràng về phía nào.
 */
export function readinessProbe() {
  const html = (document.title + " " + (document.body ? document.body.innerText.slice(0, 500) : "")).toLowerCase();
  const cfText = /just a moment|checking your browser|verify you are human|attention required|cloudflare|needs to review the security/;
  const cfEls = document.querySelector(
    '#challenge-form, #challenge-running, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]',
  );
  const challenge = cfText.test(html) || !!cfEls;

  let loggedIn = null;
  if (!challenge) {
    const inMarker =
      (document.body && document.body.classList.contains("logged-in")) ||
      document.querySelector(
        '#wpadminbar, a[href*="logout"], a[href*="dang-xuat"], a[href*="thoat"], .logged-in-user, .user-panel, .member-info',
      );
    const outMarker = document.querySelector(
      '#loginform, form#loginform, .login-form, input#user_login, input[name="log"]',
    );
    if (inMarker) loggedIn = true;
    else if (outMarker) loggedIn = false;
  }
  return { challenge, loggedIn };
}

/**
 * Gom mọi link điều hướng trên trang — kể cả mục nằm trong dropdown đang thu (chúng vẫn ở
 * trong DOM dù bị ẩn) — để tìm trang của một nhiệm vụ bằng cách khớp tên nhiệm vụ với
 * chính menu của site. Link kiểu đăng xuất không bao giờ được trả về.
 */
export function menuProbe() {
  const nfc = (s) => (s && s.normalize ? s.normalize("NFC") : s || "");
  const norm = (s) => nfc(s).replace(/\s+/g, " ").trim();
  const badHref = /^(javascript:|#|mailto:|tel:)/i;
  const dangerous = /(logout|log-out|signout|sign-out|dang-xuat|dangxuat|thoat)/i;
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || "";
    if (!href || badHref.test(href) || dangerous.test(href)) continue;
    const text = norm(
      a.innerText || a.textContent || a.getAttribute("title") || a.getAttribute("aria-label") || "",
    );
    if (!text || text.length > 48 || dangerous.test(text)) continue;
    const key = text.toLowerCase() + "|" + href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
    if (out.length >= 300) break;
  }
  return out;
}

/** Lấy chữ hướng dẫn / mô tả / luật chơi của chính trang, để nhật ký ghi lại site nói gì. */
export function guideProbe() {
  const nfc = (s) => (s && s.normalize ? s.normalize("NFC") : s || "");
  const norm = (s) => nfc(s).replace(/\s+/g, " ").trim();
  const selectors = [
    ".guide", ".huong-dan", ".huongdan", ".instruction", ".instructions",
    ".rules", ".rule", ".mo-ta", ".mota", ".description", ".desc", ".intro", ".help",
    '[class*="guide"]', '[class*="huong"]', '[class*="rule"]', '[class*="intro"]', '[class*="note"]',
  ];
  const parts = [];
  for (const sel of selectors) {
    let list;
    try {
      list = document.querySelectorAll(sel);
    } catch (e) {
      continue;
    }
    for (const el of list) {
      const t = norm(el.innerText || el.textContent || "");
      if (t.length < 12 || t.length > 800) continue;
      if (parts.some((p) => p.includes(t) || t.includes(p))) continue;
      parts.push(t);
      if (parts.join(" ").length > 700) return parts.join(" | ").slice(0, 700);
    }
  }
  return parts.join(" | ").slice(0, 700);
}

/**
 * Đánh giá một StepCondition trên trang sống, trả về bool.
 *
 * "enabled" cố ý cũng từ chối class trông-như-disabled, vì nhiều UI game làm xám nút bằng
 * CSS chứ không bằng thuộc tính disabled.
 */
export function conditionProbe(arg) {
  // Real accent folding: NFD splits "ế" into e + combining marks which are then
  // dropped, and "đ" is mapped by hand because it has no decomposition. This is what
  // lets a step written as "ket thuc round" match "Kết thúc round".
  const norm = (s) =>
    (s == null ? "" : String(s))
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/đ/g, "d")
      .replace(/\s+/g, " ")
      .trim();

  const rendered = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const blocked = (el) => {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const cls = (el.getAttribute("class") || "").toLowerCase();
    return /(^|[\s_-])(disabled|is-disabled|btn-disabled|locked|inactive)([\s_-]|$)/.test(cls);
  };

  // Evaluated over EVERY element the selector matches, not just the first. A page can
  // keep sized, opacity-0 skeletons of its controls in the served shell (the furnace
  // does) and hidden twins earlier in DOM order — judging the first match alone reads
  // a skeleton and calls a perfectly visible control absent. "Is something matching
  // this visible/enabled?" is an ∃ question; "is it hidden/disabled?" is a ∀ one.
  const sel = arg && arg.selector ? String(arg.selector) : "";
  let els = [];
  if (sel) {
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch (e) {
      return false;
    }
  }

  // A named element that is not on the page can never match a text condition. This
  // used to fall back to scanning the whole page, which is how a probe for
  // "#mc-ht-daily-used → 385" once matched a player's "ATK 5.385" in a view that does
  // not render the counter at all. Only an EMPTY selector means "the whole page",
  // and that remains deliberate.
  if (sel && els.length === 0 && arg && (arg.kind === "textMatches" || arg.kind === "textNotMatches")) {
    return false;
  }

  // Text reads prefer the first RENDERED match, so a hidden twin cannot shadow the
  // live element's text.
  const scope = sel ? els.find(rendered) || els[0] || null : document.body;
  const text = norm(scope ? scope.innerText : "");

  // "a|b|c" is an OR over alternatives: textMatches asks "is ANY of these present",
  // textNotMatches asks "is NONE of these present" — which is what makes a block-list
  // gate expressible ("skip when the modal names a star being kept"). A single text
  // without '|' behaves exactly as before.
  const wanted = norm(arg ? arg.text : "");
  const alts = wanted.split("|").map((a) => a.trim()).filter((a) => a.length > 0);

  switch (arg ? arg.kind : "") {
    case "visible":
      return els.some(rendered);
    case "hidden":
      return !els.some(rendered);
    case "enabled":
      return els.some((e) => rendered(e) && !blocked(e));
    case "disabled":
      return els.length > 0 && els.every((e) => !rendered(e) || blocked(e));
    case "textMatches":
      return alts.length > 0 && alts.some((a) => text.includes(a));
    case "textNotMatches":
      return alts.length > 0 && !alts.some((a) => text.includes(a));
    default:
      return false;
  }
}

/**
 * Selector này có khớp phần tử nào trong DOM không — bất kể nó đang hiện hay đang ẩn.
 *
 * Đây là phép phân biệt「CHƯA VẼ」với「ĐÃ VẼ RỒI ẨN ĐI」, và hai thứ ấy trông y hệt nhau
 * dưới con mắt của `conditionProbe` kind `hidden`. Sự khác biệt không hề nhỏ: một nút đang
 * mang `display:none` là trang ĐÃ TRẢ LỜI (hết lượt, đang cooldown); một nút chưa có mặt
 * trong DOM là trang CHƯA NÓI GÌ CẢ. Xem ghi chú ở `stopIf` bên engine để biết cái giá của
 * việc lẫn lộn hai điều đó.
 *
 * Selector hỏng đọc là 0 — cùng luật với mọi probe khác: cú pháp sai không được phép ném ra
 * giữa một lượt chạy, nó chỉ có nghĩa là「không thấy gì」.
 */
export function selectorPresence(arg) {
  const sel = arg && arg.selector ? String(arg.selector) : "";
  if (!sel) return 0;
  try {
    return document.querySelectorAll(sel).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Dựng mã nguồn cho một lượt CHỜ TRONG TRANG: MutationObserver đánh giá lại điều kiện ngay
 * tại khoảnh khắc DOM đổi, nên cái chờ thức dậy ĐÚNG LÚC sự kiện xảy ra thay vì ở nhịp poll
 * kế tiếp. Trả `true` ngay khi điều kiện đúng, `false` khi hết `ceilingMs`.
 *
 * Đây là bản thay cho vòng poll 300ms cũ, và khác biệt không phải tiện nghi mà là đúng-sai:
 * một trạng thái tồn tại ngắn hơn một nhịp poll — một hàng roster loé qua sảnh, một cái nút
 * mở khoá trong chớp mắt giữa hai lần re-render — poll lấy mẫu thì không bao giờ thấy, còn
 * observer thì được gọi ngay tại mutation. Mê Cung dựng gần như toàn bộ bằng những cái chờ
 * này, và "tool nhìn hụt" ở quest đó là bốn người chơi thật mất lượt oan.
 *
 * Trả về CHUỖI mã (đã nhúng sẵn tham số) chứ không phải hàm: hàm serialize sang trang sẽ
 * mất closure nên không ôm được `conditionProbe`; còn Playwright bản JS thì không truyền
 * arg cho script dạng chuỗi. Nhúng probe + tham số vào nguồn là đường duy nhất đi qua cả
 * hai ràng buộc. Tick 400ms là lưới an toàn cho thay đổi hiếm hoi không kèm mutation;
 * observer mới là đường nhanh. Người gọi giữ timeout TỔNG và cắt lát lượt chờ này (xem
 * engine) để lệnh dừng và ngân sách bước luôn cầm quyền.
 */
export function conditionWaitSource(condition, ceilingMs) {
  const arg = {
    selector: condition.selector ?? null,
    kind: condition.kind,
    text: condition.text ?? null,
    ceilingMs: Math.max(50, Math.floor(ceilingMs)),
  };

  return `((arg) => {
    const probe = ${conditionProbe.toString()};

    return new Promise((resolve) => {
      let done = false;
      let obs = null, tick = null, cap = null;

      const finish = (verdict) => {
        if (done) return;
        done = true;
        if (obs) { try { obs.disconnect(); } catch (e) {} }
        if (tick) clearInterval(tick);
        if (cap) clearTimeout(cap);
        resolve(verdict);
      };

      // Probe sập (node bị gỡ giữa mutation) phải đọc là "chưa", không bao giờ là một
      // observer chết: mutation kế tiếp cứ thế kiểm lại.
      const check = () => { try { if (probe(arg)) finish(true); } catch (e) {} };

      obs = new MutationObserver(check);
      obs.observe(document.documentElement,
        { childList: true, subtree: true, attributes: true, characterData: true });
      tick = setInterval(check, 400);
      cap = setTimeout(() => finish(false), arg.ceilingMs);
      check(); // điều kiện đã đúng sẵn thì không được bắt nó đợi một mutation
    });
  })(${JSON.stringify(arg)})`;
}

/**
 * Đọc một câu hỏi trắc nghiệm: đề bài cùng mọi đáp án theo đúng thứ tự đang hiển thị. Thứ
 * tự chỉ đúng cho riêng câu này — site xáo lại ở câu sau — nên chỉ số trả về có giá trị cho
 * tới khi có gì đó được bấm, không lâu hơn.
 */
export function quizProbe(arg) {
  const rendered = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const blocked = (el) => {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const cls = (el.getAttribute("class") || "").toLowerCase();
    return /(^|[\s_-])(disabled|is-disabled|locked|inactive)([\s_-]|$)/.test(cls);
  };

  const qs = arg && arg.question ? String(arg.question) : "";
  const os = arg && arg.options ? String(arg.options) : "";
  const out = { question: "", options: [], enabled: [] };

  try {
    const q = qs ? document.querySelector(qs) : null;
    out.question = q && rendered(q) ? (q.innerText || "").trim() : "";

    const opts = os ? Array.from(document.querySelectorAll(os)) : [];
    for (const el of opts) {
      if (!rendered(el)) continue;
      out.options.push((el.innerText || "").trim());
      out.enabled.push(!blocked(el));
    }
  } catch (e) {
    /* a bad selector reports as "nothing found", not as a crash */
  }

  return out;
}

/**
 * Sau khi trả lời, site đánh dấu đáp án đúng. Đọc lại nó là cách DUY NHẤT để kho đáp án lớn
 * lên — và nó đúng bất kể câu vừa trả lời sai hay đúng, vì dấu ấy rơi vào đáp án đúng trong
 * cả hai trường hợp.
 */
export function quizCorrectAnswer(arg) {
  const os = arg && arg.options ? String(arg.options) : "";
  let opts = [];
  try {
    opts = os ? Array.from(document.querySelectorAll(os)) : [];
  } catch (e) {
    return "";
  }

  for (const el of opts) {
    const cls = (el.getAttribute("class") || "").toLowerCase();
    // Word-boundary match: "incorrect" and "correct-answer" must not be confused, and a
    // class named exactly "incorrect" would otherwise contain "correct".
    if (/(^|[\s_-])correct([\s_-]|$)/.test(cls)) {
      return (el.innerText || "").trim();
    }
  }

  return "";
}
