import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const origin = "http://127.0.0.1:3000";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let externalScripts = 0;
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      assert.equal(route.request().headers().referer, undefined, "External requests must not carry private referrers");
      if (route.request().resourceType() === "script" && new URL(route.request().url()).href !== "https://accounts.google.com/gsi/client") externalScripts += 1;
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin);
  assert(await page.locator("#googleButton").isVisible());
  const response = await page.goto(`${origin}/?demo=1`);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["referrer-policy"], "no-referrer");
  assert.equal(response.headers()["cache-control"], "private, no-store");
  await page.waitForFunction(() => document.querySelector("#userBadge").textContent !== "Loading");
  assert.equal(await page.title(), "Wire Wednesday");
  assert.equal(await page.locator("h1").textContent(), "Wire Wednesday");
  assert.equal(await page.evaluate(async () => (await import("/config.js")).APP_CONFIG.apiUrl), "/");
  for (const name of ["Nominate", "Rank", "List", "Watch"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    assert.equal(await page.getByRole("tab", { name, exact: true }).getAttribute("aria-selected"), "true");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  assert(await page.locator("h1").isVisible());
  for (const path of ["/missing", "/README.md", "/wrangler.jsonc", "/cloudflare/src/index.js", "/.env"]) {
    assert.equal((await context.request.get(origin + path)).status(), 404, path);
  }
  assert.equal((await context.request.get(origin + "/artwork/invalid")).status(), 401);
  assert.equal((await context.request.post(origin + "/v1/load", { data: {}, headers: { Origin: origin } })).status(), 401);
  assert.equal((await context.request.get(origin + "/v1/unknown")).status(), 404);
  for (const path of ["/app.js?v=123", "/style.css", "/wire-wednesday.png", "/index.html?demo=1", "/vendor/lucide.min.js"]) {
    assert.equal((await context.request.get(origin + path)).status(), 200, path);
  }
  assert.equal(externalScripts, 0);
  console.log("Actual Wrangler static routing, privacy headers, same-origin config and mobile/desktop browser checks passed.");
} finally {
  await browser.close();
}
