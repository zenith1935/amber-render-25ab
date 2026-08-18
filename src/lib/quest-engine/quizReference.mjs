/**
 * Kho tham khảo Vấn Đáp — port từ QuizReferenceDirectory.cs của bản PC.
 *
 * PC không nhét cứng vài trăm câu vào binary. Nó tải toàn bộ bảng cộng đồng về máy, cache
 * 12 giờ rồi tự so khớp cục bộ. Nhờ vậy câu hỏi đang hiện không bị gửi lên một API tìm kiếm,
 * một lần tải phục vụ mọi account trên cùng worker, và thứ tự đáp án bị site xáo không gây
 * bấm nhầm: chỉ TEXT của đáp án mới có ý nghĩa.
 *
 * Đây là nguồn DUY NHẤT của bản web. Không có Gemini, không đoán ngẫu nhiên. Một câu không
 * có trong bảng, một đáp án không nằm trong bốn lựa chọn hiện tại, hay hai người đóng góp
 * đưa hai đáp án khác nhau đều trả null để engine giữ lại lượt cho người dùng.
 */

import { foldText } from "./session.mjs";

export const DEFAULT_QUIZ_REFERENCE_URL =
  "https://hh3d.phucthienlang.vn/user_search.php";

export const QUIZ_REFERENCE_FRESHNESS_MS = 12 * 60 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 20_000;
const ROW_PATTERN =
  /<tr>\s*<td>\s*\d+\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
const TAG_PATTERN = /<[^>]+>/g;
const LEADING_NUMBER_PATTERN = /^\s*\d+\s*[.)]\s*/;
const TRAILING_NOTE_PATTERN = /\s*\([^)]*\)\s*$/;

const NAMED_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

const NOOP_LOG = Object.freeze({
  info() {},
  warning() {},
  debug() {},
});

function decodeHtml(value) {
  return String(value ?? "").replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
    (whole, token) => {
      const lower = String(token).toLowerCase();
      let codePoint = null;

      if (lower.startsWith("#x")) codePoint = Number.parseInt(lower.slice(2), 16);
      else if (lower.startsWith("#")) codePoint = Number.parseInt(lower.slice(1), 10);
      else return NAMED_ENTITIES[lower] ?? whole;

      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    },
  );
}

function cleanCell(value) {
  return decodeHtml(String(value ?? "").replace(TAG_PATTERN, " "))
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * HTML bảng → Map(câu hỏi đã fold → mọi đáp án khác nhau được công bố).
 * Public để smoke kiểm parser mà không phụ thuộc mạng.
 */
export function parseQuizReferenceHtml(html) {
  const entries = new Map();

  for (const row of String(html ?? "").matchAll(ROW_PATTERN)) {
    const question = cleanCell(row[1]);
    const answer = cleanCell(row[2]).replace(LEADING_NUMBER_PATTERN, "").trim();
    const key = foldText(question);
    if (!key || !answer) continue;

    const answers = entries.get(key) ?? [];
    if (!answers.some((known) => known.toLowerCase() === answer.toLowerCase())) {
      answers.push(answer);
    }
    entries.set(key, answers);
  }

  return entries;
}

/** Một chuỗi từ nằm trọn trong chuỗi kia, theo RANH GIỚI TỪ — "an" không khớp vào "khong". */
function containsWords(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Khớp đáp án công bố với một trong các lựa chọn trên trang.
 *
 * Ba nấc, nới dần, và nấc nào cũng phải trỏ về ĐÚNG MỘT lựa chọn:
 *   1. khớp tuyệt đối sau khi gấp chữ;
 *   2. khớp lại sau khi bỏ ghi chú cuối `(…)` mà người soạn danh sách thêm vào;
 *   3. một bên chứa trọn bên kia theo ranh giới từ.
 *
 * Nấc 3 sinh ra từ một ca thật ngày 09/08/2026: trang bày “Tất cả đáp án”, danh sách ghi
 * “Tất cả đáp án trên (ĐCT, VĐCK, ĐPTK)”. Bỏ ghi chú xong vẫn còn thừa đúng chữ “trên”, nên
 * hai nấc đầu đều trượt — và vì đó là câu SỐ MỘT, cả bài vấn đáp của tài khoản VIP chết đứng
 * ở mọi lượt suốt hơn một giờ.
 *
 * Vì sao nấc này KHÔNG phải là đoán bừa: nó đòi biên giới từ (nên “an” không chui vào
 * “khong”), và người gọi chỉ nhận kết quả khi TOÀN BỘ phép khớp trỏ về đúng một lựa chọn —
 * mơ hồ thì `find` trả `null` và bài dừng, y như cũ. Trả lời sai tiêu một lượt trong ngày,
 * nên thà không trả lời còn hơn trả lời liều.
 */
function matchOption(options, publishedAnswer) {
  const find = (wanted) => {
    if (!wanted) return null;
    for (const option of options) {
      if (foldText(option) === wanted) return option;
    }
    return null;
  };

  const exact = foldText(publishedAnswer);
  const direct = find(exact);
  if (direct) return direct;

  const withoutNote = foldText(
    String(publishedAnswer ?? "").replace(TRAILING_NOTE_PATTERN, ""),
  );
  if (withoutNote && withoutNote !== exact) {
    const stripped = find(withoutNote);
    if (stripped) return stripped;
  }

  const wanted = withoutNote || exact;
  if (!wanted) return null;

  const nested = options.filter((option) => {
    const folded = foldText(option);
    return containsWords(wanted, folded) || containsWords(folded, wanted);
  });

  return nested.length === 1 ? nested[0] : null;
}

function writeLog(log, level, message) {
  const target = log && typeof log[level] === "function" ? log : NOOP_LOG;
  target[level]("Quiz", message);
}

function short(value) {
  const text = String(value ?? "");
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}

/**
 * Một directory có cache riêng. Production dùng singleton bên dưới; test tạo bản cô lập và
 * tiêm fetch/clock giả để ghim mọi ngả mà không chạm Internet.
 */
export function createQuizReferenceDirectory({
  fetchImpl = globalThis.fetch,
  freshnessMs = QUIZ_REFERENCE_FRESHNESS_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  let entries = new Map();
  let loadedAt = 0;
  let loadedFrom = "";
  let loading = null;
  // Cảnh báo tính theo TỪNG nhật ký (mỗi job một object log riêng), không phải một lần cho
  // cả tiến trình: worker giờ chạy nhiều job đồng thời, và job đầu tiên "tiêu" mất cảnh báo
  // thì các tài khoản còn lại vĩnh viễn không biết vì sao Vấn Đáp bỏ lại câu hỏi cho họ.
  let warnedLogs = new WeakSet();
  // Sau một lượt tải hỏng, nghỉ một lúc thay vì để MỖI câu hỏi của MỖI job lại kích một
  // lượt tải mới và ôm timeout tới 20 giây mỗi câu.
  let failedAt = 0;
  const FAILURE_RETRY_MS = 60_000;

  const isFresh = (url) =>
    entries.size > 0 &&
    loadedFrom.toLowerCase() === url.toLowerCase() &&
    now() - loadedAt < freshnessMs;

  const warnOnce = (log, message) => {
    if (warnedLogs.has(log)) return;
    warnedLogs.add(log);
    writeLog(log, "warning", message);
  };

  const download = async (url) => {
    if (typeof fetchImpl !== "function") throw new Error("môi trường worker không có fetch");

    const controller = new AbortController();
    const timer = timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error("hết thời gian tải")), timeoutMs)
      : null;

    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { "user-agent": "JarvisHH3D-Worker/quiz-reference" },
      });
      if (!response || response.ok === false) {
        throw new Error(`HTTP ${response?.status ?? "?"}`);
      }
      return await response.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const ensureLoaded = async (url, log) => {
    if (isFresh(url)) return entries;

    // Nhiều account chạm câu đầu cùng lúc vẫn chỉ tải một bản. Sau khi đợi, kiểm lại URL:
    // một worker có thể được đổi QUIZ_DIRECTORY_URL giữa hai vòng.
    if (loading) await loading;
    if (isFresh(url)) return entries;

    // Nguồn vừa hỏng thì đừng gõ cửa lại ngay — trả về những gì đang có (kể cả rỗng) và
    // để lượt sau FAILURE_RETRY_MS thử lại. Vẫn nhắc mỗi nhật ký một lần vì sao thiếu đáp án.
    if (failedAt && now() - failedAt < FAILURE_RETRY_MS) {
      warnOnce(log, "Danh sách đáp án đang không đọc được — câu chưa biết sẽ để lại cho bạn.");
      return entries;
    }

    loading = (async () => {
      try {
        const html = await download(url);
        const parsed = parseQuizReferenceHtml(html);
        if (parsed.size === 0) {
          failedAt = now();
          warnOnce(log, `Danh sách đáp án tại ${url} không có dòng nào đọc được.`);
          return entries;
        }

        entries = parsed;
        loadedAt = now();
        loadedFrom = url;
        failedAt = 0;
        warnedLogs = new WeakSet();
        writeLog(log, "info", `Đã nạp ${parsed.size} câu từ danh sách tham khảo.`);
        return entries;
      } catch (error) {
        failedAt = now();
        warnOnce(
          log,
          `Không đọc được danh sách đáp án (${error instanceof Error ? error.message : String(error)}). Câu chưa biết sẽ để lại cho bạn.`,
        );
        return entries;
      }
    })();

    try {
      return await loading;
    } finally {
      loading = null;
    }
  };

  return {
    /**
     * @param {{text:string, options:string[]}} question
     * @param {{url?:string, log?:object}} options
     */
    async find(question, { url = DEFAULT_QUIZ_REFERENCE_URL, log = NOOP_LOG } = {}) {
      const offered = Array.isArray(question?.options)
        ? question.options.map((option) => String(option ?? ""))
        : [];
      const sourceUrl = String(url ?? "").trim();
      if (!question?.text?.trim() || offered.length === 0 || !sourceUrl) return null;

      const current = await ensureLoaded(sourceUrl, log);
      const published = current.get(foldText(question.text));

      // Mỗi ngả trả `null` dưới đây đều KỂ RA vì sao, ở mức `warning` để nó tới được
      // `job_events` — thứ dashboard hiển thị.
      //
      // Vì sao đáng mấy dòng này: một câu không tra được sẽ DỪNG cả bài vấn đáp, và trước
      // bản này nhật ký chỉ nói "chưa biết đáp án: <câu hỏi>". Ngày 09/08/2026 một tài khoản
      // VIP tắc ở đúng một câu suốt nhiều lượt liền; câu ấy CÓ trong danh sách, nên chỗ hỏng
      // nằm ở bước khớp chữ — mà bốn lựa chọn trên trang thì không được ghi lại ở đâu cả.
      // Phải tra ngược danh sách bằng tay mới biết. Cái vắng mặt vốn không tự nói: ghi ra
      // đây thì lần tắc sau tự chỉ đích danh chữ nào lệch chữ nào.
      if (!(published?.length > 0)) {
        writeLog(
          log,
          "warning",
          `“${short(question.text)}” chưa có trong danh sách tham khảo.`,
        );
        return null;
      }

      const matched = new Set();
      for (const answer of published) {
        const option = matchOption(offered, answer);
        if (option) matched.add(option);
      }

      if (matched.size !== 1) {
        writeLog(
          log,
          "warning",
          matched.size > 1
            ? `Danh sách tự mâu thuẫn ở “${short(question.text)}” — không chọn bừa.`
            : `“${short(question.text)}” có trong danh sách nhưng không khớp lựa chọn nào. ` +
              `Danh sách ghi: ${published.map((a) => `“${short(a)}”`).join(" | ")}. ` +
              `Trang đang bày: ${offered.map((o) => `“${short(o)}”`).join(" | ")}.`,
        );
        return null;
      }

      const option = [...matched][0];
      return {
        option,
        index: offered.indexOf(option),
        source: "danh sách tham khảo",
      };
    },

    get count() {
      return entries.size;
    },
  };
}

// Một tiến trình worker chạy tuần tự và phục vụ nhiều vòng/account. Singleton này là lý do
// danh sách chỉ bị tải một lần mỗi 12 giờ thay vì một lần mỗi câu hoặc mỗi job.
const sharedDirectory = createQuizReferenceDirectory();

/** Adapter đúng contract `quiz` mà createQuestEngine nhận. Không có Gemini; learn cố ý no-op. */
export function createReferenceQuiz({
  url = DEFAULT_QUIZ_REFERENCE_URL,
  log = NOOP_LOG,
  directory = sharedDirectory,
} = {}) {
  return {
    resolve(question) {
      return directory.find(question, { url, log });
    },

    async learn() {
      // Danh sách tham khảo không phải kho đã-xác-nhận. PC cũng không ghi một hit từ nguồn này
      // vào answer bank; bản web hiện chưa có kho bền riêng, nên không giả vờ rằng nó đã học.
    },
  };
}
