/**
 * Cổng điều phối TOÀN CỤC cho nhiệm vụ — một bộ đếm cho cả tiến trình khôi lỗi, xuyên mọi
 * đàn và mọi đạo hữu mà khôi lỗi ấy đang phục vụ.
 *
 * Vì sao tồn tại: nhật ký 07/08 01:03:55. Hoang Vực (trang riêng /hoang-vuc) chạy song song
 * cạnh một trận Mê Cung đủ đội (trang riêng /me-cung) trên VM hai nhân — hoạt ảnh của tab bị
 * bỏ đói CPU chưa chạy xong thì ngân sách bằng chứng đã cạn, và một đòn đánh thật sự trúng
 * bị báo thành thất bại. Nới ngân sách (0.34.1) là thuốc giảm đau; thuốc chữa là đừng bao
 * giờ để hai trận đánh lớn giành nhau hai nhân CPU nữa.
 *
 * Luật, đúng theo lời tông chủ đặt ra (sửa 09/08/2026 — xem đoạn "bản cũ" bên dưới):
 * HAI LÀN RIÊNG, mỗi làn một trần, không tranh ngân sách của nhau. Không phân biệt tài khoản:
 * bộ đếm là của cả tiến trình.
 *   - Làn HUB (pagePath = dailyQuestPath, thao tác ngắn trên /nhiem-vu-hang-ngay): tối đa 5.
 *   - Làn TRANG RIÊNG (pagePath khác): tối đa 2.
 *   → cùng lắm 7 nhiệm vụ chạy một lúc, và trần tab mỗi đàn vẫn do pool của vòng đó giữ.
 *
 * Vì sao hub nới 3→5 mà trang riêng GIỮ 2 (09/08/2026, sau khi VM lên 4 vCPU/24GB): hub là
 * thao tác ngắn, gần như không ngốn CPU. Trang riêng thì ngược lại — sự cố 07/08 là HAI nhiệm
 * vụ nặng trên HAI vCPU, tức tỉ lệ hỏng là 1 vCPU mỗi nhiệm vụ nặng. Giữ 2 trên 4 vCPU cho
 * mỗi cái 2 vCPU, thoải mái gấp đôi ngưỡng đã gãy; nâng lên 3 là tụt về 1,33 và bò lại đúng
 * vạch ấy. RAM dư thì nới được, CPU mới là thứ đã từng làm hỏng dữ liệu.
 *
 * BẢN CŨ, và vì sao nó đổi: luật đầu tiên cho ĐÚNG MỘT trang riêng cộng ĐÚNG MỘT hub đồng
 * hành — tổng ≤ 2 cho cả khôi lỗi. Nó sinh ra từ sự cố 07/08 nói trên và đã làm đúng việc của
 * nó, nhưng cái giá là: hễ một người đánh Mê Cung là cả năm ghế của tông môn tụt xuống 2, kể
 * cả những đàn chỉ còn vài thao tác hub vụn vặt. Tông chủ nới lên 2 + 3.
 *
 * Tách làn kéo theo một thay đổi KHÔNG hiển nhiên: luật "hub phải nhường khi có trang riêng
 * đứng đợi" bị GỠ BỎ. Nó tồn tại vì hồi ấy hai loại tiêu chung một ngân sách, nên dòng hub bất
 * tận của các đàn khác bỏ đói trang riêng vĩnh viễn. Nay trang riêng có hai chỗ của riêng nó —
 * hub nhường cũng không mở thêm được chỗ nào cho nó, giữ lại luật ấy chỉ tổ bắt hub đứng im vô
 * ích. FIFO trong TỪNG làn thì vẫn giữ: một trang riêng đợi trước thì trang riêng sau không
 * vượt mặt.
 *
 * Hai nhiệm vụ trang riêng GIỜ ĐƯỢC cặp với nhau (trần 2) — đây chính là điều bản cũ cấm tuyệt
 * đối, nên nếu triệu chứng 07/08 quay lại (đòn đánh trúng bị báo thành thất bại vì tab bị bỏ
 * đói CPU), hạ `MAX_DEDICATED` về 1 là chỗ đầu tiên phải thử.
 *
 * LÀN ĐỘC QUYỀN THEO TÊN (22/08/2026, lệnh tông chủ): nhiệm vụ mang cờ `exclusive` chỉ được
 * MỘT chỗ cho MỖI TÊN trên cả tiến trình. Đặt ra cho Mê Cung: một khôi lỗi tông môn không được
 * đánh hai trận Mê Cung cùng lúc, dù là của hai tài khoản khác nhau. Cổng này cố ý KHÔNG biết
 * tên nào độc quyền — cờ do runCycle gắn theo `soloQuestNames` mà server gửi kèm job lúc phát
 * việc, và chỉ khôi lỗi tông môn nhận danh sách ấy; khôi lỗi riêng của đạo hữu giữ nguyên nếp
 * cũ, đúng lệ「chỉ ghế chung mới có luật chung」. Chính sách nằm ở server nên đổi luật không
 * phải đẩy gói mới cho các kho đông lạnh.
 *
 * Kẻ đợi vì TÊN không chặn làn: một Mê Cung đứng chờ trận Mê Cung khác xong không có quyền bắt
 * Hoang Vực đứng im trước một ghế trống — nó không tranh cái ghế, nó tranh cái tên. Cùng bài
 * học với luật「hub nhường」đã gỡ ở trên: bắt ai đó chờ mà cái chờ không mở thêm chỗ cho người
 * bị chờ là chờ vô ích. Chỉ khi kẹt GHẾ thật (làn đầy) nó mới chặn làn như mọi trang riêng
 * khác. FIFO theo tên vẫn giữ: hai Mê Cung cùng đợi thì vào theo thứ tự xếp hàng.
 *
 * Chờ HUỶ ĐƯỢC: Thu Đàn giữa lúc xếp hàng không được phép kẹt lại sau một trận Mê Cung 35
 * phút của người khác chỉ để nói "tôi dừng đây". Mỗi waiter mang shouldStop của vòng nó;
 * một nhịp poll 500ms (chỉ chạy khi hàng đợi có người) nhặt những waiter đã rút lui.
 *
 * Module-level state là CHỦ Ý, không phải tiện tay: worker chạy nhiều đàn trong cùng một
 * tiến trình Node, nên một bộ đếm mức module chính là "toàn cục trên cái máy này" — đúng
 * phạm vi tài nguyên (CPU) mà luật muốn bảo vệ. Hai khôi lỗi trên hai máy khác nhau không
 * cần biết nhau.
 */

/** Nhiệm vụ có trang riêng — đối tượng của luật nhường đường. */
export function isDedicatedPageQuest(profile, quest) {
  return Boolean(quest.pagePath) && quest.pagePath !== profile.dailyQuestPath;
}

/** Trần làn TRANG RIÊNG — số nhiệm vụ nặng được chạy cùng lúc trên cả khôi lỗi. */
const MAX_DEDICATED = 2;
/** Trần làn HUB — thao tác ngắn trên trang nhiệm vụ hằng ngày. */
const MAX_HUB = 5;

const state = {
  /** Tổng nhiệm vụ đang chạy qua cổng, mọi đàn cộng lại — bằng dedicatedActive + hub. */
  active: 0,
  /** 0..MAX_DEDICATED. */
  dedicatedActive: 0,
  /** Tên các nhiệm vụ trang riêng đang giữ làn, cho lời nhật ký của kẻ phải đợi. */
  dedicatedNames: [],
  /** Tên các nhiệm vụ ĐỘC QUYỀN đang giữ chỗ — mỗi tên tối đa một, xem khối đầu tệp. */
  exclusiveNames: [],
  /** FIFO: { dedicated, exclusive, name, shouldStop, resolve } */
  queue: [],
  pollTimer: null,
};

/** Hook cho smoke test: được gọi đồng bộ sau MỖI lần admit/release với ảnh chụp state. */
let onChange = null;
export function _observeGate(fn) {
  onChange = fn;
}
/** Cũng cho smoke: đưa cổng về trắng giữa hai kịch bản, vì state sống mức module. */
export function _resetGate() {
  for (const w of state.queue.splice(0)) w.resolve({ aborted: true });
  state.active = 0;
  state.dedicatedActive = 0;
  state.dedicatedNames = [];
  state.exclusiveNames = [];
  stopPollIfIdle();
}

function snapshot() {
  return {
    active: state.active,
    dedicatedActive: state.dedicatedActive,
    queued: state.queue.length,
  };
}

function notifyChange() {
  onChange?.(snapshot());
}

// Hai lý do kẹt tách làm hai phép hỏi, vì drain phải biết VÌ SAO một waiter đứng lại: kẹt GHẾ
// thì chặn cả làn phía sau (FIFO nguyên thuỷ), kẹt TÊN thì chỉ chặn kẻ cùng tên tới sau —
// ghế trống vẫn thuộc về người khác. Gộp làm một boolean là mất đúng phép phân loại ấy.

/** Kẹt GHẾ — luật hai làn nguyên thuỷ. */
function seatBlocked(waiter, hasDedicatedAhead) {
  if (waiter.dedicated) {
    // FIFO trong làn: không vượt mặt một trang-riêng đã xếp trước mà chưa vào được vì ghế.
    return state.dedicatedActive >= MAX_DEDICATED || hasDedicatedAhead;
  }
  // Hub KHÔNG còn phải nhường trang-riêng đang đợi, và đó là hệ quả trực tiếp của việc tách
  // làn: trước kia hai loại tiêu chung một ngân sách nên hub cứ vào là bóp nghẹt trang-riêng
  // vĩnh viễn — nay trang-riêng có hai chỗ của riêng nó, hub nhường cũng chẳng mở thêm được
  // chỗ nào cho nó. Giữ lại luật nhường chỉ tổ bắt hub đứng im vô ích.
  return state.active - state.dedicatedActive >= MAX_HUB;
}

/** Kẹt TÊN — một nhiệm vụ độc quyền cùng tên đang chạy, hoặc đứng trước trong hàng. */
function exclusiveBlocked(waiter, exclusiveAheadNames) {
  if (!waiter.exclusive) return false;
  return state.exclusiveNames.includes(waiter.name) || exclusiveAheadNames.has(waiter.name);
}

/** Cho đường vào nhanh của acquireQuestSlot — hàng đợi rỗng thì không có ai đứng trước. */
const NO_AHEAD = new Set();

function admit(waiter) {
  state.active += 1;
  if (waiter.dedicated) {
    state.dedicatedActive += 1;
    state.dedicatedNames.push(waiter.name);
  }
  if (waiter.exclusive) state.exclusiveNames.push(waiter.name);
  notifyChange();

  let released = false;
  return {
    release() {
      if (released) return; // release hai lần không được phép đánh sập bộ đếm
      released = true;
      state.active -= 1;
      if (waiter.dedicated) {
        state.dedicatedActive -= 1;
        // Gỡ ĐÚNG một chỗ mang tên ấy, không lọc sạch: hai đàn chạy cùng một nhiệm vụ (hai
        // tài khoản cùng đánh Mê Cung) thì hai chỗ trùng tên, xoá cả hai là bộ đếm tên lệch
        // khỏi `dedicatedActive` và lời nhật ký bắt đầu nói dối.
        const at = state.dedicatedNames.indexOf(waiter.name);
        if (at !== -1) state.dedicatedNames.splice(at, 1);
      }
      if (waiter.exclusive) {
        const at = state.exclusiveNames.indexOf(waiter.name);
        if (at !== -1) state.exclusiveNames.splice(at, 1);
      }
      notifyChange();
      drain();
    },
  };
}

function drain() {
  let hasDedicatedAhead = false;
  const exclusiveAheadNames = new Set();
  for (let i = 0; i < state.queue.length; ) {
    const waiter = state.queue[i];

    if (waiter.shouldStop?.()) {
      // Thu Đàn giữa lúc xếp hàng: rút lui tại chỗ, không chiếm slot nào.
      state.queue.splice(i, 1);
      waiter.resolve({ aborted: true });
      continue;
    }

    const bySeat = seatBlocked(waiter, hasDedicatedAhead);
    const byName = exclusiveBlocked(waiter, exclusiveAheadNames);
    if (!bySeat && !byName) {
      state.queue.splice(i, 1);
      waiter.resolve(admit(waiter));
      continue; // cùng chỉ số i giờ là waiter kế tiếp
    }

    // Kẹt GHẾ mới chặn làn; kẹt TÊN chỉ chặn kẻ cùng tên tới sau — xem khối đầu tệp.
    if (bySeat && waiter.dedicated) hasDedicatedAhead = true;
    if (byName) exclusiveAheadNames.add(waiter.name);
    i += 1;
  }
  stopPollIfIdle();
}

function stopPollIfIdle() {
  if (state.queue.length === 0 && state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/**
 * Xin một chỗ chạy. Trả về `{ release }` khi tới lượt, hoặc `{ aborted: true }` nếu vòng đã
 * Thu Đàn trong lúc xếp hàng. `release()` PHẢI được gọi trong finally của người xin — một
 * slot rò rỉ là cả tiến trình nghẽn vĩnh viễn, nên release được làm trơ với gọi trùng.
 *
 * @param {object} input
 * @param {boolean} input.dedicated  nhiệm vụ trang riêng?
 * @param {boolean} [input.exclusive]  độc quyền theo tên — mỗi tên một chỗ trên cả tiến trình?
 * @param {string}  input.name       tên cho nhật ký của người khác
 * @param {() => boolean} [input.shouldStop]  cờ Thu Đàn của vòng đang xin
 * @param {(info: { holder: string | null }) => void} [input.onWait]  gọi MỘT lần nếu phải xếp hàng
 */
export function acquireQuestSlot({ dedicated, exclusive = false, name, shouldStop, onWait }) {
  const waiter = { dedicated, exclusive, name, shouldStop, resolve: null };
  if (state.queue.length === 0 && !seatBlocked(waiter, false) && !exclusiveBlocked(waiter, NO_AHEAD)) {
    return Promise.resolve(admit(waiter));
  }

  return new Promise((resolve) => {
    waiter.resolve = resolve;
    state.queue.push(waiter);

    // Drain NGAY khi vừa xếp hàng, không đợi ai buông cổng: một hub tới lúc chỗ đồng hành
    // còn trống phải được vào trong cùng nhịp — nhịp poll 500ms chỉ dành cho việc nhặt
    // waiter đã Thu Đàn, không phải con đường nhập cuộc bình thường.
    drain();

    if (state.queue.includes(waiter)) {
      // Vẫn đứng trong hàng sau lượt drain → giờ mới thật sự là "xếp hàng chờ".
      // `holder` giữ nguyên kiểu string|null như trước; hai chỗ trang-riêng thì ghép tên để
      // người đọc nhật ký biết mình đang đợi SAU AI, chứ không phải chỉ một cái tên ngẫu nhiên.
      onWait?.({ holder: state.dedicatedNames.join(" + ") || null });
      if (!state.pollTimer) {
        // unref để một hàng đợi đang chờ không giữ tiến trình sống khi mọi thứ khác đã
        // xong (script thoát tự nhiên).
        state.pollTimer = setInterval(drain, 500);
        state.pollTimer.unref?.();
      }
    }
  });
}
