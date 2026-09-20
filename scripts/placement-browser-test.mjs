import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

await page.goto("http://127.0.0.1:3000/?demo=1");
await page.evaluate(() => {
  const key = "fff.localDemo.v4";
  const state = JSON.parse(localStorage.getItem(key));
  for (let index = 1; index <= 12; index += 1) {
    const id = `placement-show-${index}`;
    state.shows.push({
      ...state.shows[0],
      id,
      imdbId: `tt90000${index}`,
      title: `Placement Show ${index}`,
      releaseYear: 2000 + index
    });
    state.nominations[`demo-admin:${id}`] = { userId: "demo-admin", showId: id, nominatedAt: new Date().toISOString(), withdrawnAt: null };
  }
  state.rankings["demo-admin"] = state.shows.slice(0, 8).map((show) => show.id);
  localStorage.setItem(key, JSON.stringify(state));
});
await page.reload();
await page.getByRole("tab", { name: "Rank" }).click();
await page.locator("#panel-rank").getByText("Placement Show 7", { exact: true }).click();
await page.waitForTimeout(250);
await page.addStyleTag({ content: ".placement-card { min-height: 214px; }" });

const stage = page.locator(".placement-stage");
await stage.hover();
await page.mouse.wheel(0, -120);
await page.waitForTimeout(300);
await page.screenshot({ path: "playwright-placement.png", fullPage: false });

console.log(await page.locator(".placement-result").textContent());
const layout = await page.evaluate(() => {
  const rect = (selector) => {
    const { top, bottom } = document.querySelector(selector).getBoundingClientRect();
    return { top, bottom };
  };
  return {
    card: rect(".placement-card"),
    rows: Array.from(document.querySelectorAll(".placement-row")).map((row) => {
      const { top, bottom } = row.getBoundingClientRect();
      return { top, bottom };
    })
  };
});
assert(layout.rows.every((row) => row.bottom <= layout.card.top + 2 || row.top >= layout.card.bottom - 2), "A compact row must not overlap the selected card.");
await page.mouse.wheel(0, -1200);
await page.waitForTimeout(300);
assert.equal(await page.locator(".placement-result").textContent(), "Place at #1", "The first insertion position must be reachable.");
await page.mouse.wheel(0, 1200);
await page.waitForTimeout(300);
assert.equal(await page.locator(".placement-result").textContent(), "Place at #9", "The final insertion position must be reachable.");
await browser.close();
