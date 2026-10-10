import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";

const worker = await unstable_dev("cloudflare/tests/ranking-reminders-runtime.worker.js", {
  config: "cloudflare/tests/ranking-reminders-runtime.json",
  local: true, persist: false, ip: "127.0.0.1", port: 0, logLevel: "error",
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true }
});
try {
  const response = await worker.fetch();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rejectedSender: true,
    dates: ["2026-04-01", "2026-04-08", "2026-09-30", "2026-10-07", null] });
  console.log("Native workerd Sydney DST and structured send_email/sender restriction passed; local simulator only.");
} finally { await worker.stop(); }
