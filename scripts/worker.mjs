#!/usr/bin/env node
/**
 * KHÔI LỖI THAM CHIẾU — reference worker.
 *
 * Đây là nửa còn lại của lời hứa "bấm Khai Đàn rồi tắt browser vẫn chạy". Vercel không thể
 * giữ một phiên Chromium 35 phút: function của nó sống theo request và bị cắt sau vài phút.
 * Nên web chỉ làm control plane — nó GIỮ ý định của người dùng trong database — còn việc
 * mở browser thật thì do tiến trình này làm, trên một cái máy chạy liên tục (VPS, máy nhà,
 * Fly.io, Railway… bất cứ chỗ nào chạy được Node dài hạn).
 *
 * Vòng đời một vòng: xin việc → nhận config snapshot → chạy → kể chuyện qua `event` → nhịp
 * tim mỗi 5 giây (và nghe xem người dùng có bấm Thu Đàn không) → báo kết quả. Server đặt
 * `nextRunAt` rồi trả cùng job về hàng chờ; worker cũ lẫn mới đều tự nhận vòng kế.
 *
 * Phần điều khiển trình duyệt là engine dùng chung ở `src/lib/quest-engine` — cùng bộ thông
 * dịch và cùng hồ sơ quest với bản desktop, nên tri thức về site chỉ có một bản gốc.
 *
 * Token quyết định VAI TRÒ, server tự phân xử — worker không cần khai gì:
 *   • WORKER_TOKEN của deployment (khôi lỗi tông môn) → nhận job của mọi thành viên.
 *   • Linh phù cá nhân phát ở mục Khôi Lỗi           → chỉ nhận job của chính chủ.
 *
 *   WEB_URL=https://<app>.vercel.app WORKER_TOKEN=... node scripts/worker.mjs
 *
 * WORKER_SOLVE_TURNSTILE=1 bật cú tự bấm ô Turnstile khi vấp màn Cloudflare (mặc định TẮT).
 * Chỉ giúp màn tương tác, và KHÔNG chữa được gốc IP trung tâm dữ liệu — bật cho máy IP dân dụng.
 * Chi tiết ở runCycle.mjs (khối TURNSTILE) và deploy/github-actions.md.
 */

import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { runCycle } from "../src/lib/quest-engine/runCycle.mjs";
import { profileDirForJob, sweepStaleProfiles } from "../src/lib/quest-engine/browserProfile.mjs";
import { createWorkerCall } from "../src/lib/worker/controlFollow.mjs";
import { UPDATE_EXIT_CODE, selfUpdateEnabled, shouldSelfUpdate } from "../src/lib/worker/selfUpdate.mjs";

/**
 * Bản của GÓI này, khai lên server mỗi lần gõ cửa để mục Khôi Lỗi nói được「có bản mới, cài lại」.
 *
 * Hai chỗ phải tìm, vì `worker.mjs` sống ở hai hình hài: trong gói phát hành nó nằm NGANG HÀNG
 * với `package.json`; trong cây mã nguồn nó nằm ở `scripts/` nên `package.json` ở thư mục cha.
 * Thử cả hai theo đúng thứ tự ấy — gói phát hành là ca thường gặp.
 *
 * Hỏng thì trả `null`, KHÔNG ném: một tiến trình cày nhiệm vụ không được chết vì không đọc nổi
 * số phiên bản của chính mình. Và `null` không phải sự im lặng vô nghĩa — server hiểu nó là
 *「khôi lỗi đời cũ」, đúng thứ cần hiện lên cho người dùng.
 */
function readOwnVersion() {
  for (const rel of ["./package.json", "../package.json"]) {
    try {
      const raw = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      const version = JSON.parse(raw)?.version;
      if (typeof version === "string" && version.trim()) return version.trim().slice(0, 32);
    } catch {
      // Thiếu tệp hay JSON hỏng thì thử chỗ kế; hết chỗ thì chịu.
    }
  }
  return null;
}
const VERSION = readOwnVersion();

const WEB_URL = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN;
const WORKER_ID = process.env.WORKER_ID ?? `linh-su-${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);
// Năm giây là ranh giới người dùng còn cảm thấy nút Thu Đàn phản hồi tức thời. Cho phép chỉnh
// để máy chủ riêng có thể tiết chế request, nhưng không nhận giá trị vô lý làm quay nóng CPU.
const HEARTBEAT_MS = Math.max(1_000, Number(process.env.WORKER_HEARTBEAT_MS ?? 5_000) || 5_000);
// Số job (= số tài khoản) chạy CÙNG LÚC trong một tiến trình khôi lỗi. Mỗi job là một
// Chromium riêng nên trần này là trần RAM. Kẹp 1–8 để một dấu phẩy gõ nhầm không mở tám mươi
// trình duyệt.
//
// HAI là trần chuẩn của cả tông môn từ 14/08/2026 — máy nhà lẫn VM lẫn runner GitHub. Con số
// này còn được KHAI LÊN máy chủ ở mỗi lượt hỏi việc: bộ cân tải luân phiên phải biết khôi lỗi
// nào còn chỗ, bằng không nó giữ lượt cho một tiến trình đã đầy ghế (services/dispatch.ts).
// Vặn biến môi trường rồi khởi động lại là con số mới có hiệu lực ngay ở nhịp gõ cửa kế tiếp.
const MAX_JOBS = Math.max(1, Math.min(8, Number(process.env.WORKER_MAX_JOBS ?? 2) || 2));
/**
 * TUỔI THỌ một lượt chạy — sống quá mốc này thì THÔI NHẬN VIỆC MỚI, không phải chết ngay.
 *
 * `0` = vô hạn, và đó là MẶC ĐỊNH: khôi lỗi trên VM và trên máy nhà phải giữ nguyên hành vi cũ
 * từng byte, vì chúng chạy liền mạch hàng tuần (đo 09/08/2026: `NRestarts=0`). Chỉ nơi nào có
 * một cái đồng hồ treo sẵn trên đầu mới cần đặt nó.
 *
 * Nơi ấy là GitHub Actions: runner bị giết cứng ở mốc 6 giờ. Bị giết giữa một ván Mê Cung 35
 * phút thì nhịp tim tắt, và 3 phút sau `reapStaleJobs` kết liễu đàn ấy thành `failed` — mất
 * trọn một vòng của một đạo hữu, đều đặn mỗi 6 tiếng. Đặt hạn NGẮN HƠN trần của nền tảng rồi
 * tự rút lui là cách duy nhất để cái mốc ấy không bao giờ chạm vào một đàn đang chạy.
 */
const MAX_LIFETIME_MS = Math.max(0, Number(process.env.WORKER_MAX_LIFETIME_MS ?? 0) || 0);
/**
 * Chờ tối đa bao lâu cho những đàn đang dở chạy nốt, sau khi đã thôi nhận việc.
 *
 * Phải rộng hơn vòng đời của nhiệm vụ dài nhất — Mê Cung có thể ngốn ~35 phút — nhưng vẫn phải
 * kết thúc, vì nền tảng sẽ giết bất kể ta chờ bao lâu. Hết hạn mà còn đàn đang chạy thì thoát
 * với mã KHÁC 0: chuyện ấy nghĩa là có người sắp mất một vòng, và nó đáng hiện đỏ chứ không
 * đáng lặng lẽ trôi qua. `0` = chờ vô hạn (mặc định, đúng cho VM).
 */
const DRAIN_TIMEOUT_MS = Math.max(0, Number(process.env.WORKER_DRAIN_TIMEOUT_MS ?? 0) || 0);
// Hồ sơ Chromium lâu không ai đụng thì dọn — mỗi lần người dùng dán cookie mới là một thư mục
// hồ sơ mới ra đời và cái cũ thành rác vĩnh viễn. Mười bốn ngày là ngưỡng RỘNG có chủ ý: hồ sơ
// mang token cf_clearance của Cloudflare, xoá sớm là bắt người ta qua cửa kiểm tra lại từ đầu.
// Kẹp 1–365 để một biến môi trường gõ nhầm không hoá thành phép xoá sạch.
const PROFILE_MAX_AGE_MS =
  Math.max(1, Math.min(365, Number(process.env.WORKER_PROFILE_MAX_AGE_DAYS ?? 14) || 14)) *
  24 * 60 * 60 * 1000;
/** Giãn cách giữa hai lượt quét. Rác tích theo ngày nên sáu giờ đã là dày. */
const PROFILE_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

if (!TOKEN || TOKEN === "change-me") {
  console.error("WORKER_TOKEN chưa đặt — dùng linh phù phát ở mục Khôi Lỗi, hoặc token tông môn.");
  process.exit(1);
}

// Mọi thao tác đều là một POST tới cùng một endpoint. Hàm gọi nằm ở controlFollow.mjs vì nó
// mang thêm một trách nhiệm không hiển nhiên: ĐI THEO trạm hoạt động khi bảng điều phối lật.
// Trạm đã nghỉ trả 409 kèm `activeUrl`; thiếu đoạn ấy thì mỗi lượt chuyển trạm bỏ lại toàn bộ
// đàn ở trạm cũ — đúng chuyện đã xảy ra ngày 10/08/2026.
const { call, currentUrl } = createWorkerCall({ webUrl: WEB_URL, token: TOKEN });

const say = (jobId, message, level = "info") =>
  // Engine nói "warn", giao thức nói "warning" — dịch ở đây, một chỗ duy nhất. Không dịch
  // thì mọi dòng cảnh báo bị API trả 400 và catch bên dưới nuốt mất, người dùng vĩnh viễn
  // không thấy cảnh báo nào trong nhật ký.
  call("event", { jobId, level: level === "warn" ? "warning" : level, message }).catch(() => {
    /* mất một dòng nhật ký không đáng để đánh sập cả lượt chạy */
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chạy một lượt bằng engine thật.
 *
 * `shouldStop()` ĐỒNG BỘ có chủ ý — engine gọi nó trong những vòng lặp chặt (mỗi 300ms khi
 * chờ một điều kiện, mỗi bước trong một repeat), nên nó phải là một phép đọc biến chứ không
 * phải một lời hứa. Nhịp tim nền là thứ cập nhật biến ấy.
 */
/**
 * Gốc chứa hồ sơ Chromium bền, nằm NGAY CẠNH worker: token cf_clearance mà Cloudflare cấp
 * sau một lần kiểm tra sống trong hồ sơ, nên các lượt sau đi thẳng qua cổng thay vì trình
 * diện lại như người lạ. Bên dưới gốc này, mỗi (user + cookie đã lưu) có một profile riêng:
 * tài khoản của job trước tuyệt đối không được chảy sang job sau.
 */
const PROFILE_ROOT = fileURLToPath(new URL("./browser-profiles/", import.meta.url));

async function runQuest({
  userId,
  config,
  dailyDone,
  say,
  reportAccountTier,
  reportProgress,
  shouldStop,
}) {
  await say("Khôi lỗi đã nhận ngọc giản, đang khởi lư…");

  // Nạp Playwright TẠI ĐÂY chứ không ở đầu tệp: một máy chỉ dùng worker để canh việc vẫn
  // chạy được `node scripts/worker.mjs` mà không cần cài Chromium, và lỗi thiếu thư viện
  // hiện ra như một lượt chạy thất bại có lời giải thích, không phải một tiến trình chết
  // ngay khi khởi động.
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return {
      outcome: "failed",
      message: "Thiếu playwright-core — chạy `npm install` rồi `npx playwright install chromium`.",
    };
  }

  const profileDir = profileDirForJob(PROFILE_ROOT, {
    userId,
    gameCookie: config?.gameCookie,
  });
  await mkdir(profileDir, { recursive: true });
  return runCycle({
    chromium,
    config,
    dailyDone,
    say,
    reportAccountTier,
    reportProgress,
    shouldStop,
    profileDir,
  });
}

/** Một lượt trọn vẹn: nhịp tim chạy nền, engine chạy trước, kết thúc thì báo cáo. */
async function handle(job) {
  console.log(`→ nhận job ${job.id}`);

  let stopping = false;

  // Tiến độ vòng này, cưỡi nhịp tim sẵn có — không thêm một request nào. Engine cập nhật
  // biến này (đồng bộ, trong đường chạy nóng), nhịp tim kế tiếp mang nó đi; trễ tối đa đúng
  // một nhịp, mà một nhịp là 5 giây trên một vòng thường dài hàng chục phút.
  //
  // `null` cho tới khi engine khai lần đầu, và `null` KHÔNG BAO GIỜ được gửi lên: với server,
  // vắng trường này nghĩa là "khôi lỗi đời cũ, giữ nguyên cột đang có" — gửi null sẽ biến nó
  // thành một lệnh xoá lặp lại mỗi 5 giây.
  let progress = null;

  const beat = setInterval(async () => {
    try {
      const { status } = await call("heartbeat", {
        jobId: job.id,
        ...(progress ? { progress } : {}),
        ...(VERSION ? { version: VERSION } : {}),
      });
      // Bất kỳ trạng thái nào KHÔNG phải 'running' đều nghĩa là không còn ai chờ lượt này:
      // 'stopping/stopped' là Thu Đàn, còn 'failed/done' là reaper đã kết liễu job (mất
      // liên lạc dài rồi nối lại) — ôm browser chạy nốt một vòng không ai nhận chỉ tổ
      // claim đè lên vòng kế.
      if (status !== "running") {
        stopping = true;
      }
    } catch (err) {
      console.error("  nhịp tim lỗi:", err.message);
      // 404 = job không còn tồn tại (tài khoản bị xoá kéo job theo); 403 = không còn thuộc
      // quyền mình. Cả hai đều nghĩa là không còn ai chờ kết quả — dừng ở điểm an toàn kế,
      // đừng ôm browser chạy nốt một vòng không ai nhận.
      if (/HTTP 40[34]\b/.test(err.message)) {
        stopping = true;
      }
    }
  }, HEARTBEAT_MS);

  try {
    const result = await runQuest({
      userId: job.userId,
      config: job.config,
      dailyDone: job.dailyDone,
      say: (message, level) => say(job.id, message, level),
      reportAccountTier: (tier) =>
        call("accountTier", { jobId: job.id, tier }).catch((err) => {
          console.error("  không lưu được hạng tài khoản:", err.message);
        }),
      reportProgress: (next) => {
        progress = next;
      },
      shouldStop: () => stopping,
    });
    // TRẢ LẠI cái ngày server đã phát ở `claim`, không tự lấy ngày trên máy này. Một vòng bắt
    // đầu 23h50 và kết thúc 00h30 đã quan sát trạng thái của NGÀY HÔM QUA; khai theo đồng hồ
    // của khôi lỗi là ghi phát hiện của hôm qua vào sổ của hôm nay, rồi bỏ trắng chín nhiệm vụ
    // suốt một ngày mà không ai biết vì sao. Server đối chiếu ngày này với ngày hiện tại của
    // nó và bỏ qua lời khai đã cũ — thà kiểm thừa một vòng còn hơn nghỉ nhầm một ngày.
    await call("complete", {
      jobId: job.id,
      ...result,
      ...(job.dailyDone?.day ? { dailyDay: job.dailyDone.day } : {}),
    });
    console.log(`✔ job ${job.id} — ${result.outcome}`);
  } catch (err) {
    await call("complete", {
      jobId: job.id,
      outcome: "failed",
      message: `Đàn pháp gặp trắc trở: ${err.message}`,
    }).catch(() => {});
    console.error(`✗ job ${job.id}:`, err);
  } finally {
    clearInterval(beat);
  }
}

console.log(
  `Khôi lỗi「${WORKER_ID}」đang canh ${currentUrl()} (tối đa ${MAX_JOBS} đàn cùng lúc). ` +
    "Trạm nghỉ trả 409 kèm địa chỉ trạm mới thì tự đi theo.",
);

// Nhiều job cùng lúc, mỗi job một Chromium — để một đạo hữu nuôi nhiều tài khoản thấy cả
// đội chạy song song thay vì xếp hàng sau lưng nhau. `running` giữ các lượt đang bận; còn
// ghế trống thì hỏi việc tiếp NGAY (không ngủ) cho tới khi hàng chờ cạn hoặc ghế đầy.
// Việc giành job giữa nhiều khôi lỗi vẫn do Postgres phân xử như cũ.
const running = new Set();

/**
 * Mốc quét hồ sơ kế tiếp. Đặt bằng "ngay bây giờ" chứ không phải "sáu giờ nữa": khôi lỗi trên
 * VM chạy liền mạch hàng tuần (đo 09/08/2026: `NRestarts=0`), nên một phép dọn chỉ chạy sau
 * một khoảng chờ dài là một phép dọn có thể không bao giờ chạy.
 */
let nextSweepAt = Date.now();

/**
 * PHA RÚT LUI — thôi nhận việc mới, chờ đàn đang dở chạy nốt, rồi thoát sạch.
 *
 * Vào pha này bằng hai đường: hết hạn tuổi thọ, hoặc nền tảng gõ cửa bằng SIGTERM/SIGINT
 * (Actions gửi tín hiệu ấy trước khi giết, và một lượt bấm huỷ cũng đi qua đây). Cả hai đều
 * KHÔNG cắt ngang đàn đang chạy — cắt ngang chính là thứ ta dựng cả cơ chế này để tránh.
 *
 * Chỉ chuyển pha một lần: `beginDrain` gọi lần thứ hai là no-op, nếu không thì mỗi tín hiệu
 * lại đặt lại đồng hồ chờ và hạn drain không bao giờ tới.
 */
/**
 * Lượt thu đàn đang chạy có phải ĐỂ THAY GÓI không — quyết định mã thoát, và mã thoát là thứ
 * DUY NHẤT vòng nuôi đọc được. Cờ riêng chứ không suy từ `draining`: thu đàn còn có hai đường
 * vào khác (hết hạn tuổi thọ, SIGTERM), và cả hai đều KHÔNG được xin thay gói — một lượt bấm
 * huỷ trên Actions mà lại kích một cú thay gói là hành vi không ai ngờ tới.
 */
let drainingForUpdate = false;
let draining = false;
let drainStartedAt = 0;
const startedAt = Date.now();
const stopClaimingAt = MAX_LIFETIME_MS > 0 ? startedAt + MAX_LIFETIME_MS : Infinity;

function beginDrain(why) {
  if (draining) return;
  draining = true;
  drainStartedAt = Date.now();
  console.log(
    `Thu đàn: ${why}. Thôi nhận việc mới, chờ ${running.size} đàn đang chạy đi nốt vòng.`,
  );
}

// `once` chứ không phải `on`: tín hiệu thứ hai để nguyên hành vi mặc định của Node, nên một
// người sốt ruột bấm huỷ lần nữa vẫn giết được tiến trình mà không phải đi tìm PID.
process.once("SIGTERM", () => beginDrain("nhận SIGTERM"));
process.once("SIGINT", () => beginDrain("nhận SIGINT"));

for (;;) {
  if (!draining && Date.now() >= stopClaimingAt) {
    beginDrain(`đã chạy đủ ${Math.round(MAX_LIFETIME_MS / 60_000)} phút theo hạn tuổi thọ`);
  }

  if (draining) {
    if (running.size === 0) {
      console.log("Đã thu xong — không còn đàn nào đang chạy, thoát sạch.");
      if (drainingForUpdate) {
        // Vòng nuôi đọc mã này rồi tự đi lấy gói mới. Nói ra thành lời vì nhật ký máy nhà là
        // chỗ DUY NHẤT người ta soi được khi một lượt thay gói không xảy ra như mong đợi.
        console.log(`Xin vòng nuôi thay gói (mã thoát ${UPDATE_EXIT_CODE}).`);
        process.exitCode = UPDATE_EXIT_CODE;
      }
      break;
    }
    if (DRAIN_TIMEOUT_MS > 0 && Date.now() - drainStartedAt >= DRAIN_TIMEOUT_MS) {
      // Thoát với mã khác 0: còn đàn dở nghĩa là nhịp tim sắp tắt và reaper sẽ kết liễu chúng
      // sau 3 phút. Có người sắp mất một vòng — chuyện ấy phải hiện ĐỎ.
      console.error(
        `Hết hạn chờ thu đàn (${Math.round(DRAIN_TIMEOUT_MS / 60_000)} phút) mà còn ` +
          `${running.size} đàn chưa xong — thoát, chúng sẽ bị phép dọn kết liễu.`,
      );
      process.exitCode = 1;
      break;
    }
    await sleep(POLL_MS);
    continue;
  }

  let claimed = false;

  if (running.size < MAX_JOBS) {
    try {
      const { job, webVersion } = await call("claim", {
        workerId: WORKER_ID,
        maxJobs: MAX_JOBS,
        ...(VERSION ? { version: VERSION } : {}),
      });
      if (job) {
        claimed = true;
        // handle() tự nuốt mọi lỗi của chính nó (kể cả lỗi báo cáo complete), nên promise
        // này không bao giờ reject — Set chỉ để đếm ghế.
        const seat = handle(job).finally(() => running.delete(seat));
        running.add(seat);
      }

      // Xét thay gói SAU khi đã nhận job vừa được phát: job ấy đã được ghi tên trên máy chủ rồi,
      // bỏ ngang là để nó nằm chờ phép dọn kết liễu — một người mất một vòng chỉ vì ta nôn nóng.
      // `beginDrain` không cắt ngang ai cả, nó chỉ thôi nhận việc MỚI, nên nhận rồi thu là đúng.
      const xet = shouldSelfUpdate({
        own: VERSION,
        web: webVersion,
        enabled: selfUpdateEnabled(process.env),
      });
      if (xet.update) {
        // Đặt cờ TRƯỚC `beginDrain`: beginDrain là no-op nếu đã thu đàn vì lý do khác, và khi ấy
        // cờ này vẫn phải nói đúng sự thật「lượt thu đàn hiện thời KHÔNG phải để thay gói」.
        if (!draining) {
          drainingForUpdate = true;
          beginDrain(xet.reason);
        }
      }
    } catch (err) {
      console.error("claim lỗi:", err.message);
    }
  }

  if (!claimed) {
    // Dọn hồ sơ CHỈ KHI TAY KHÔNG — không job nào đang chạy nghĩa là không hồ sơ nào đang mở,
    // nên phép xoá không thể giật mất thư mục dưới chân một Chromium đang dùng nó. Đây là lớp
    // bảo vệ thứ nhất; ngưỡng mười bốn ngày là lớp thứ hai, độc lập với lớp này.
    //
    // Hàng đợi lúc nào cũng đầy thì phép dọn bị hoãn — chấp nhận có ý thức: lúc bận chính là
    // lúc hồ sơ đang được dùng, và hàng đợi rồi sẽ cạn. Thà hoãn còn hơn xoá nhầm.
    if (running.size === 0 && Date.now() >= nextSweepAt) {
      // Đặt mốc TRƯỚC khi quét: một lượt quét lâu không được phép kéo theo lượt kế ngay sau nó.
      nextSweepAt = Date.now() + PROFILE_SWEEP_EVERY_MS;
      try {
        const swept = await sweepStaleProfiles(PROFILE_ROOT, { maxAgeMs: PROFILE_MAX_AGE_MS });
        // Chỉ kể khi có chuyện: một dòng "đã xoá 0" mỗi sáu giờ chỉ làm loãng nhật ký.
        if (swept.removed > 0 || swept.failed > 0) {
          console.log(
            `Dọn hồ sơ trình duyệt: xoá ${swept.removed}, giữ ${swept.kept}` +
              (swept.failed > 0 ? `, hụt ${swept.failed}` : "") + ".",
          );
        }
      } catch (err) {
        // Dọn nhà hỏng thì kể lại rồi đi tiếp — nó không có quyền chặn khôi lỗi nhận việc.
        console.error("Dọn hồ sơ trình duyệt lỗi:", err.message);
      }
    }

    await sleep(POLL_MS);
  }
}
