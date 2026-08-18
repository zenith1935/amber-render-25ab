/**
 * Lời gọi `/api/worker` BIẾT ĐI THEO bảng điều phối.
 *
 * Sinh ra từ lượt diễn tập chuyển trạm 10/08/2026, nơi §8 của deploy/mirror/README.md lộ ra là
 * chưa từng được viết: web đã sang trạm gương, người dùng vẫn vào được, nhưng khôi lỗi tông môn
 * trên VM cứ nện vào trạm cũ để nhận 409 rồi vứt đi — `WEB_URL` là hằng số trong env của nó.
 * Đàn nằm im cho tới khi có người sửa tay. Đo được: `tong-mon-khoiloi` điểm danh lần cuối lúc
 * 16:54, im suốt 20 phút, chỉ sống lại khi bảng tình cờ lật về đúng chỗ nó đang trỏ.
 *
 * ĐI THEO 409, KHÔNG TỰ ĐỌC BẢNG. Đọc bảng thì phải xác minh chữ ký, mà khoá ký là
 * `WORKER_TOKEN` của deployment — khôi lỗi máy nhà cầm linh phù cá nhân thì không có nó, nên
 * cả một nhánh khôi lỗi sẽ không dùng được. Còn 409 thì trạm đã nghỉ phát cho MỌI khôi lỗi,
 * kèm sẵn `activeUrl` lấy từ bảng nó vừa xác minh. Một đường, dùng chung cho cả hai vai.
 *
 * PHÂN BIỆT HAI LOẠI 409 — đây là chỗ dễ vào sai nhất. `/api/worker` cũng trả 409 cho
 * 「job is no longer active」. Nên dấu hiệu để đi theo KHÔNG PHẢI mã trạng thái mà là **có một
 * `activeUrl` https hợp lệ và khác chỗ đang đứng**. Thiếu bất kỳ vế nào thì đây là lỗi thật,
 * ném nguyên văn lên như cũ.
 *
 * KHÔNG GHI NHỚ XUỐNG ĐĨA. Khởi động lại là đọc `WEB_URL` từ env rồi lại đi theo 409 lần đầu
 * gặp — hệ tự lành, và không có tệp trạng thái nào để lệch với bảng.
 *
 * Giới hạn nói thẳng: trạm cũ chết HẲN thì không ai phát 409, khôi lỗi sẽ gõ cửa một xác chết
 * mãi mãi. Đó đúng là giới hạn §11 đã ghi, và lời giải của nó là một custom domain, không phải
 * thêm mã ở đây.
 */

/** Trạm đã nghỉ trả mã này kèm `activeUrl`. Trùng mã với「job is no longer active」— xem trên. */
const CONFLICT = 409;

/** Bỏ dấu `/` cuối để so sánh hai địa chỉ không vấp vào khác biệt vô nghĩa. */
export function normalizeBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

/**
 * Rút `activeUrl` khỏi thân một phản hồi 409, hoặc `null` nếu không có gì đáng đi theo.
 *
 * Chỉ nhận `https://` — và đây không phải sự cẩn thận trang trí: khôi lỗi gửi token của nó
 * theo MỌI request, nên địa chỉ nền là thứ quyết định token đi về đâu. Bảng điều phối chỉ
 * chứa https (control/doc.ts ép bằng schema), nên siết ở đây không bỏ sót ca hợp lệ nào.
 */
export function parseActiveUrl(bodyText) {
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const raw = typeof data?.activeUrl === "string" ? normalizeBase(data.activeUrl) : "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ? raw : null;
}

/**
 * Dựng hàm `call` cho một khôi lỗi.
 *
 * `fetchImpl` và `log` tiêm được để `verify:worker-follow` lái toàn bộ nhánh mà không cần
 * mạng — bài học của chính buổi này: một luật chỉ chạy đúng ngày chuyển trạm mà không có phép
 * kiểm thì nó sẽ sai vào đúng ngày ấy.
 */
export function createWorkerCall({ webUrl, token, fetchImpl = fetch, log = console.log }) {
  let base = normalizeBase(webUrl);

  const call = async (op, payload = {}, { allowFollow = true } = {}) => {
    const res = await fetchImpl(`${base}/api/worker`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ op, ...payload }),
    });

    if (!res.ok) {
      // Đọc thân MỘT LẦN: `res.text()` rồi `res.json()` trên cùng phản hồi là lỗi "body đã dùng".
      const text = await res.text();

      if (res.status === CONFLICT && allowFollow) {
        const next = parseActiveUrl(text);
        // `next === base` nghĩa là trạm này tự nhận đã nghỉ nhưng lại chỉ về chính nó — một
        // mâu thuẫn (SITE_ID lệch bảng?) mà đi theo cũng không giải được. Ném lên để thấy.
        if (next && next !== base) {
          log(`Trạm hoạt động đã đổi: ${base} → ${next}. Đi theo bảng điều phối.`);
          base = next;
          // Đúng MỘT lần thử lại. Trạm mới cũng trả 409 thì đó là lỗi thật (hoặc hai trạm đang
          // ping-pong trong lúc cache bảng nguội) — ném lên, vòng lặp ngoài sẽ hỏi lại sau.
          return call(op, payload, { allowFollow: false });
        }
      }

      throw new Error(`${op} → HTTP ${res.status} ${text}`);
    }

    return res.json();
  };

  return { call, currentUrl: () => base };
}
