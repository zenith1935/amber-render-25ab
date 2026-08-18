/**
 * Nối hai thế giới: cấu hình PHẲNG mà người dùng thấy trên web, và hồ sơ quest schema 41 mà
 * bộ thông dịch chạy.
 *
 * Vì sao không cho web sửa thẳng hồ sơ: hồ sơ là nhiều nhiệm vụ × hàng trăm bước, và nó là nơi
 * cất TRI THỨC VỀ SITE — thứ mà một cái form không nên mời người ta chỉnh. Cái người dùng
 * thực sự muốn quyết chỉ là vài lựa chọn ("Ác Mộng hay Thường", "trục xuất dưới bao nhiêu
 * HP"). Nên web giữ form nhỏ, còn ở đây một lớp dịch mỏng đặt các lựa chọn ấy vào đúng
 * `selectedValue` của hồ sơ.
 *
 * Hồ sơ (`profile.json`) là bản xuất thẳng từ bản desktop, mọi quest tắt sẵn. Cả hai sản
 * phẩm đọc CÙNG một tệp, nên site đổi thì sửa một chỗ.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Đọc bằng fs chứ không `import ... with { type: "json" }`: cùng một tệp này chạy ở nhiều
// nơi — worker trên VM tông môn, worker máy nhà (từ gói cài), smoke trên máy dev — mà mỗi
// runtime đối xử với import attribute một kiểu. `fs` thì chỗ nào có Node cũng hiểu như nhau.
const profileData = JSON.parse(
  readFileSync(fileURLToPath(new URL("./profile.json", import.meta.url)), "utf8"),
);

/** Bản sao sâu — người gọi được phép sửa thoải mái mà không đụng vào hồ sơ gốc. */
export function loadProfile() {
  return structuredClone(profileData);
}

const findQuests = (profile, name) => profile.quests.filter((q) => q.name === name);
const findOption = (quest, key) => quest?.options?.find((o) => o.key === key);

/**
 * Đặt giá trị cho một option, và nói thật khi giá trị không nằm trong danh sách.
 *
 * Đây là chỗ dễ mất tiếng nhất trong cả lớp dịch: `buildOptionValues` của engine, gặp một
 * `selectedValue` không lựa chọn nào mang, sẽ rơi về lựa chọn ĐẦU TIÊN. Với ngưỡng trục
 * xuất, lựa chọn đầu là "Không trục xuất" — nghĩa là một người gõ 250.000 sẽ lặng lẽ được
 * một lượt chạy không trục xuất ai. Nên giá trị lạ được nhận NGUYÊN VĂN qua `allowCustom`,
 * và việc đó được ghi lại.
 */
function setOption(quest, key, value, { allowFreeform = false, log } = {}) {
  const option = findOption(quest, key);
  if (!option) {
    log?.(`Hồ sơ không có option '${key}' của「${quest?.name}」— bỏ qua.`);
    return;
  }

  const known = (option.choices ?? []).some((c) => c.value === value);
  if (!known) {
    if (!allowFreeform) {
      log?.(`Giá trị '${value}' không có trong option '${key}' của「${quest.name}」— giữ mặc định '${option.selectedValue}'.`);
      return;
    }
    option.allowCustom = true;
    log?.(`Option '${key}' của「${quest.name}」nhận giá trị tự nhập: '${value}'.`);
  }

  option.selectedValue = value;
}

/**
 * Suy ra "giữ từ mấy sao" của một lựa chọn phân giải, đọc từ chính GIÁ TRỊ của nó.
 *
 * Giá trị là một block-list cho `textNotMatches` ("dược khí 4 sao|dược khí 5 sao" = đừng
 * phân giải thứ nào là 4 hoặc 5 sao). Nên ngưỡng giữ chính là số sao NHỎ NHẤT có mặt. Đọc
 * theo cách này thay vì ghim thứ tự lựa chọn: hôm nào bản desktop thêm một mức, lớp dịch
 * vẫn tự hiểu thay vì lặng lẽ trỏ lệch một nấc.
 */
function keepLevelOf(choiceValue) {
  if (choiceValue.includes("«")) return 0; // «luôn phân giải»
  const stars = [...choiceValue.matchAll(/(\d+)\s*sao/g)].map((m) => Number(m[1]));
  return stars.length > 0 ? Math.min(...stars) : 1; // không có số nào = "dược khí" = giữ tất cả
}

/**
 * Nhiệm vụ "một công tắc": key trong config web ↔ tên nhiệm vụ trong hồ sơ. Một tên có thể
 * có hai flow theo hạng tài khoản (VIP chạy nút nhanh ở hub, tài khoản thường chạy trang
 * riêng). Công tắc phải bật cả hai; sau khi đọc hạng, engine chỉ lấy đúng flow của hạng đó.
 * Song sinh với danh sách trong configs.ts — thêm nhiệm vụ là thêm một dòng ở cả hai nơi.
 */
const SIMPLE_QUESTS = [
  ["diemDanh", "Điểm Danh"],
  ["hoangVuc", "Hoang Vực"],
  ["phucLoiDuong", "Phúc Lợi Đường"],
  ["thiLuyen", "Thí Luyện Tông Môn"],
  ["biCanh", "Bí Cảnh Tông Môn"],
  ["teLe", "Tế Lễ Tông Môn"],
  ["phucLoiVip", "Phúc Lợi VIP — Khắc Trận Văn"],
  ["vongQuay", "Vòng Quay Phúc Vận"],
  ["vanDap", "Vấn Đáp"],
  ["hySuDuong", "Hỷ Sự Đường"],
  ["phanThuongHoatDong", "Phần Thưởng Hoạt Động"],
];

/**
 * Khoá DẤU NGÀY của suất Linh Quang Phù — một lá mỗi ngày cho mỗi đàn.
 *
 * Nằm chung sổ với「nhiệm vụ đã đủ lượt hôm nay」(`daily_done.questIds`) nên phải mang hình
 * dạng KHÔNG THỂ trùng một ID nhiệm vụ: dấu hai chấm không có trong ID nào của hồ sơ, và
 * `splitPlanForToday` còn lọc lại bằng `isDailyQuotaQuest` trước khi dám bỏ qua nhiệm vụ nào.
 *
 * MỘT khoá cho cả hai bản VIP/thường: suất phù là của TÀI KHOẢN, không phải của cái flow chạy
 * nó — y như lập luận đã viết cho `DAILY_QUOTA_QUEST_IDS`. Một tài khoản rớt hạng giữa ngày
 * vẫn là tài khoản đã tiêu một lá phù hôm nay.
 *
 * Chuỗi này phải TRÙNG với dòng `@…` trong script của hồ sơ quest; `npm run smoke` đối chiếu
 * hai bên và đỏ khi chúng lệch nhau.
 */
export const PHU_DAILY_MARK = "khoang-mach:phu";

/**
 * Áp cấu hình người dùng lên một hồ sơ mới và trả về nó.
 *
 * Mọi quest bắt đầu từ trạng thái tắt (hồ sơ trong repo đã vậy), nên thứ chạy đúng bằng thứ
 * người dùng bật — không có danh sách thứ hai nào có quyền phủ quyết ngầm.
 *
 * @param {object} config  UserConfig đã qua Zod (xem services/configs.ts)
 * @param {(msg: string) => void} [log]  nơi kể lại những chỗ dịch không khớp
 * @param {Iterable<string>} [marksToday]  sổ ngày của đàn (`daily_done.questIds`) — những gì
 *   đã làm xong hôm nay. Vắng mặt = sổ trắng, đúng nghĩa cho mọi người gọi chỉ muốn dịch cấu
 *   hình (smoke test, lưới kiểm chứng) chứ không chạy một vòng thật.
 */
export function profileForConfig(config, log, marksToday) {
  const doneToday = marksToday instanceof Set ? marksToday : new Set(marksToday ?? []);
  const profile = loadProfile();

  // ---- Mê Cung ----------------------------------------------------------------------
  // Số NHIỀU từ schema 45: mỗi tên có cặp flow VIP/thường (me-cung + me-cung-thuong) dùng
  // chung script. Công tắc và MỌI option áp cho cả cặp — engine lọc theo hạng lúc chạy;
  // áp cho mỗi bản VIP là twin thường chạy với option mặc định, lệch ý người dùng.
  const meCungTwins = findQuests(profile, "Mê Cung");
  if (meCungTwins.length === 0) {
    log?.("Hồ sơ không có nhiệm vụ「Mê Cung」.");
  }
  for (const meCung of meCungTwins) {
    meCung.enabled = config.quests?.meCung?.enabled === true;
    if (meCung.enabled) {
      const mc = config.quests.meCung;
      setOption(meCung, "mode", mc.mode, { log });

      // Ngưỡng HP là một con số tự do trên web, trong khi hồ sơ chỉ liệt kê vài nấc quen
      // thuộc. Giá trị ngoài danh sách vẫn phải được tôn trọng — xem setOption.
      setOption(meCung, "kickHp", String(mc.kickHp ?? 0), { allowFreeform: true, log });

      // Ngưỡng "chưa sẵn sàng sau N giây" — cùng luật tự-nhập như kickHp.
      setOption(meCung, "kickIdle", String(mc.kickIdleSec ?? 0), { allowFreeform: true, log });

      // Hai lời nhắn Trò Chuyện Đội (recording 08/08) — chuỗi tự do đã được configs.ts làm
      // sạch (sanitizeChatMessage) trước khi tới đây; rỗng là「không nhắn」và hợp lệ.
      setOption(meCung, "chatLobby", mc.chatLobby ?? "", { allowFreeform: true, log });
      setOption(meCung, "chatFight", mc.chatFight ?? "", { allowFreeform: true, log });

      // capCheck là một cái công tắc trên web, còn trong hồ sơ nó là hai chuỗi khác nhau mà
      // bước `stopIf` đem so với trang.
      const capOption = findOption(meCung, "capCheck");
      const capOff = capOption?.choices?.find((c) => c.value.includes("«"));
      const capOn = capOption?.choices?.find((c) => !c.value.includes("«"));
      const wanted = mc.capCheck === false ? capOff : capOn;
      if (wanted) setOption(meCung, "capCheck", wanted.value, { log });
    }
  }

  // ---- Luyện Đan Đường ---------------------------------------------------------------
  // KHÁC Mê Cung: từ 08/2026 mỗi twin có bộ cấu hình RIÊNG — `luyenDan` cho bản VIP,
  // `luyenDanThuong` cho bản thường (`requiresVip: false`). Hồi còn dùng chung một bộ,
  // khắc ngọc giản từ tab VIP là lặng lẽ đè lựa chọn của tab Thường và ngược lại.
  // Snapshot đóng băng TRƯỚC deploy tách đôi chưa mang `luyenDanThuong` — twin thường rơi
  // về bộ chung cũ, đúng hành vi mà snapshot ấy được khắc.
  const luyenDanTwins = findQuests(profile, "Luyện Đan Đường");
  if (luyenDanTwins.length === 0) {
    log?.("Hồ sơ không có nhiệm vụ「Luyện Đan Đường」.");
  }
  for (const luyenDan of luyenDanTwins) {
    const ld = luyenDan.requiresVip === false
      ? config.quests?.luyenDanThuong ?? config.quests?.luyenDan
      : config.quests?.luyenDan;
    luyenDan.enabled = ld?.enabled === true;
    if (luyenDan.enabled) {
      setOption(luyenDan, "tier", ld.tier, { log });

      const decompose = findOption(luyenDan, "decompose");
      const keepFrom = ld.keepStarsFrom ?? 0;
      const match = (decompose?.choices ?? []).find((c) => keepLevelOf(c.value) === keepFrom);
      if (match) {
        setOption(luyenDan, "decompose", match.value, { log });
      } else {
        log?.(`Không có mức phân giải nào ứng với "giữ từ ${keepFrom} sao" — giữ mặc định.`);
      }
    }
  }

  // ---- Khoáng Mạch ---------------------------------------------------------------------
  // Cùng phép tách twin với Luyện Đan: `khoangMach` cho bản VIP, `khoangMachThuong` cho bản
  // thường. Snapshot đóng băng TRƯỚC schema 58 chỉ mang `khoangMach` dạng công-tắc (và đã bị
  // ép tắt từ thời stub), nên nhánh rơi-về của twin thường vô hại với chúng.
  const khoangMachTwins = findQuests(profile, "Khoáng Mạch");
  if (khoangMachTwins.length === 0) {
    log?.("Hồ sơ không có nhiệm vụ「Khoáng Mạch」.");
  }
  for (const khoangMach of khoangMachTwins) {
    const km = khoangMach.requiresVip === false
      ? config.quests?.khoangMachThuong ?? config.quests?.khoangMach
      : config.quests?.khoangMach;
    khoangMach.enabled = km?.enabled === true;
    if (khoangMach.enabled) {
      setOption(khoangMach, "mineType", String(km.mineType ?? "2"), { log });

      // Tên mỏ là chuỗi tự do (configs.ts đã làm sạch bằng sanitizeChatMessage — đích đến là
      // một literal trong nguồn evaluateJavaScript). RỖNG = đào tiếp mỏ đang ở, script pick
      // đọc chuỗi rỗng đúng nghĩa ấy nên vẫn phải được đặt vào, không được rơi về mặc định.
      setOption(khoangMach, "mineName", km.mineName ?? "", { allowFreeform: true, log });

      // Ngưỡng CHỐT LỜI — con số tự do như kickHp của Mê Cung; 0 = luôn nhận.
      setOption(khoangMach, "minBonus", String(km.minBonus ?? 0), { allowFreeform: true, log });

      // buyPhu và hostMode trên web là công tắc, trong hồ sơ là hai giá trị chuỗi mà «…» nghĩa
      // là tắt — cùng phép dịch với capCheck của Mê Cung ở trên.
      const phuOption = findOption(khoangMach, "buyPhu");
      const phuOff = phuOption?.choices?.find((c) => c.value.includes("«"));
      const phuOn = phuOption?.choices?.find((c) => !c.value.includes("«"));
      /**
       * SUẤT PHÙ CỦA NGÀY — cổng thứ hai, và là cổng DUY NHẤT sống qua việc đàn đổi khôi lỗi.
       *
       * Cổng thứ nhất nằm trong chính script cổng (một khoá `localStorage`), và nó chỉ nhớ
       * được trong PHẠM VI MỘT HỒ SƠ TRÌNH DUYỆT. Đàn thì không đứng yên một máy: đo trên đàn
       * 7cf87cfb ngày 15/08/2026 — mua lúc 17:10, chặn đúng ở 17:30 và 17:58, rồi MUA LẦN HAI
       * lúc 18:08 khi vòng ấy rơi vào một khôi lỗi khác với hồ sơ trắng. Khôi lỗi GitHub còn
       * tệ hơn: mỗi lượt Actions là một máy mới tinh, nên cổng ấy chưa bao giờ chặn được gì.
       *
       * Nên sổ thật nằm ở server (`automation_jobs.daily_done`, khoá `PHU_DAILY_MARK`) và
       * được đọc ngay tại đây: đã có dấu thì ép tuỳ chọn về TẮT, script cổng thậm chí không
       * còn nhánh nào để cân nhắc. Dấu được ghi ở bước chọn món trong tiệm (xem hồ sơ quest).
       */
      const phuSpent = doneToday.has(PHU_DAILY_MARK);
      const phuWanted = km.buyPhu === false || phuSpent ? phuOff : phuOn;
      if (phuWanted) setOption(khoangMach, "buyPhu", phuWanted.value, { log });
      if (phuSpent && km.buyPhu !== false) {
        log?.("Linh Quang Phù: đàn này đã mua đúng một lá hôm nay — vòng này không mua nữa.");
      }

      const hostOption = findOption(khoangMach, "hostMode");
      const hostOff = hostOption?.choices?.find((c) => c.value.includes("«"));
      const hostOn = hostOption?.choices?.find((c) => !c.value.includes("«"));
      const wanted = km.hostMode === true ? hostOn : hostOff;
      if (wanted) setOption(khoangMach, "hostMode", wanted.value, { log });

      setOption(khoangMach, "hostMinBonus", String(km.hostMinBonus ?? 100), { allowFreeform: true, log });
    }
  }

  // ---- Mười nhiệm vụ một-công-tắc ------------------------------------------------------
  for (const [key, name] of SIMPLE_QUESTS) {
    const quests = findQuests(profile, name);
    if (quests.length === 0) {
      log?.(`Hồ sơ không có nhiệm vụ「${name}」.`);
      continue;
    }
    const enabled = config.quests?.[key]?.enabled === true;
    for (const quest of quests) quest.enabled = enabled;
  }

  // ---- Khi ngọc giản đi TRƯỚC engine ----------------------------------------------------
  // Lớp dịch chỉ biết những khoá nó tự liệt kê ở trên; một khoá lạ trước nay rơi ra ngoài mà
  // không ai hay. Đó chính là chuyện đêm 06/08: một đạo hữu bật Hỷ Sự Đường, ngọc giản lưu
  // `hySuDuong: true`, snapshot của job mang nguyên giá trị ấy sang khôi lỗi — nhưng khôi lỗi
  // đang chạy gói cũ, `SIMPLE_QUESTS` của nó chưa có dòng nào tên vậy, nên nhiệm vụ biến mất
  // không để lại một dấu vết nào. Nhật ký chỉ liệt kê 7 nhiệm vụ và không hề nói vì sao thiếu
  // cái thứ 8; phải lần ngược snapshot trong database mới tìm ra.
  //
  // Cái vắng mặt vốn không tự nói. Nên ở đây nó được gọi tên: câu này biến "flow mới không
  // chạy" — một bí ẩn — thành "khôi lỗi cần cài đè", một việc làm được ngay.
  const knownKeys = new Set([
    ...SIMPLE_QUESTS.map(([key]) => key),
    "meCung",
    "luyenDan",
    "luyenDanThuong",
    "khoangMach",
    "khoangMachThuong",
  ]);
  for (const [key, value] of Object.entries(config.quests ?? {})) {
    if (value?.enabled === true && !knownKeys.has(key)) {
      log?.(
        `Ngọc giản đang bật nhiệm vụ '${key}' mà bản engine của khôi lỗi này không biết — ` +
          `khôi lỗi đang chạy gói cũ. Cài đè khôi lỗi để nhận nhiệm vụ mới.`,
      );
    }
  }

  return profile;
}
