/**
 * Đọc chuỗi cookie người dùng dán. Module LÁ: không import gì, không đụng đĩa, không biết
 * Playwright — và đó là toàn bộ lý do nó tồn tại tách khỏi runCycle.mjs.
 *
 * Server action cần đúng hàm này để soát cookie ngay lúc dán. Ở v0.13.0 nó import thẳng từ
 * `runCycle.mjs`, và cái giá là cả bộ engine bị kéo vào bundle của Next — trong đó
 * `profile.mjs` đọc `profile.json` bằng `readFileSync(fileURLToPath(new URL(…)))` ngay ở
 * thân module. Turbopack thay `URL` bằng bản của nó, nên `fileURLToPath` của Node từ chối:
 *
 *     TypeError: The "path" argument must be of type string or an instance of URL.
 *                Received an instance of URL
 *
 * Module chết lúc nạp, kéo sập MỌI server action của /dashboard — kể cả những action chẳng
 * liên quan gì tới cookie (phát/thu hồi linh phù). Trên máy dev không bao giờ tái hiện.
 *
 * Bài học nằm ở ranh giới, không nằm ở cái polyfill: mã chạy TRONG function của Next và mã
 * chạy trong worker là hai thế giới khác nhau. Thứ nào cần đi qua cả hai thì phải sạch —
 * không đĩa, không phụ thuộc.
 */

/**
 * Tên miền game. Site đổi TLD định kỳ (…mx → …am → …one), nên đây phải là cấu hình chứ
 * không phải hằng số — biến môi trường `GAME_BASE_URL` đè lên được, để một cú dời tên miền
 * chỉ tốn một lần sửa env thay vì một lần deploy.
 *
 * Cú dời 20/08/2026 (.one → .so) tốn NHIỀU NGÀY và năm lượt vá đi chữa nhầm chỗ: hằng số này
 * đứng im ở .one trong khi tông chủ đã đặt .so ở trang Tông Môn, mà giá trị ấy lại không có
 * đường nào tới khôi lỗi (xem cửa phát việc trong api/worker/route.ts). Triệu chứng đọc y hệt
 * một cú chặn của Cloudflare, nên cả năm lượt đều đi vá trình duyệt.
 *
 * Cú dời 07/08/2026 (.am → .one) tốn của tông môn nhiều giờ chạy vô ích, và bài học không
 * nằm ở con số này: cookie GẮN CHẶT vào tên miền, nên đổi tên miền là mọi phiên đăng nhập
 * đã lưu chết theo, và đạo hữu BẮT BUỘC phải dán lại chuỗi cookie lấy từ tên miền mới. Cổng
 * sẵn sàng giờ tự nhận ra cú 301 và nói thẳng điều đó (xem `movedTo` trong runCycle).
 */
export const DEFAULT_GAME_BASE_URL = "https://hoathinh3d.so";

/**
 * Chuẩn hoá thứ trưởng môn gõ vào ô tên miền thành một ORIGIN sạch, hoặc nói rõ vì sao không.
 *
 * Sống ở đây chứ không ở tầng action, vì cùng một luật phải áp cho cả người gõ lẫn giá trị
 * đã nằm trong database: một origin lệch chuẩn (thừa dấu `/`, lẫn đường dẫn, thiếu scheme)
 * đi vào `new URL(path, base)` sẽ đẻ ra những URL sai lặng lẽ — và cái giá của một tên miền
 * sai là TOÀN BỘ automation đứng im, đúng như đêm 07/08.
 *
 * Nhận cả dạng trần「hoathinh3d.one」lẫn dạng đầy đủ; trả về đúng origin, không đuôi `/`.
 * Chỉ http/https — một scheme lạ ở đây là dấu hiệu gõ nhầm, không phải nhu cầu thật.
 *
 * @param {string} raw
 * @returns {{ ok: true, baseUrl: string } | { ok: false, error: string }}
 */
export function normalizeGameBaseUrl(raw) {
  const text = String(raw ?? "").trim();
  if (text.length === 0) {
    return { ok: false, error: "Tên miền không được để trống." };
  }
  if (text.length > 200) {
    return { ok: false, error: "Tên miền dài quá mức hợp lý (tối đa 200 ký tự)." };
  }
  // Khoảng trắng giữa chuỗi là dấu hiệu dán nhầm cả câu, không phải một tên miền.
  if (/\s/.test(text)) {
    return { ok: false, error: "Tên miền không được chứa khoảng trắng." };
  }

  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `Không đọc được「${text}」như một tên miền.` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Chỉ nhận http hoặc https." };
  }
  // Phải có dấu chấm và không được là địa chỉ rỗng: "localhost" hay "abc" gần như luôn là
  // gõ nhầm ở đây, và một tên miền gõ nhầm làm cả tông môn đứng im.
  if (!url.hostname.includes(".") || url.hostname.startsWith(".") || url.hostname.endsWith(".")) {
    return { ok: false, error: `「${url.hostname}」không giống một tên miền đầy đủ.` };
  }

  return { ok: true, baseUrl: url.origin };
}

/**
 * Chuỗi cookie người dùng dán → mảng cookie của Playwright. Hiểu MỌI định dạng hợp lý:
 *
 *   • `document.cookie` / header: "wordpress_logged_in_…=…; wordpress_sec_…=…"
 *   • Bản xuất JSON của chính bản desktop: {"url": …, "cookies": [{name, value, domain, …}]}
 *   • Mảng JSON trần của các extension Cookie-Editor: [{name, value, …}]
 *   • Object phẳng: {"tên": "giá trị"}
 *
 * Dễ tính là BẮT BUỘC ở đây, vì bài học 02/08 (job 2d6d4a73): người dùng dán bản xuất JSON
 * từ desktop — hành động hợp lý nhất trần đời — và parser cũ chỉ hiểu dạng chuỗi nên trả về
 * MẢNG RỖNG, không một lời phàn nàn. Browser đi tay trắng, /me-cung đá về trang chủ, và lỗi
 * nổi lên tận `#lobby-overview` dưới cái tên một selector vô tội. Người gọi phải coi kết
 * quả rỗng là LỖI TO — một chuỗi 1.455 ký tự ra số không thì chắc chắn không phải ý người dán.
 */
export function parseCookieString(raw, url) {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* url hỏng thì bỏ lọc theo domain */
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
          ? parsed.cookies
          : null;

      if (list) {
        const cookies = [];
        for (const c of list) {
          if (!c || typeof c.name !== "string" || !c.name || typeof c.value !== "string") continue;

          // Chỉ giữ cookie thuộc đúng site đang nhắm tới: bản "export tất cả" của extension
          // không được phép tiêm cookie của site khác vào phiên game.
          const domain = typeof c.domain === "string" && c.domain ? c.domain : "";
          const bare = domain.replace(/^\./, "");
          if (bare && host && !host.endsWith(bare) && !bare.endsWith(host)) continue;

          const cookie = { name: c.name, value: c.value };
          if (domain) {
            cookie.domain = domain;
            cookie.path = typeof c.path === "string" && c.path ? c.path : "/";
          } else {
            cookie.url = url;
          }

          const expires = Number(c.expirationDate ?? c.expires);
          if (Number.isFinite(expires) && expires > 0) cookie.expires = Math.floor(expires);
          if (typeof c.secure === "boolean") cookie.secure = c.secure;
          if (typeof c.httpOnly === "boolean") cookie.httpOnly = c.httpOnly;
          cookies.push(cookie);
        }
        return cookies;
      }

      if (parsed && typeof parsed === "object") {
        return Object.entries(parsed)
          .filter(([name, value]) => name && typeof value === "string")
          .map(([name, value]) => ({ name, value, url }));
      }
    } catch {
      // Trông như JSON mà không parse được — rơi xuống đường chuỗi, biết đâu vẫn ra gì đó.
    }
  }

  // Dạng chuỗi: bỏ tiền tố "Cookie:" nếu người dùng copy nguyên header, nhận cả xuống dòng
  // làm dấu ngăn, chỉ tách ở dấu `=` ĐẦU TIÊN (giá trị cookie WordPress có chứa `=` bên trong).
  const cookies = [];
  for (const part of text.replace(/^cookie:\s*/i, "").split(/[;\n]/)) {
    const chunk = part.trim();
    if (!chunk) continue;

    const eq = chunk.indexOf("=");
    if (eq <= 0) continue;

    const name = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    if (!name) continue;

    cookies.push({ name, value, url });
  }
  return cookies;
}

/**
 * Cookie phiên đăng nhập của WordPress. Tên đầy đủ mang hậu tố COOKIEHASH (băm từ siteurl)
 * nên khác nhau ở mỗi site — chỉ nhận diện được bằng TIỀN TỐ, không so bằng nhau được.
 */
export const LOGIN_COOKIE_PREFIX = "wordpress_logged_in_";

/**
 * Tên nhân vật trong game, đọc ra từ cookie đăng nhập. Dùng để tự đặt nhãn cho tài khoản khi
 * đạo hữu bỏ trống ô「Tên gợi nhớ」— cùng phép với bản PC (`GameAccount.ExtractWordPressUser`),
 * để hai bản gọi cùng một tài khoản bằng cùng một cái tên.
 *
 * Giá trị cookie có dạng `user|expiry|token|hmac` và đã được URL-encode, nên tên nằm ở đoạn
 * trước dấu `|` đầu tiên.
 *
 * Sống ở module LÁ này chứ không nằm trong server action, vì đây là kiến thức về ĐỊNH DẠNG
 * COOKIE — đúng thứ tệp này giữ, và cũng là nơi duy nhất bộ smoke test với tới được (server
 * action kéo theo next/cache và cả tầng database, không đơn vị hoá được).
 *
 * Hai chỗ CỐ Ý khác bản PC, cả hai đều là ca xấu nhất chứ không phải ca thường:
 *
 *  1. `decodeURIComponent` NÉM khi gặp phần trăm hỏng (`%zz`, hay một dấu `%` lạc lõng), khác
 *     `WebUtility.UrlDecode` bên C# vốn im lặng để nguyên. Một chuỗi dán thiếu đuôi là đủ dựng
 *     ra cảnh ấy, mà một cái tên gợi nhớ thì không đáng để làm hỏng cả lượt lưu tài khoản —
 *     nên bắt lại và dùng giá trị thô.
 *  2. Bản PC lấy `pipe > 0 ? decoded[..pipe] : decoded`, tức giá trị bắt đầu bằng `|` cho ra
 *     NGUYÊN chuỗi làm tên. Ở đây đoạn đầu rỗng nghĩa là không đọc được tên → trả `null` để
 *     rơi về tên đánh số, thay vì khắc một chuỗi rác lên nhãn người ta phải nhìn mỗi ngày.
 *
 * @param {Array<{ name: string, value: string }>} jar Kết quả của `parseCookieString`.
 * @returns {string | null} Tên đọc được, hoặc null khi không có cookie đăng nhập nào đọc nổi.
 */
export function detectWordPressUser(jar) {
  const cookie = (jar ?? []).find(
    (c) => typeof c?.name === "string" && c.name.toLowerCase().startsWith(LOGIN_COOKIE_PREFIX),
  );
  if (!cookie || typeof cookie.value !== "string" || !cookie.value) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(cookie.value);
  } catch {
    decoded = cookie.value;
  }

  const pipe = decoded.indexOf("|");
  const user = (pipe >= 0 ? decoded.slice(0, pipe) : decoded).trim();
  return user.length > 0 ? user : null;
}
