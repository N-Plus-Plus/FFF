import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const frontend = ["index.html", "login.html", "login.js", "bootstrap.js", "api.js", "style.css", "app.js", "config.js", "store.js", "providers.js", "ranking.js", "wire-wednesday.png"];
const vendor = ["lucide.min.js", "lucide-LICENSE.txt", "lexend-deca-LICENSE.txt", ...[400, 600, 700, 800].map((weight) => `lexend-deca-latin-${weight}.woff2`)];
assert.deepEqual((await readdir("cloudflare/public")).sort(), [...frontend, "vendor"].sort(), "Only allowlisted assets may be packaged");
assert.deepEqual((await readdir("cloudflare/public/vendor")).sort(), vendor.sort());
for (const path of [
  ...frontend.filter((name) => /\.(js|html|css)$/.test(name)),
  ...(await readdir("cloudflare/src")).map((name) => `cloudflare/src/${name}`),
  ".wrangler/hosting-dry-run/index.js"
]) {
  const source = await readFile(path, "utf8");
  assert.doesNotMatch(source, /supabase|supabase\.co|SUPABASE_|service_role/i, `${path}: retired backend dependency`);
  assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, `${path}: private key`);
}
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.equal(config.observability.enabled, false);
assert.deepEqual(config.triggers.crons, ["0 2 * * 3", "0 1 * * 3"]);
assert.deepEqual(config.send_email, [{ name: "RANKING_EMAIL", allowed_sender_addresses: ["troy@nissen.nexus"], remote: false }]);
assert.equal(config.vars.RANKING_REMINDERS_ENABLED, "false", "Activation requires an explicit reviewed configuration change");
assert.equal(config.assets.run_worker_first, true);
console.log("Asset allowlist, retired dependency scan, private-key scan and production privacy configuration passed.");
