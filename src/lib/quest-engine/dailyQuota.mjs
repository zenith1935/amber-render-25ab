/**
 * NHIỆM VỤ NGÀY CÓ TRẦN LƯỢT — danh sách quyết định cái gì được phép nhớ「hôm nay xong rồi」.
 *
 * Vì sao phải có một danh sách thay vì tin thẳng vào kết cục `alreadyDone`: `alreadyDone` chỉ
 * nói「trang không còn gì để bấm và cũng không có đồng hồ nào đang chạy」. Với chín nhiệm vụ
 * dưới đây câu ấy đồng nghĩa với「hết lượt của ngày hôm nay」, vì trần của chúng là trần NGÀY
 * và chỉ mốc sang ngày mới mở lại. Nhưng cùng một kết cục ấy, ở Mê Cung hay Luyện Đan Đường,
 * lại có thể chỉ là một trạng thái thoáng qua của cái lò — nhớ nhầm nó là tắt mất nhiệm vụ
 * đáng giá nhất trong ngày mà không ai được báo. Nên phạm vi được KHAI RÕ, không suy đoán.
 *
 * Khoá theo ID chứ không theo TÊN: cặp twin VIP/thường cố ý trùng tên nhau (xem
 * `questsForAccount`), còn ID mới là khoá chính của hồ sơ. Cả hai bản của một nhiệm vụ đều có
 * mặt ở đây vì trần lượt là của TÀI KHOẢN, không phải của cái flow chạy nó.
 *
 * Đổi ID trong hồ sơ mà quên chỗ này thì tính năng lặng lẽ ngừng hoạt động — nên `npm run
 * smoke` đối chiếu từng ID dưới đây với hồ sơ thật và ĐỎ khi có cái không còn tồn tại.
 */
export const DAILY_QUOTA_QUEST_IDS = new Set([
  "diem-danh",
  "diem-danh-thuong",
  "phuc-loi-duong",
  "phuc-loi-duong-thuong",
  "hoang-vuc",
  "hoang-vuc-thuong",
  "thi-luyen-tong-mon",
  "thi-luyen-tong-mon-thuong",
  "te-le-tong-mon",
  "te-le-tong-mon-thuong",
  "phuc-loi-vip-khac-tran-van",
  // CHỈ bản VIP, và sự vắng mặt của bản thường ở đây là có chủ ý — xem ghi chú ngay dưới sổ này.
  "vong-quay-phuc-van",
  "van-dap",
  "van-dap-thuong",
  // Cả hai bản: trần 5 lượt là trần NGÀY, và cả hai đều nói ra được điều đó bằng một câu
  // riêng — bản VIP mất nút quick-click trên hub, bản thường đọc chữ "Hết lượt hôm nay" mà
  // boss-system.js khắc lên chính nút KHIÊU CHIẾN. Cảnh "còn lượt nhưng đang chờ" của bản
  // thường đi ngả onCooldown (chữ "Còn 6:52"), nên không thể lạc vào sổ này.
  "bi-canh-tong-mon",
  "bi-canh-tong-mon-thuong",
  // Khoáng Mạch: trần NGÀY thật — hai ô Tu Vi/Tinh Thạch server render trên trang, và trần
  // ĐỔI mỗi ngày (14/08 đo 300/100, 15/08 đo 600/200 — không có con số「N lần nhận」nào).
  // `alreadyDone` của nó chỉ phát từ MỘT chỗ: stopIf「đã đầy trần」đọc số x/y ấy — đúng hình
  // dạng mà dailyCapReached đi tìm. Đường「đang đào dở」thoát bằng onCooldown kèm đồng hồ
  // nên không bao giờ lạc vào sổ này.
  "khoang-mach",
  "khoang-mach-thuong",
  // Phần Thưởng Hoạt Động: hai rương của NGÀY, nhận rồi là thẻ mang class `claimed` cho tới
  // hôm sau. `alreadyDone` của nó phát từ ĐÚNG MỘT chỗ — stopIf đọc cờ「cả hai thẻ đều
  // claimed」— nên nó không thể lẫn với「lúc này chưa tới mốc」: cảnh ấy đi ngả onCooldown 30
  // phút, và ngả「không thấy mục trên trang」đi ngả onCooldown 60 phút. Chính ranh giới ấy là
  // thứ Vòng Quay bản thường không có, và là lý do bản thường của nó vắng mặt ở sổ này.
  "phan-thuong-hoat-dong",
  "phan-thuong-hoat-dong-thuong",
]);

/**
 * VÌ SAO VÒNG QUAY BẢN THƯỜNG KHÔNG CÓ TRONG SỔ TRÊN — và đây là một quyết định của TRANG,
 * không phải một chỗ quên.
 *
 * Một ID chỉ được vào sổ khi lời khai「hết lượt」của nó phân biệt được với「lượt sau mới mở」.
 * Bản VIP phân biệt được: thẻ nhiệm vụ trên hub đếm `x/4`, nên `4/4` là hết ngày thật, còn
 * `3/4` kèm nút khoá chỉ là lượt thứ tư chưa tới. Bản THƯỜNG thì KHÔNG có con số ấy — trang
 * vòng quay riêng chỉ có `#userTurns` (số lượt còn lại) và chữ trên nút, mà cả hai cảnh đều
 * đọc ra y hệt nhau:
 *
 *      đã quay đủ 4 hôm nay   →  #userTurns = 0, nút「Hết lượt」
 *      mới 3, lượt 4 đang khoá →  #userTurns = 0, nút「Hết lượt」
 *
 * Nên với bản thường,「Hết lượt」là lời khai về LÚC NÀY, không phải về CẢ NGÀY. Ghi nó vào sổ
 * là tự khoá mình ở 3 lượt: đúng cái lượt ghé mà các nhiệm vụ ngày khác vừa xong (peersDone
 * thành true) lại chính là lượt đọc ra「Hết lượt」— trang chưa kịp mở lượt thứ tư — và sổ đóng
 * lại vĩnh viễn cho tới sáng hôm sau. Đó là điều tông chủ báo ngày 15/08/2026: tài khoản
 * thường mỗi ngày chỉ quay được 3 vòng trong khi VIP quay đủ 4.
 *
 * Cái giá của việc để nó NGOÀI sổ, nói thẳng: quay đủ 4 rồi thì mỗi vòng chạy vẫn mở trang
 * vòng quay một lần nữa để hỏi lại (khoảng một lượt mỗi giờ theo `fallbackCooldownSeconds`),
 * đọc「Hết lượt」rồi đi. Mười giây mỗi giờ, đổi lấy một vòng quay mỗi ngày.
 *
 * Bản VIP thì KHÔNG bị hạ theo: nó vẫn ở trong sổ, vì `4/4` của nó là một lời khai thật về cả
 * ngày. Hai bản khác nhau ở đây vì hai TRANG khác nhau, không phải vì hai luật.
 */

/** Nhiệm vụ này có trần lượt theo ngày không. */
export function isDailyQuotaQuest(quest) {
  return quest != null && DAILY_QUOTA_QUEST_IDS.has(quest.id);
}

/**
 * Nhiệm vụ mà LÀM XONG cũng chính là「hết lượt hôm nay」— không cần chờ trang tự nói.
 *
 * Với hầu hết nhiệm vụ ngày, `completed` chỉ nghĩa là「vừa xong MỘT lượt」: Bí Cảnh có 5 lượt,
 * ghi sổ ngay lượt đầu là vứt bốn lượt còn lại. Nên danh sách này hẹp, và một ID chỉ được vào
 * đây khi chính SCRIPT của nó đã bắt trang game xác nhận hết ngày trước khi được phép báo xong.
 *
 * Vấn Đáp là đúng hình dạng ấy: cả 5 câu của ngày nằm trong MỘT phiên (một cú bấm「bắt đầu」tải
 * trọn), và bước cuối của script là một `waitForCondition` KHÔNG optional đòi thấy chữ「hoàn
 * thành Vấn Đáp」trong `#quiz-wrapper`. Dừng giữa chừng thì bước ấy đỏ và kết cục là `failed`,
 * không phải `completed` — nên `completed` ở đây đã mang sẵn lời xác nhận của chính trang game,
 * đúng thứ mà `dailyCapReached` đi tìm.
 *
 * Vì sao cần: trước bản này, Vấn Đáp KHÔNG BAO GIỜ vào sổ. Đo trên đàn thật ngày 11/08/2026 —
 * nó báo「xong」ở cả 21:55, 22:12, 22:31, 22:48, 23:06, tức mỗi vòng một lần mở trang cho một
 * nhiệm vụ mà cả ngày chỉ có 5 câu. Lý do: lượt chạy ĐẦU của ngày kết thúc `completed` nên
 * không có gì được ghi, còn `stopIf`「đã hoàn thành vấn đáp hôm nay」ở đầu script thì lấy mẫu
 * ĐÚNG MỘT LẦN ngay sau khi vỏ trang dựng xong — mà trang này vẽ ruột bằng một XHR 2–4 giây
 * sau, nên lúc nó nhìn thì `#quiz-wrapper` còn trống. Các vòng sau vì thế cứ mở lại trang, để
 * rồi bước cuối thấy chữ hoàn thành và lại báo「xong」.
 */
export const COMPLETION_ENDS_DAY_QUEST_IDS = new Set(["van-dap", "van-dap-thuong"]);

/**
 * Nhiệm vụ mà「hết lượt」CHƯA CHẮC là hết ngày, vì lượt CUỐI của nó chỉ mở ra sau khi các
 * nhiệm vụ ngày khác đã xong.
 *
 * Vòng Quay Phúc Vận là đúng hình dạng ấy, và cho tới nay là cái duy nhất: site cho 4 lượt một
 * ngày nhưng khoá lượt thứ 4 cho tới khi xong hết nhiệm vụ ngày. Trước lúc ấy nút quay biến
 * khỏi DOM (bản VIP) hoặc tự viết lại thành「Hết lượt」(bản thường) — cùng một hình dạng với
 * hết lượt THẬT, và không có gì phân biệt được hai cái ngay tại chỗ.
 *
 * Không có danh sách này thì lượt ghé đầu tiên gặp「hết lượt」ghi thẳng vào sổ, và ĐÚNG cái lượt
 * ghé có thể lấy vòng thứ 4 — lượt sau khi mọi nhiệm vụ khác đã xong — là lượt bị sổ cấm mở
 * trang. Đo trên trạm đang phục vụ ngày 15/08/2026, trọn chuỗi trên năm đàn: 20:41「hết lượt
 * quay hôm nay」→ 20:44「Đã đủ lượt hôm nay … Vòng Quay Phúc Vận」→ 20:51–20:54「Bỏ qua … Vòng
 * Quay Phúc Vận」. Mỗi ngày mất trắng một vòng quay, và mất im lặng: mọi dòng nhật ký đều xanh,
 * vì theo chỗ đứng của runner thì nó đã làm đúng.
 *
 * Thuốc: chỉ tin「hết lượt」của chúng KHI mọi nhiệm vụ ngày khác trong kế hoạch đã vào sổ — lúc
 * ấy điều kiện mở lượt cuối đã thoả, nên「vẫn hết lượt」mới thật là hết. Giá phải trả là một
 * hai lượt ghé thừa vào cuối ngày; đổi lại là vòng quay thứ 4, mỗi ngày, cho mọi đàn.
 *
 * **CHỈ CÒN BẢN VIP ở đây, từ 15/08/2026.** Phép chờ-bạn-đồng-hành trên hoá ra vẫn chưa đủ cho
 * bản THƯỜNG, và lý do là một chữ「khi」: nó cho phép ghi sổ ở ĐÚNG cái lượt ghé mà các nhiệm vụ
 * khác vừa xong — mà lượt ấy đọc trang trước khi trang kịp mở lượt thứ tư, nên nó vẫn thấy
 *「Hết lượt」rồi đóng sổ cả ngày. Bản VIP thoát được vì nó đọc được `4/4` (một lời khai thật về
 * cả ngày); bản thường không có con số ấy nên đã bị rút hẳn khỏi `DAILY_QUOTA_QUEST_IDS` — xem
 * khối ghi chú ở đó. Một ID không thuộc sổ ngày thì cũng không cần cổng này: `reachedDailyQuota`
 * hỏi `isDailyQuotaQuest` trước, nên để nó lại đây chỉ là một dòng chết.
 *
 * Bản desktop KHÔNG cần danh sách này vì nó không có sổ: `AccountRunner` ghi log rồi quay lại ở
 * vòng sau, đúng như XML doc của `LotteryWheel` dự tính («a later visit's business»).
 */
export const PEER_GATED_QUEST_IDS = new Set(["vong-quay-phuc-van"]);

/**
 * Mọi nhiệm vụ ngày KHÁC trong kế hoạch đã đủ lượt hôm nay chưa — câu hỏi mà
 * `PEER_GATED_QUEST_IDS` cần trả lời trước khi cho một cái vào sổ.
 *
 * `plan` là kế hoạch của CHÍNH vòng này, tức đã trừ đi những nhiệm vụ vào sổ từ các vòng
 * TRƯỚC; nên chỉ còn phải trừ nốt những cái vừa vào sổ trong vòng NÀY (`cappedSoFar`).
 *
 * Nhiệm vụ chạy xong mà chưa vào sổ vẫn tính là CÒN DỞ — đúng như vậy: Phúc Lợi Đường có 4
 * lượt, xong một lượt không mở được vòng quay thứ 4. Và một nhiệm vụ hỏng cả ngày cũng giữ
 * vòng quay ở trạng thái chờ cả ngày; đó là cái giá đã biết, vì lượt cuối kia có thể mở ra
 * ngay khi nhiệm vụ ấy chạy được.
 *
 * Kế hoạch không có nhiệm vụ ngày nào khác thì câu trả lời là CÓ, và đó cũng đúng: không có gì
 * để xong thì cũng chẳng có gì mở khoá lượt cuối, nên「hết lượt」là hết thật.
 */
export function peersDoneForQuota(quest, plan, cappedSoFar = []) {
  const capped = new Set(cappedSoFar);
  return !(plan ?? []).some(
    (other) => other?.id !== quest?.id && isDailyQuotaQuest(other) && !capped.has(other.id),
  );
}

/**
 * Kết quả vừa rồi có phải lời khai「hôm nay hết lượt」không.
 *
 * HAI đường vào sổ, và cả hai đều đòi chính TRANG GAME xác nhận — khác nhau ở chỗ nó xác nhận
 * lúc nào:
 *
 *   1. Dừng sớm vì một bước `stopIf` khớp (`alreadyDone` + `dailyCapReached`). Cờ ấy chỉ được
 *      engine gắn ở đúng chỗ đó. Vấn Đáp dừng vì khôi lỗi chưa biết đáp án cũng ra
 *      `alreadyDone`, nhưng đó là giới hạn của TA chứ không phải của tài khoản: nhớ nó thành
 *     「đã đủ lượt」là khoá cứng nhiệm vụ cả ngày đúng vào lúc kho đáp án có thể vừa học thêm
 *      được câu ấy. Nên nhánh này soát cờ, không soát kết cục.
 *   2. Chạy trọn và báo xong, với những nhiệm vụ mà「xong」ĐÃ đồng nghĩa hết ngày — xem
 *      `COMPLETION_ENDS_DAY_QUEST_IDS`. Thiếu nhánh này thì lượt chạy đầu tiên của ngày, cái
 *      lượt làm THẬT, lại là lượt duy nhất không ghi được gì vào sổ.
 *
 * `isDailyQuotaQuest` gác trước cả hai nhánh: một ID không phải nhiệm vụ ngày thì không có
 * đường nào vào sổ, kể cả khi ai đó lỡ tay thêm nó vào danh sách thứ hai.
 *
 * `peersDone` là cổng THỨ BA, và chỉ những ID trong `PEER_GATED_QUEST_IDS` phải qua nó: lời khai
 * của trang game là thật, nhưng với chúng nó chỉ trả lời「lúc này hết lượt」chứ không trả lời
 * 「hôm nay hết lượt」. Tính bằng `peersDoneForQuota`.
 */
export function reachedDailyQuota(quest, outcome, { peersDone = false } = {}) {
  if (!isDailyQuotaQuest(quest)) return false;
  // Mặc định `false` là phía AN TOÀN, có chủ ý: người gọi quên truyền thì cùng lắm mở thừa một
  // trang mỗi vòng, còn ngả nhầm về phía kia là mất hẳn một vòng quay mỗi ngày — im lặng.
  if (!peersDone && PEER_GATED_QUEST_IDS.has(quest.id)) return false;
  if (outcome?.outcome === "alreadyDone" && outcome?.dailyCapReached === true) return true;
  return outcome?.outcome === "completed" && COMPLETION_ENDS_DAY_QUEST_IDS.has(quest.id);
}
