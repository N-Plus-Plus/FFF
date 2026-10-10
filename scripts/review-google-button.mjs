// Anonymous presentation review only. Local bytes + public GIS SDK; no real
// participant sign-in, production API, Cloudflare account, or database access.
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
import worker from "../cloudflare/src/index.js";

const vars = parseEnv(await readFile(".env.vars", "utf8"));
const client = process.env.GOOGLE_CLIENT_ID || vars.GOOGLE_CLIENT_ID;
if (!client) throw new Error("Provide GOOGLE_CLIENT_ID in ignored .env.vars.");
const origin = "https://wirewednesday.nissen.nexus";
const output = ".wrangler/verification/google-button";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await context.route(origin + "/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/config") return route.fulfill({ json: { client_id: client, configured: true } });
    if (url.pathname === "/auth/challenge") return route.fulfill({ json: { nonce: "anonymous-presentation-only" } });
    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/v1/")) return route.fulfill({ status: 401, json: { message: "Presentation review only." } });
    const name = url.pathname === "/" ? "login.html" : url.pathname.slice(1);
    if (!["login.html", "login.js", "style.css", "wire-wednesday.png"].includes(name) && !/^vendor\/lexend-deca-latin-(400|600|700|800)\.woff2$/.test(name)) return route.fulfill({ status: 404, body: "" });
    const type = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".woff2") ? "font/woff2" : "image/png";
    const response = await worker.fetch(new Request(url), { APP_ORIGIN: origin, ASSETS: { fetch: async () => new Response(await readFile(`cloudflare/public/${name}`), { headers: { "Content-Type": type } }) } });
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.google?.accounts?.id && document.querySelector("#googleButton")?.children.length, { timeout: 30000 });
  const results = [];
  for (const width of [320, 360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(1500);
    const geometry = await page.locator("#googleButton").evaluate((host) => ({ hostWidth: host.clientWidth,
      buttonWidth: host.querySelector('[role="button"]')?.getBoundingClientRect().width || 0,
      frames: [...host.querySelectorAll("iframe")].map((f) => ({ width: f.getBoundingClientRect().width, height: f.getBoundingClientRect().height })),
      documentOverflow: document.documentElement.scrollWidth > innerWidth }));
    results.push({ width, ...geometry });
    await page.screenshot({ path: `${output}/outline_dark-${width}.png`, fullPage: true });
    assert.equal(geometry.documentOverflow, false);
    assert(geometry.buttonWidth > 0 && geometry.buttonWidth <= Math.min(320, geometry.hostWidth) + 1);
  }
  await writeFile(`${output}/geometry.json`, JSON.stringify(results, null, 2));
  console.log("Official anonymous Google outline_dark presentation passed at 320/360/390/768/1440px. Artifacts are ignored under .wrangler/verification/google-button.");
} finally { await browser.close(); }
