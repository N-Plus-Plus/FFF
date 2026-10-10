import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";

const worker = await unstable_dev("cloudflare/tests/fanart-runtime.worker.js", {
  config: "cloudflare/tests/fanart-runtime.json",
  local: true, persist: false, ip: "127.0.0.1", port: 0, logLevel: "error",
  experimental: { disableExperimentalWarning: true, disableDevRegistry: true }
});
try {
  const response = await worker.fetch();
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(), {
    count: 1, bytes: [1,2,3], requests: [
      { redirect: "manual", provider: true, credential: true },
      { redirect: "manual", provider: false, credential: false }
    ]
  });
  console.log("Native workerd fanart discovery/download redirect regression passed; no external requests.");
} finally { await worker.stop(); }
