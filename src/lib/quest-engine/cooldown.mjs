/**
 * Đọc thời gian còn lại ra giây từ chữ tự do: "01:23:45", "12:30", "còn 2 giờ 5 phút",
 * "30 giây". Trả về null khi không tìm thấy khoảng thời gian nào.
 *
 * Port từ `CooldownTextParser.cs`. Thứ tự thử là phần quan trọng: dạng đồng hồ được ưu tiên
 * tuyệt đối, và "hh:mm:ss" phải thử TRƯỚC "mm:ss" — nếu không, "01:23:45" sẽ khớp "01:23"
 * và một tiếng rưỡi biến thành tám mươi ba phút.
 *
 * Bản in-page trong labelMatchSweep là cùng một thuật toán viết lại cho DOM; hai bên phải
 * đi cùng nhau.
 *
 * ĐỪNG THAY LOOKAHEAD BẰNG `\b`. Bản C# dùng `\b` và đúng, vì `\w` của .NET nhận cả chữ
 * Unicode; `\b` của JavaScript thì chỉ biết [A-Za-z0-9_], nên sau chữ "giờ" — kết thúc bằng
 * "ờ" — nó KHÔNG thấy ranh giới nào và "2 giờ 5 phút" lặng lẽ đọc ra 5 phút. Hậu quả không
 * phải một ngoại lệ mà là một lịch sai: quay lại lò sớm hai tiếng, lần nào cũng vậy.
 */
const NOT_LETTER_OR_DIGIT = /(?![\p{L}\p{N}])/u.source;
const unit = (pattern) => new RegExp(`(\\d+)\\s*(?:${pattern})${NOT_LETTER_OR_DIGIT}`, "u");
export function parseCooldownSeconds(text) {
  if (!text || !text.trim()) {
    return null;
  }

  const t = text.toLowerCase();

  const hms = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }

  // `(?!:)` giữ cho nhánh này không nuốt mất hai nhóm đầu của một chuỗi hh:mm:ss.
  const ms = t.match(/(\d{1,2}):(\d{2})(?!:)/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }

  let total = 0;
  let matched = false;

  const hours = t.match(unit("giờ|gio|hour|hrs|hr|h"));
  if (hours) {
    total += Number(hours[1]) * 3600;
    matched = true;
  }

  const minutes = t.match(unit("phút|phut|minutes|minute|mins|min|m"));
  if (minutes) {
    total += Number(minutes[1]) * 60;
    matched = true;
  }

  const seconds = t.match(unit("giây|giay|seconds|second|secs|sec|s"));
  if (seconds) {
    total += Number(seconds[1]);
    matched = true;
  }

  return matched ? total : null;
}

/**
 * Chọn lúc ghé lại sớm nhất từ kết quả của cả vòng — port thẳng từ CooldownPlanner.cs.
 *
 * Failure không được phép làm lịch chạy dồn dập hơn: nếu mọi quest đều hỏng và chẳng đọc
 * được đồng hồ nào, nghỉ nửa giờ. Một vòng không có đồng hồ nhưng cũng không hỏng thì năm
 * phút ghé lại. Jitter nhỏ giữ nhiều khôi lỗi khỏi cùng thức dậy đúng một giây.
 */
const WAIT_FLOOR_SECONDS = 30;
const WAIT_CEILING_SECONDS = 24 * 3600;
const NO_TIMER_RETRY_SECONDS = 300;
const FAILED_ONLY_RETRY_SECONDS = 1800;
const JITTER_SECONDS = 25;

export function computeNextDelaySeconds(results, { cycleFailed = false, random = Math.random } = {}) {
  let soonest = null;
  let anyFailed = cycleFailed;

  for (const result of results ?? []) {
    if (result?.outcome === "failed") anyFailed = true;

    const seconds = Number(result?.cooldownSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      soonest = soonest == null ? seconds : Math.min(soonest, seconds);
    }
  }

  const baseSeconds = soonest ?? (anyFailed ? FAILED_ONLY_RETRY_SECONDS : NO_TIMER_RETRY_SECONDS);
  const jitter = Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * (JITTER_SECONDS + 1));
  return Math.max(WAIT_FLOOR_SECONDS, Math.min(WAIT_CEILING_SECONDS, Math.round(baseSeconds) + jitter));
}
