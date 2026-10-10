import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { fixture } from "./fixture.mjs";
import { mappingSql } from "../scripts/prepare-google-mapping.mjs";

let test;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(origin + req.url, { method: req.method, headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks), duplex: "half" });
    const response = await test.worker.fetch(request, test.env);
    res.statusCode = response.status;
    for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
    if (response.headers.getSetCookie().length) res.setHeader("set-cookie", response.headers.getSetCookie());
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.statusCode = 500; res.end("Local test server failed."); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  test = await fixture(origin);
  // Approval established before opening the participant application.
  const identity = { sub: "google-a", email: "a@example.test" };
  await test.signIn(identity);
  const pending = await test.env.DB.prepare("SELECT id FROM auth_requests WHERE google_sub=?").bind(identity.sub).first();
  await test.env.DB.prepare(mappingSql({ action: "approve", participantId: "a", expectedName: "Participant A",
    requestId: pending.id, verifiedEmail: identity.email, note: "Browser fixture approval" })).run();
  browser = await chromium.launch();
  let externalScripts = 0;
  const configure = async (context) => context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.href === "https://accounts.google.com/gsi/client") return route.fulfill({ contentType: "application/javascript", body: `
      let settings;
      window.google={accounts:{id:{
        initialize(options){settings=options;},
        renderButton(host,options){window.__googleButtonOptions=options; const button=document.createElement('button');button.textContent='Sign in with Google';button.style.width=options.width+'px';button.onclick=async()=>{const result=await fetch('/mock-google-credential',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:settings.nonce})}).then(r=>r.json());settings.callback({credential:result.credential});};host.append(button);},
        disableAutoSelect(){}
      }}};
    ` });
    if (url.pathname === "/mock-google-credential") {
      const { nonce } = route.request().postDataJSON();
      return route.fulfill({ json: { credential: await test.credential(nonce, identity) } });
    }
    if (url.origin !== origin) {
      if (route.request().resourceType() === "script") externalScripts++;
      return route.abort();
    }
    return route.continue();
  });
  let context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await configure(context);
  let page = await context.newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Sign in with Google" }).waitFor();
  for (const width of [320,360,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(100);
    const button = await page.evaluate(()=>({options:window.__googleButtonOptions,width:document.querySelector('#googleButton').clientWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.equal(button.options.theme,'outline_dark');
    assert.equal(button.options.width,Math.floor(Math.min(320,button.width)));
    assert.equal(button.overflow,false);
  }
  assert.equal((await context.request.get(origin + "/app.js")).status(), 401);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  await page.waitForFunction(() => document.querySelector("#userBadge")?.textContent.startsWith("Participant A"));
  const session = (await context.cookies()).find((c) => c.name === "ww-local-session");
  assert(session.httpOnly && session.expires > Date.now()/1000, "Remembered cookie persists");
  await page.locator("#titleInput").fill("tt90000001");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.locator("#searchResults").getByRole("button", { name: /Nominate/ }).click();
  await page.locator("#catalogueList").getByText("Synthetic show", { exact: true }).waitFor();
  await page.getByRole("tab", { name: /^Rank/ }).click();
  if (await page.locator("#rankChoices").getByText("Synthetic show", { exact: true }).count()) {
    await page.locator("#rankChoices").getByText("Synthetic show", { exact: true }).click();
  }
  await page.getByRole("button", { name: "Confirm placement" }).click();
  await page.getByRole("tab", { name: "List", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#sequenceStatus").textContent.toLowerCase().includes("saved"));
  assert(await page.locator("#rankedList").getByText("Synthetic show", { exact: true }).isVisible());
  const storage = await context.storageState();
  await context.close();
  context = await browser.newContext({ storageState: storage, viewport: { width: 1280, height: 900 } });
  await configure(context); page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("#userBadge")?.textContent.startsWith("Participant A"));
  await page.getByRole("tab", { name: "List", exact: true }).click();
  assert(await page.locator("#rankedList").getByText("Synthetic show", { exact: true }).isVisible());
  const otherTab = await context.newPage();
  await otherTab.goto(origin);
  await otherTab.waitForFunction(() => document.querySelector("#userBadge")?.textContent.startsWith("Participant A"));
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  assert.equal((await context.request.get(origin + "/auth/session")).status(), 401, "Logout must revoke the remembered session");
  await page.waitForFunction(() => Boolean(document.querySelector("#googleButton")));
  await page.getByRole("button", { name: "Sign in with Google" }).waitFor().catch(async (error) => {
    console.log("Synthetic logout sign-in page state:", await page.locator("body").innerText());
    throw error;
  });
  assert.equal((await context.request.get(origin + "/auth/session")).status(), 401);
  assert.equal((await context.request.get(origin + "/app.js")).status(), 401);
  await otherTab.locator("#googleButton").waitFor();
  assert.equal(externalScripts, 0);
  console.log("Mock Google browser sign-in, nomination/ranking, remembered browser session, logout and local-only scripts passed.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (test) await test.dispose();
}
