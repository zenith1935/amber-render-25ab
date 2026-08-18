/**
 * Lớp mỏng giữa bộ thông dịch và một `Page` của Playwright.
 *
 * Port từ `PlaywrightBrowserSession.cs`, chỉ giữ đúng những thao tác engine gọi tới. Mọi
 * phương thức đều NUỐT lỗi và trả về false/null thay vì ném: một selector sai phải xuống
 * cấp thành "bước này hỏng", không bao giờ thành sập cả lượt chạy.
 */

import { parseCooldownSeconds } from "./cooldown.mjs";

/**
 * Bỏ dấu, hạ chữ thường, chỉ giữ chữ và số, cách nhau đúng một khoảng trắng.
 *
 * Đây là dạng so sánh của đáp án trắc nghiệm. `đ` phải xử lý bằng tay vì nó không phân rã
 * dưới NFD như "ế" — quên nó thì "đúng" và "dung" không còn là một.
 */
export function foldText(value) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Gộp call log của Playwright thành một dòng đọc được: câu đầu cộng vài dòng trạng thái
 * cuối, nơi phán quyết actionability thật sự nằm.
 *
 * Có mặt vì call log là NHÂN CHỨNG DUY NHẤT gọi được tên thứ chặn một cú click ("<div …>
 * intercepts pointer events", "element is outside of the viewport", "not stable"). Bản
 * desktop từng vứt nó đi và trả về "not available" trống rỗng; mười hai cú #btn-start hỏng
 * liên tiếp trong đêm 01/08 vì thế mà mất luôn lời giải thích.
 */
function squashCallLog(message) {
  const lines = [];
  for (const raw of String(message ?? "").split("\n")) {
    const line = raw.trim().replace(/^[-\s]+/, "");
    if (!line || /^call log/i.test(line)) continue;
    if (!lines.includes(line)) lines.push(line);
  }

  const tail = lines.length > 4 ? lines.slice(-3) : lines.slice(1);
  const summary = [...lines.slice(0, 1), ...tail].join(" | ");
  return summary.length > 300 ? summary.slice(0, 300) + "…" : summary;
}

/** Hai URL trỏ cùng một trang (bỏ qua hash và dấu / cuối). */
function sameUrl(a, b) {
  const strip = (u) => {
    try {
      const url = new URL(u);
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return String(u ?? "").replace(/\/$/, "");
    }
  };
  return strip(a) === strip(b);
}

/**
 * @param {import('playwright-core').Page} page
 * @param {{ baseUrl: string, log: {info:Function,debug:Function,warning:Function},
 *           minActionDelayMs?: number, maxActionDelayMs?: number, pageTimeoutMs?: number }} options
 */
export function createSession(page, options) {
  const log = options.log;
  const minDelay = Math.max(0, options.minActionDelayMs ?? 700);
  const maxDelay = Math.max(minDelay + 1, options.maxActionDelayMs ?? 1800);
  const pageTimeoutMs = options.pageTimeoutMs ?? 45_000;

  return {
    page,

    /**
     * Nghỉ bao lâu sau mỗi cú bấm trong lượt quét theo nhãn — lấy từ chính nhịp người dùng
     * đã đặt, chặn hai đầu để không bao giờ ngắn tới mức đua với popup, cũng không dài tới
     * mức một bảng nhiệm vụ mất cả phút.
     */
    postClickWaitMs: Math.min(4000, Math.max(800, Math.round((minDelay + maxDelay) / 2))),

    /** Ghép đường dẫn tương đối của quest lên tên miền game. */
    resolveUrl(pathOrUrl) {
      const value = String(pathOrUrl ?? "/");
      if (/^https?:\/\//i.test(value)) return value;
      return new URL(value, options.baseUrl).toString();
    },

    /**
     * Điều hướng — và khi đã đứng sẵn ở đúng URL thì RELOAD CỨNG, không bỏ qua.
     *
     * Site làm hết hạn một trang ngồi không quá lâu: DOM vẫn dựng, trông vẫn bình thường,
     * nhưng click thôi không ăn nữa và chẳng có dấu hiệu nào nói vậy. Giữa hai chu kỳ trình
     * duyệt đậu hàng phút tới hàng giờ, rất thường là đúng trên URL mà lượt sau cần. Nên
     * "đang ở đúng trang rồi" chính xác là trường hợp KHÔNG được phép bỏ qua tải lại.
     */
    async navigate(url) {
      try {
        if (sameUrl(page.url(), url)) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: pageTimeoutMs });
          return { ok: true, url: page.url() };
        }

        // Cố ý KHÔNG chờ mạng rảnh sau đó. Site này không bao giờ rảnh: nó long-poll tin
        // nhắn và giữ một socket mở, nên cái chờ ấy hết hạn nguyên vẹn ở MỌI lần điều
        // hướng. Mọi script quest đều tự mở đầu bằng việc chờ đúng phần tử nó cần.
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: pageTimeoutMs });
        // Trả về nơi THẬT SỰ dừng chân, không phải nơi định đến: site đổi TLD định kỳ và
        // tên miền cũ 301 sang tên miền mới, nên hai giá trị này có ngày khác nhau — và
        // ngày ấy, khoảng cách giữa chúng là toàn bộ lời giải thích.
        return { ok: true, url: page.url() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /**
     * Chạy một hàm (hoặc một chuỗi mã nguồn) trong trang. Trả về undefined khi hỏng — người
     * gọi phân biệt bằng giá trị, không bằng try/catch.
     *
     * Chuỗi được bọc lại trước khi chạy, và đó KHÔNG phải chuyện thẩm mỹ. Mọi script trong
     * hồ sơ quest đều viết dạng `() => {...}`, vì bản .NET của Playwright tự nhận ra một hàm
     * và GỌI nó. Bản JavaScript thì không: `page.evaluate("() => 'x'")` đánh giá biểu thức
     * ra một function rồi cố serialize nó về, và trả `undefined`. Để nguyên thì mọi bước
     * `evaluateJavaScript` im lặng trả về undefined — nghĩa là toàn bộ tường thuật Mê Cung,
     * mọi quyết định trục xuất, mọi lần đọc bảng điểm đều mất tiếng mà không có một dòng lỗi
     * nào. Bọc rồi kiểm `typeof` phục hồi đúng ngữ nghĩa bản desktop, và vẫn để nguyên
     * những script viết dạng biểu thức thuần.
     */
    async evaluate(fnOrSource, arg) {
      try {
        if (typeof fnOrSource === "string") {
          const source = `(() => { const v = (${fnOrSource}); return typeof v === "function" ? v() : v; })()`;
          return await page.evaluate(source);
        }

        return arg === undefined
          ? await page.evaluate(fnOrSource)
          : await page.evaluate(fnOrSource, arg);
      } catch (err) {
        log.debug(`Evaluate hỏng: ${squashCallLog(err instanceof Error ? err.message : String(err))}`);
        return undefined;
      }
    },

    async waitForSelector(selector, timeoutMs) {
      if (!selector || !selector.trim()) return false;
      try {
        await page.waitForSelector(selector, { timeout: timeoutMs, state: "visible" });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * @param force Bỏ qua chờ actionability của Playwright và bấm vào hộp hiện tại của phần
     * tử. Dành cho control mà site ĐANG ANIMATE: nút BẮT ĐẦU của Mê Cung đập dưới lớp
     * ready-glow, hộp bao của nó không đứng yên nổi hai khung hình liên tiếp, và mọi cú
     * click thường đều chết vì "waiting for element to be visible, enabled and stable" —
     * trên đúng cái nút mà chính quest vừa dò thấy sẵn sàng. Chỉ dùng cho bước nào có guard
     * kiểm lại được những gì bị bỏ qua.
     */
    async click(selector, timeoutMs, force = false) {
      if (!selector || !selector.trim()) return false;
      try {
        await page.click(selector, { timeout: timeoutMs, force });
        return true;
      } catch (err) {
        log.debug(`Click '${selector}' hỏng — ${squashCallLog(err instanceof Error ? err.message : String(err))}`);
        return false;
      }
    },

    async clickByText(text, timeoutMs) {
      if (!text || !text.trim()) return false;
      try {
        await page.getByText(text, { exact: false }).first().click({ timeout: timeoutMs });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Bấm đáp án trắc nghiệm qua ĐƯỜNG NHẬP LIỆU THẬT, không bao giờ bằng `el.click()` trong
     * trang: trang đố dùng `isTrusted` để lọc, nên click tổng hợp bị bỏ qua thẳng thừng —
     * nhật ký 01/08 00:03 là sáu đáp án giải đúng, bấm vào trang, không cú nào được ghi
     * nhận, và cùng một câu hỏi phục vụ lại mãi.
     *
     * `preferredIndex` chỉ là gợi ý: site xáo thứ tự giữa các câu, nên TEXT mới là thứ
     * quyết định. Gợi ý chỉ giúp khỏi phải đọc hết đáp án trên đường thường gặp.
     */
    async clickOptionByText(optionsSelector, expectedText, preferredIndex, timeoutMs) {
      if (!optionsSelector?.trim() || !expectedText?.trim()) return false;

      try {
        const wanted = foldText(expectedText);
        const options = page.locator(optionsSelector);
        const count = await options.count();

        const readOption = async (index) => {
          try {
            return await options.nth(index).innerText({ timeout: 2000 });
          } catch {
            return null;
          }
        };

        let target = -1;
        if (preferredIndex >= 0 && preferredIndex < count &&
            foldText(await readOption(preferredIndex)) === wanted) {
          target = preferredIndex;
        }

        for (let i = 0; target < 0 && i < count; i++) {
          if (foldText(await readOption(i)) === wanted) target = i;
        }

        if (target < 0) return false;

        await options.nth(target).click({ timeout: timeoutMs });
        return true;
      } catch {
        return false;
      }
    },

    async getText(selector) {
      if (!selector || !selector.trim()) return null;
      try {
        return await page.locator(selector).first().innerText({ timeout: 5000 });
      } catch {
        return null;
      }
    },

    /** Nhịp nghỉ giữa hai thao tác, để lượt chạy không có nhịp của một cái máy. */
    async humanDelay() {
      const ms = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
      await new Promise((r) => setTimeout(r, ms));
    },

    /** Dùng lại parser cooldown cho bước đọc đồng hồ. */
    parseCooldownSeconds,
  };
}
