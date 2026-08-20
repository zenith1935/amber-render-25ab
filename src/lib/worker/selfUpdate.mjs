/**
 * Luật「khôi lỗi có nên tự thay gói không」— thuần, không đĩa, không mạng.
 *
 * Tách ra khỏi `worker.mjs` vì đây là phần DUY NHẤT của tính năng tự cập nhật kiểm được mà
 * không cần một cái máy thật: phần còn lại là PowerShell/sh trong vòng nuôi. Cái gì kiểm được
 * thì phải kiểm, và phải kiểm ở chỗ nó không cần dựng cả thế giới lên.
 *
 * ── VÌ SAO SO BẰNG PHÉP BẰNG, KHÔNG SO「MỚI HƠN/CŨ HƠN」───────────────────────────────────
 *
 * Cùng lẽ đã ghi ở `version.ts`: trạm đang phục vụ có thể là trạm gương mang bản CŨ hơn gói
 * khôi lỗi đang chạy. Một phép so thứ tự sẽ bảo「ta mới hơn, khỏi làm gì」và khôi lỗi đứng
 * lệch với trạm nó đang nói chuyện — đúng thứ tính năng này sinh ra để dẹp. Lệch là thay, và
 * thay theo hướng nào cũng đưa hai bên về cùng một bản mã.
 *
 * ── BA CỬA TỪ CHỐI, MỖI CỬA CHỐNG MỘT TAI NẠN CỤ THỂ ────────────────────────────────────
 *
 * 1. Gói KHÔNG khai số bản (`own` rỗng — bản trước 0.71.0). Không đọc nổi bản của chính mình
 *    thì sau khi thay gói cũng không biết đã thay được hay chưa, nên vòng nuôi mất luôn phép
 *    dừng vòng lặp. Từ chối là chặn một vòng thay-gói-vô-tận.
 *
 * 2. Máy chủ chưa nói bản của nó (`web` rỗng — trạm đời cũ, hoặc phản hồi thiếu trường). Đây
 *    là luật「tuyệt đối không được đoán là cũ」của `version.ts` chép sang: im lặng KHÔNG phải
 *    lời khai rằng có bản mới.
 *
 * 3. Cờ tắt. Vòng nuôi tự tay tắt cờ này ở lượt dựng kế tiếp khi một lượt thay gói đã chạy mà
 *    số bản KHÔNG đổi — nghĩa là trạm hứa một đằng, gói phát ra một nẻo. Không có cửa ấy thì
 *    khôi lỗi thoát-thay-thoát mãi mãi và chẳng cày được nhiệm vụ nào.
 */

/**
 * Mã thoát riêng cho「tôi vừa thu đàn xong, xin thay gói」.
 *
 * Phải KHÁC 0 (0 nghĩa là xong việc, vòng nuôi cứ dựng lại như thường) và khác 1 (1 đã mang
 * nghĩa「thu đàn hụt hạn, có người mất một vòng」). 90 nằm ngoài mọi mã Node tự sinh.
 */
export const UPDATE_EXIT_CODE = 90;

/**
 * Cờ môi trường — XIN VÀO, không phải xin ra. Mặc định TẮT, và đây là một quyết định chứ không
 * phải sự dè dặt.
 *
 * Thoát-để-thay-gói chỉ có nghĩa khi có MỘT AI ĐÓ đứng ngoài nhặt mã thoát lên rồi đi lấy gói.
 * Trên máy nhà đó là `run.ps1`/`run.sh`, và bộ cài bật cờ này cho chúng. Khôi lỗi tông môn thì
 * chạy trong GitHub Actions, KHÔNG có vòng nuôi: nó thoát ra là lượt chạy kết thúc, gói chẳng ai
 * thay, và ta đổi một cú lệch bản vô hại lấy thời gian chết có thật. Bật sẵn cho mọi người là
 * bật cho cả những chỗ không dùng được.
 *
 * Vòng nuôi cũng dùng chính cờ này theo chiều ngược lại: đặt `0` ở lượt dựng kế tiếp để bảo
 *「thôi hỏi nữa」khi một lượt thay gói đã chạy mà số bản không đổi.
 */
export function selfUpdateEnabled(env) {
  return env?.WORKER_SELF_UPDATE === "1";
}

/**
 * @param {{own: string|null|undefined, web: string|null|undefined, enabled: boolean}} p
 * @returns {{update: boolean, reason: string}} `reason` luôn có chữ — nó được in ra nhật ký
 *   của máy nhà, và một lượt KHÔNG thay gói cũng cần giải thích được vì sao.
 */
export function shouldSelfUpdate({ own, web, enabled }) {
  if (!enabled) {
    return { update: false, reason: "phép tự thay gói đang tắt (WORKER_SELF_UPDATE=0)" };
  }

  const a = typeof own === "string" ? own.trim() : "";
  const b = typeof web === "string" ? web.trim() : "";

  if (!a) {
    return { update: false, reason: "gói này không khai số bản — không tự kiểm chứng được, thôi" };
  }
  if (!b) {
    return { update: false, reason: "máy chủ chưa nói bản của nó — không đoán là cũ" };
  }
  if (a === b) {
    return { update: false, reason: `đang đúng bản ${a}` };
  }
  return { update: true, reason: `máy chủ đang ở bản ${b}, gói này là ${a} — xin thay gói` };
}
