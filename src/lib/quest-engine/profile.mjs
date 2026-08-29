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
 * Tên NGƯỜI ĐỌC của một mục cài đặt, và của một lựa chọn.
 *
 * Hồ sơ đã mang sẵn `label` cho mọi option lẫn mọi choice — thứ chính giao diện Ngọc Giản
 * đang hiện. Những câu dưới đây từng gọi option bằng KHOÁ nội bộ (`kickIdle`, `minBonus`),
 * mà khoá ấy chỉ có nghĩa với người viết mã: người dùng đọc「Option 'kickIdle'」thì không
 * biết mình vừa đặt cái gì. Nhãn có sẵn ngay trong dữ liệu, chỉ là chưa ai dùng tới.
 *
 * Rơi về khoá (có nháy) khi thiếu nhãn: thà lộ khoá còn hơn để câu cụt mất chủ ngữ.
 */
const tenMuc = (option, key) => option?.label?.trim() || `'${key}'`;
const tenLuaChon = (option, value) =>
  (option?.choices ?? []).find((c) => c.value === value)?.label?.trim() || value;

/**
 * Đặt giá trị cho một option, và nói thật khi giá trị không nằm trong danh sách.
 *
 * Đây là chỗ dễ mất tiếng nhất trong cả lớp dịch: `buildOptionValues` của engine, gặp một
 * `selectedValue` không lựa chọn nào mang, sẽ rơi về lựa chọn ĐẦU TIÊN. Với ngưỡng trục
 * xuất, lựa chọn đầu là "Không trục xuất" — nghĩa là một người gõ 250.000 sẽ lặng lẽ được
 * một lượt chạy không trục xuất ai. Nên giá trị lạ được nhận NGUYÊN VĂN qua `allowCustom`,
 * và việc đó được ghi lại.
 */
function setOption(quest, key, value, { allowFreeform = false, log, describe } = {}) {
  const option = findOption(quest, key);
  if (!option) {
    log?.(`「${quest?.name}」· không có mục cài đặt '${key}' trong gói nhiệm vụ này — bỏ qua mục ấy.`);
    return;
  }

  // `describe` chỉ đổi LỜI KỂ, không đổi giá trị đặt vào. Có mặt vì mấy dòng này đi thẳng ra
  // màn hình người dùng (runCycle kể chúng ở mức `warn`), mà một vài giá trị tự nhập không
  // phải thứ để đọc: danh sách hạn mức giữ đan là gần ba nghìn ký tự máy sinh ra. Kể nguyên
  // văn là biến bảng hoạt động thành bãi rác; giấu hẳn thì mất luôn tiếng nói của
  // `allowCustom` — thứ ghi chú ngay trên giải thích vì sao phải có.
  const spoken = describe ?? `'${value}'`;
  const known = (option.choices ?? []).some((c) => c.value === value);
  if (!known) {
    if (!allowFreeform) {
      log?.(
        `「${quest.name}」· ${tenMuc(option, key)}: không dùng được giá trị ${spoken}, ` +
          `giữ nguyên mức "${tenLuaChon(option, option.selectedValue)}".`,
      );
      return;
    }
    option.allowCustom = true;
    // Giá trị RỖNG là「chưa đặt」, không phải「đạo hữu tự đặt」— nên nhận thì vẫn nhận, nhưng
    // đừng kể. Đo 25/08/2026: `mineName` của Khoáng Mạch mặc định rỗng, nên MỌI người dùng chỉ
    // bật nhiệm vụ rồi không gõ gì cũng ăn một dòng vàng「dùng giá trị đạo hữu tự đặt ''」—
    // vừa sai nghĩa vừa sai màu. Rỗng ở đây có nghĩa riêng của nó (tên mỏ rỗng = đào tiếp mỏ
    // đang ở), và cái nghĩa ấy là MẶC ĐỊNH, tức không phải tin.
    if (String(value).trim().length > 0) {
      log?.(`「${quest.name}」· ${tenMuc(option, key)}: dùng giá trị đạo hữu tự đặt ${spoken}.`);
    }
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
 * Trần khi rải danh sách「đan trong túi」. Bản chụp DOM ngày 12/08/2026 cho thấy sức chứa là
 * `x/10 viên` mỗi phẩm, nên 30 đã rộng gấp ba — và một cái trần là bắt buộc, vì phép so của
 * `conditionProbe` là SO CHUỖI chứ không phải so số, tức mỗi con số hợp lệ phải được viết ra.
 *
 * Túi vượt qua trần này thì hạn mức thôi nhận ra — và đó là phía AN TOÀN có chủ ý: cửa không
 * khớp nghĩa là GIỮ NGUYÊN đan, chứ không phải phân giải nhầm. Phải trùng với `BagCountCeiling`
 * bên `DefaultQuestProfile.cs`, và phải lớn hơn trần của `keepCap` trong `configs.ts`.
 */
const BAG_COUNT_CEILING = 30;

/**
 * Danh sách chặn cho câu hỏi「trong túi đang có TỪ `from` viên trở lên」.
 *
 * Hộp thông tin viên đan viết số ấy thành `Đan trong túi (phẩm)` / `5/10 viên` — hai khối `dt`
 * và `dd` liền nhau, nên `innerText` gộp lại thành một chuỗi mà `norm()` bỏ dấu rồi ghép bằng
 * dấu cách. Mỗi mảnh dưới đây vì thế kết thúc bằng ĐÚNG dấu `/`, và cái dấu ấy làm cả phép so
 * thành chính xác chứ không phải gần đúng: thiếu nó thì mảnh「… 1」sẽ khớp luôn cả「… 11/10」
 * (so chuỗi là so chứa, không có ranh giới từ), tức một túi 11 viên bị đọc thành 1 viên.
 *
 * Rải từng số thay vì so số vì cửa chặn của engine chỉ biết `textMatches` trên một danh sách
 * `a|b|c`. Đổi lại, cửa ấy đã được đo bằng Chromium thật (`verify:luyen-dan-stars`) và không
 * phải thêm một hình dạng điều kiện mới nào vào hồ sơ.
 */
function bagCountAtLeast(from) {
  const parts = [];
  for (let n = Math.max(1, from); n <= BAG_COUNT_CEILING; n += 1) {
    parts.push(`đan trong túi (phẩm) ${n}/`);
  }
  return parts.join("|");
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
 * @param {(msg: string) => void} [say]  nơi kể lại những chỗ dịch không khớp. MỖI CÂU ĐÚNG
 *   MỘT LẦN — xem `log` bên dưới.
 * @param {Iterable<string>} [marksToday]  sổ ngày của đàn (`daily_done.questIds`) — những gì
 *   đã làm xong hôm nay. Vắng mặt = sổ trắng, đúng nghĩa cho mọi người gọi chỉ muốn dịch cấu
 *   hình (smoke test, lưới kiểm chứng) chứ không chạy một vòng thật.
 */
export function profileForConfig(config, say, marksToday) {
  const doneToday = marksToday instanceof Set ? marksToday : new Set(marksToday ?? []);
  const profile = loadProfile();

  /**
   * Mỗi câu ĐÚNG MỘT LẦN, chặn ngay tại cửa ra.
   *
   * Từ schema 45 mỗi tên nhiệm vụ là một CẶP flow (VIP + thường) dùng chung cấu hình, nên mọi
   * vòng dịch bên dưới chạy hai lượt và `setOption` kể lại y hệt hai lần. Nhật ký của đàn vì
   * thế mang từng đôi một: đo trên bản ghi thật 19/08/2026 là 414 dòng thừa trong ba ngày,
   * kiểu「「Mê Cung」· Trục xuất nếu không sẵn sàng sau (giây): dùng giá trị đạo hữu tự đặt
   * '20'.」cách nhau 156ms.
   *
   * Lọc được ở đây mà không mất mát gì, vì TÊN NHIỆM VỤ nằm sẵn trong mọi câu: trùng chữ
   * nghĩa là trùng cả nhiệm vụ lẫn option, tức đúng một sự thật được nói hai lần. Đặt ở cửa
   * ra chứ không ở từng vòng dịch — người gọi nào cũng khỏi phải tự lọc, và một vòng dịch
   * thêm sau này không kéo cái lỗi ấy sống lại.
   */
  const said = new Set();
  const log = (message) => {
    if (said.has(message)) return;
    said.add(message);
    say?.(message);
  };

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

      // HẠN MỨC GIỮ ĐAN. Hai chế độ là hai option KHÁC NHAU trong hồ sơ, và mỗi lượt dịch chỉ
      // thắp lên đúng một cái: `capOver` mở nhánh phân giải viên dư, `capFull` mở nhánh dừng
      // khai lô. Cái không được thắp giữ nguyên giá trị mặc định «không hạn mức» — một chuỗi
      // không lời văn nào của trang chứa nổi, nên nhánh của nó câm hẳn. Cùng mẹo với
      // «luôn phân giải» ở trên: một danh sách chặn tắt hẳn bằng cách không khớp gì cả.
      //
      // `keepFrom === 0` là「Phân giải tất cả」— không giữ viên nào thì hạn mức giữ đan không
      // có gì để đếm. Form đã khoá công tắc ở mức đó; đây là lớp gác thứ hai cho những ngọc
      // giản lưu từ trước, và cho cả đường API.
      const capOn = ld.keepCapEnabled === true && keepFrom !== 0;
      if (capOn) {
        const cap = Number(ld.keepCap);
        if (!Number.isInteger(cap) || cap < 1) {
          log?.(`Hạn mức giữ đan '${ld.keepCap}' không phải một số viên hợp lệ — bỏ qua hạn mức.`);
        } else {
          // stop  → dừng NGAY KHI đủ hạn mức, nên đếm từ chính `cap`.
          // decompose → chỉ đụng tới viên VƯỢT hạn mức, nên đếm từ `cap + 1`.
          const stop = ld.keepCapMode === "stop";
          const list = bagCountAtLeast(stop ? cap : cap + 1);
          if (list) {
            setOption(luyenDan, stop ? "capFull" : "capOver", list, {
              allowFreeform: true,
              log,
              describe: stop
                ? `hạn mức giữ đan ${cap} viên — đủ thì thôi khai lô`
                : `hạn mức giữ đan ${cap} viên — dư thì phân giải`,
            });
          } else {
            log?.(`Hạn mức giữ đan ${cap} viên vượt trần ${BAG_COUNT_CEILING} — bỏ qua hạn mức.`);
          }
        }
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
