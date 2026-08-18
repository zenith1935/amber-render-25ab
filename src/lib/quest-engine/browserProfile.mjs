/**
 * Chọn hồ sơ Chromium cho đúng CHỦ và đúng COOKIE mà chủ vừa lưu.
 *
 * Worker tông môn nhận job của nhiều người. Dùng một `browser-profile` chung khiến cookie
 * đăng nhập còn sống của người chạy trước thắng cookie trong job chạy sau. Cũng chính lỗi đó
 * làm một người đổi từ tài khoản VIP sang tài khoản thường nhưng Chromium vẫn giữ VIP cũ.
 *
 * Mỗi cặp (user, chuỗi cookie đã lưu) vì thế có một profile riêng. Hash giữ bí mật khỏi tên
 * thư mục; cookie site tự refresh vẫn sống bền trong profile ấy qua các vòng. Khi người dùng
 * dán cookie khác, fingerprint đổi và worker bắt đầu bằng profile sạch — cookie mới chắc chắn
 * được tiêm, không phải đoán phiên cũ còn thuộc tài khoản nào.
 */
import { createHash } from "node:crypto";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Hình dạng tên thư mục, đặt tên một lần rồi dùng chung: `profileDirForJob` DỰNG nó lên còn
 * `sweepStaleProfiles` ĐỌC nó ra. Hai nơi tự gõ lấy chuỗi là chỉ chờ ngày một bên đổi tiền tố
 * còn bên kia lặng lẽ thôi tìm thấy gì — tức phép dọn ngừng dọn mà không báo một tiếng.
 */
const OWNER_PREFIX = "user-";
const ACCOUNT_PREFIX = "account-";

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function profileDirForJob(rootDir, { userId, gameCookie }) {
  const owner = String(userId ?? "").trim();
  const cookie = String(gameCookie ?? "").trim();
  if (!owner) throw new Error("Job thiếu userId — không thể chọn hồ sơ trình duyệt an toàn.");
  if (!cookie) throw new Error("Job thiếu cookie — không thể chọn hồ sơ trình duyệt.");

  const root = path.resolve(rootDir);
  const ownerKey = fingerprint(owner);
  const accountKey = fingerprint(`${owner}\0${cookie}`);
  return path.join(root, `${OWNER_PREFIX}${ownerKey}`, `${ACCOUNT_PREFIX}${accountKey}`);
}

/** Thư mục con, bỏ qua mọi thứ không phải thư mục và mọi lỗi đọc. */
async function subdirectories(dir, prefix) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Gốc chưa tồn tại (máy chưa chạy job nào) hoặc không đọc được. Cả hai đều nghĩa là
    // "không có gì để dọn" — dọn nhà không phải việc đáng ném.
    return [];
  }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => e.name);
}

/**
 * Xoá những hồ sơ Chromium lâu không ai đụng tới.
 *
 * VÌ SAO CẦN: mỗi lần người dùng dán chuỗi cookie MỚI là fingerprint đổi và một thư mục hồ sơ
 * mới ra đời — thư mục cũ thành rác vĩnh viễn, vì không đường nào dẫn về nó nữa. Không ai dọn
 * thì chúng nằm đó mãi. Đo trên VM ngày 09/08/2026: 9 hồ sơ, 2,7GB, và chỉ ĐÚNG MỘT cái được
 * dùng trong ngày.
 *
 * ĐO TUỔI BẰNG `mtime` CỦA THƯ MỤC HỒ SƠ: Chromium thêm/xoá tệp ngay trong gốc hồ sơ mỗi
 * phiên (LOCK, các tệp journal), nên mtime thư mục phản ánh đúng lần chạy cuối — đã đối chiếu
 * trên VM: hồ sơ của job chạy hôm ấy mang mtime của chính giờ chạy.
 *
 * KHÔNG dùng số lượng làm tiêu chí ("giữ N cái mới nhất mỗi người"): một đạo hữu nuôi nhiều
 * tài khoản game song song là chuyện BÌNH THƯỜNG và được thiết kế để làm được, nên nhiều hồ sơ
 * dưới cùng một người không hề là dấu hiệu của rác.
 *
 * Người gọi phải bảo đảm KHÔNG job nào đang chạy — xem chỗ gọi trong worker.mjs. Ngưỡng tuổi
 * rộng là lớp phòng thủ thứ hai, không phải lớp duy nhất.
 *
 * Không bao giờ ném: trả về số đếm để người gọi kể lại.
 */
export async function sweepStaleProfiles(rootDir, { maxAgeMs, now = Date.now() }) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    // Chặn ngay tại đây thay vì "dọn tất": một biến môi trường gõ sai không được phép biến
    // phép dọn thành phép xoá sạch mọi phiên đăng nhập của mọi người.
    throw new Error(`sweepStaleProfiles: maxAgeMs phải là số dương, nhận ${maxAgeMs}.`);
  }

  const root = path.resolve(rootDir);
  let removed = 0;
  let kept = 0;
  let failed = 0;

  for (const ownerName of await subdirectories(root, OWNER_PREFIX)) {
    const ownerDir = path.join(root, ownerName);

    for (const accountName of await subdirectories(ownerDir, ACCOUNT_PREFIX)) {
      const accountDir = path.join(ownerDir, accountName);
      let mtimeMs;
      try {
        ({ mtimeMs } = await stat(accountDir));
      } catch {
        failed++;
        continue;
      }

      if (now - mtimeMs <= maxAgeMs) {
        kept++;
        continue;
      }

      try {
        await rm(accountDir, { recursive: true, force: true });
        removed++;
      } catch {
        // Đang bị khoá, hoặc thiếu quyền. Lần quét sau gặp lại.
        failed++;
      }
    }

    // Thư mục người dùng rỗng thì dọn nốt. `rmdir` chứ KHÔNG phải `rm({recursive:true})`, và
    // đây là chỗ đáng cân nhắc: rmdir tự ném ENOTEMPTY khi bên trong còn thứ gì, nên nó không
    // bao giờ xoá nhầm một hồ sơ ta vừa quyết định giữ, hay một tệp lạ ai đó để đó. Phép xoá
    // đệ quy ở tầng này thì có — chỉ cần một nhịp sai là mất sạch phiên đăng nhập của một
    // người. Lỗi nào cũng bỏ qua: thư mục rỗng không tốn gì, lần quét sau thử lại.
    try {
      await rmdir(ownerDir);
    } catch {
      /* còn hồ sơ bên trong, còn tệp lạ, hoặc job mới vừa dựng lại — đều không phải việc phải lo */
    }
  }

  return { removed, kept, failed };
}
