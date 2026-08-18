/**
 * Đóng trình duyệt cho BẰNG ĐƯỢC sau mỗi vòng, và không bao giờ ném.
 *
 * VÌ SAO CẦN MỘT TỆP RIÊNG CHO MỘT VIỆC NGHE ĐƠN GIẢN NHƯ "ĐÓNG":
 *
 * `await context.close().catch(() => {})` — bản trước — nuốt được lời hứa BỊ TỪ CHỐI, nhưng
 * KHÔNG cứu nổi một lời hứa KHÔNG BAO GIỜ NGÃ NGŨ. Mà `close()` của Playwright treo được
 * thật: nó chờ trình duyệt đáp lời qua pipe, và một Chromium đã đơ thì không đáp gì cả.
 *
 * Hậu quả không phải là "rò rỉ một tí bộ nhớ", nó nặng hơn nhiều:
 *
 *   1. `finally` của runCycle không bao giờ về → `handle(job)` trong worker không bao giờ
 *      settle → GHẾ KHÔNG ĐƯỢC NHẢ. Đủ `WORKER_MAX_JOBS` lần là khôi lỗi tê liệt hoàn toàn,
 *      im lặng, không một dòng lỗi nào.
 *   2. Chromium treo vẫn GIỮ KHOÁ trên `--user-data-dir`. Vòng sau của đúng tài khoản ấy mở
 *      cùng hồ sơ sẽ hỏng ngay từ lúc launch — và người dùng chỉ thấy "đàn pháp gặp trắc trở".
 *
 * Trên VM, `KillMode=control-group` của systemd có dọn sạch mọi thứ — nhưng CHỈ khi service
 * restart. Đo ngày 09/08/2026: `NRestarts=0`, tức lưới an toàn ấy chưa từng được dùng tới một
 * lần nào. Không thể trông vào nó.
 *
 * PHÉP GIẾT ĐI ĐƯỜNG `/proc`, KHÔNG QUA PLAYWRIGHT — đây là chỗ đáng ghi lại:
 * Playwright KHÔNG có `browser.process()` (đó là API của Puppeteer; đã đo trên playwright-core
 * 1.62: `browser.process is not a function` ở cả hai nhánh launch). PID chỉ lấy được qua
 * `launchServer()`, thứ không có bản persistent-context nên engine không dùng được. Nên muốn
 * biết PID thì phải hỏi hệ điều hành, và dấu vết để nhận diện là `--user-data-dir=<hồ sơ>`:
 * mỗi (người dùng + cookie) một hồ sơ riêng nên chuỗi ấy là duy nhất tuyệt đối.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Hạn cho mỗi lượt `close()`. 8 giây: một lần đóng lành mạnh xong trong vài trăm ms, còn số
 * này rộng rãi đủ để không cắt ngang một máy đang nghẽn I/O.
 */
const CLOSE_TIMEOUT_MS = 8_000;

/** Chờ giữa SIGTERM và SIGKILL — cho Chromium một nhịp tự đi trước khi bị lôi đi. */
const SIGTERM_GRACE_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chờ một lời hứa trong hạn, và PHÂN BIỆT ba kết cục — đây là phần quan trọng nhất của tệp.
 *
 * "failed" (close ném) KHÁC "timeout" (close treo), và chỉ "timeout" mới đáng giết: một lời
 * hứa đã ngã ngũ nghĩa là Playwright đã chạy xong đường dọn của nó, dù kết quả có lỗi. Giết
 * dựa trên một cái ném là hành động mạnh dựa trên bằng chứng yếu.
 *
 * Không huỷ được lời hứa đang treo (JS không có phép ấy) — ta chỉ thôi đứng đợi nó.
 */
async function settleWithin(work, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work.then(() => "closed", () => "failed"), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tiến trình còn sống không. Tín hiệu 0 không gửi gì, nó chỉ hỏi. */
function stillAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM cũng rơi vào đây: tiến trình CÓ tồn tại nhưng không đụng được. Với phép dọn thì
    // hai chuyện ấy dẫn tới cùng một hành động — bỏ qua.
    return false;
  }
}

/**
 * Những tiến trình đang mở ĐÚNG hồ sơ này, tra từ `/proc`.
 *
 * So sánh BẰNG NHAU trên đường dẫn đã chuẩn hoá, không phải `startsWith`: hai hồ sơ
 * `account-ab…` và `account-ab…cd` có thể là tiền tố của nhau, và một phép so lỏng ở đây
 * nghĩa là giết trình duyệt của một tài khoản khác đang chạy ngon lành.
 *
 * Mọi lỗi đọc đều bỏ qua có chủ ý: `/proc/<pid>` biến mất giữa chừng là chuyện thường (tiến
 * trình vừa thoát), và một tiến trình của user khác trả EACCES cũng không phải việc của ta.
 */
async function pidsUsingProfile(profileDir) {
  const want = path.resolve(profileDir);
  const found = [];

  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return found;
  }

  for (const entry of entries) {
    // Chỉ những mục là SỐ mới là tiến trình; `/proc` còn đầy thứ khác (self, meminfo, …).
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // Không bao giờ tự giết mình. cmdline của node không chứa `--user-data-dir` nên nhánh này
    // gần như không thể xảy ra — nhưng "gần như" không phải là "không" khi lệnh là SIGKILL.
    if (pid === process.pid) continue;

    let cmdline;
    try {
      cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }

    // cmdline ngăn nhau bằng NUL và thường có một NUL thừa ở cuối.
    for (const arg of cmdline.split("\0")) {
      if (!arg.startsWith("--user-data-dir=")) continue;
      if (path.resolve(arg.slice("--user-data-dir=".length)) === want) found.push(pid);
    }
  }

  return found;
}

/**
 * Giết những Chromium còn ôm hồ sơ này. Trả về số tiến trình đã tắt được.
 *
 * SIGTERM trước rồi mới SIGKILL: `close()` treo KHÔNG chứng minh được tiến trình điếc với
 * tín hiệu — nó chỉ chứng minh giao thức của Playwright không đi tới đâu. Cho SIGTERM một
 * nhịp thì Chromium còn kịp dọn hồ sơ tử tế; nhảy thẳng vào SIGKILL là bỏ mất cơ hội ấy.
 */
async function killProfileHolders(profileDir, log) {
  const pids = await pidsUsingProfile(profileDir);
  if (pids.length === 0) {
    log.debug("Trình duyệt", "Đóng hụt hạn nhưng không thấy tiến trình nào giữ hồ sơ — coi như đã tắt.");
    return 0;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Đã chết giữa chừng, hoặc không đủ quyền. Nhịp kiểm bên dưới nói lời cuối.
    }
  }

  await sleep(SIGTERM_GRACE_MS);

  let stopped = 0;
  for (const pid of pids) {
    if (!stillAlive(pid)) {
      stopped++;
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Như trên.
    }
    if (!stillAlive(pid)) stopped++;
  }

  if (stopped === pids.length) {
    log.warning("Trình duyệt", `Đóng hụt hạn — đã dứt điểm ${stopped} tiến trình còn ôm hồ sơ.`);
  } else {
    log.warning(
      "Trình duyệt",
      `Đóng hụt hạn — dứt được ${stopped}/${pids.length} tiến trình; số còn lại nằm ngoài tầm với.`,
    );
  }
  return stopped;
}

/**
 * Đóng context (và browser nếu có) trong hạn giờ; hụt hạn thì lôi tiến trình đi.
 *
 * KHÔNG BAO GIỜ NÉM — đây là đường dọn dẹp, nó chạy trong `finally` của một lượt chạy đã có
 * kết quả thật, và một trình duyệt cứng đầu không được phép ghi đè lên kết quả ấy.
 *
 * Phép giết chỉ chạy khi có ĐỦ HAI điều: nền tảng Linux (có `/proc` để tra) và hồ sơ bền (có
 * chuỗi để nhận diện). Nhánh không hồ sơ — smoke test, các lượt một-lần — chỉ được hưởng hạn
 * giờ; chấp nhận có ý thức, vì chúng chạy trên máy có người ngồi cạnh chứ không phải một VM
 * canh việc suốt ngày đêm.
 */
export async function closeBrowserWithin({ context, browser, profileDir, log }) {
  const outcome = await settleWithin(context.close(), CLOSE_TIMEOUT_MS);
  if (outcome === "failed") {
    log.debug("Trình duyệt", "Đóng phiên có lỗi — bỏ qua, lượt chạy đã có kết quả.");
  }

  // Với hồ sơ bền thì context CHÍNH LÀ browser, nên `browser` chỉ khác null ở nhánh kia.
  if (browser) {
    const browserOutcome = await settleWithin(browser.close(), CLOSE_TIMEOUT_MS);
    if (browserOutcome === "timeout") {
      log.warning("Trình duyệt", "Đóng trình duyệt hụt hạn — không có hồ sơ để truy tiến trình.");
    }
    return;
  }

  if (outcome !== "timeout") return;
  if (process.platform !== "linux" || !profileDir) {
    log.warning(
      "Trình duyệt",
      "Đóng phiên hụt hạn; nền này không tra được tiến trình nên đành để lại — hãy để mắt.",
    );
    return;
  }

  await killProfileHolders(profileDir, log);
}
