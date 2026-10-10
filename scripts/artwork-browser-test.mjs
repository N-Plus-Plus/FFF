import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Only generated public assets and fictional API responses are served locally.
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name.includes('..')) throw new Error('Invalid path');
    const file = name === '/' ? 'index.html' : name.slice(1);
    const body = await readFile(new URL(`../cloudflare/public/${file}`, import.meta.url));
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let selected = 'one', failDiscovery = false, empty = false, fanart = true;
  const show = (id) => ({ id, imdb_id: id === 'a' ? 'tt90000001' : 'tt90000002', title: 'A deliberately long fictional television title for responsive verification', release_year: 2020, total_episode_count: 100, total_season_count: 5, total_runtime_minutes: 4000, tvmaze_rating: 8.5, card_art_type: fanart ? 'fanart-tvbanner' : 'banner', card_art_source_url: `${origin}/banner-${selected}.svg`, current_user_nominated: true });
  const board = () => ({ entries: empty ? [] : [{...show('a'), show_id:'a', ranked_count:2, is_confirmed:true}] });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'No external provider access');
    if (url.pathname.startsWith('/banner-')) return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="185"><rect width="1000" height="185" fill="#a6bdcf"/><circle cx="950" cy="92" r="50" fill="#f90"/></svg>'});
    if (url.pathname === '/auth/session') return route.fulfill({json:{current_user:{id:'test', is_admin:true}}});
    if (!url.pathname.startsWith('/v1/')) return route.continue();
    let data = {};
    if (url.pathname === '/v1/load') data = {current_user:{id:'test',display_name:'Fixture admin',is_admin:true},shows:[show('a'),show('b')],ranked:[show('a')],unranked:empty?[]:[show('b'),show('a')],board:board()};
    if (url.pathname === '/v1/catalogue') data = {shows:[show('a'),show('b')]};
    if (url.pathname === '/v1/order') data = {ranked:[show('a')],unranked:empty?[]:[show('b'),show('a')]};
    if (url.pathname === '/v1/board') data = board();
    if (url.pathname === '/v1/admin/artwork') {
      const payload = route.request().postDataJSON();
      if (payload.action === 'save') { selected = payload.bannerId; data = {artwork:show('a')}; }
      else if (failDiscovery) return route.fulfill({status:503,json:{message:'Fictional discovery unavailable'}});
      else data = {selectedId:selected,banners:['one','two'].map(id=>({id,url:`${origin}/banner-${id}.svg`,lang:'en'}))};
    }
    return route.fulfill({json:data});
  });
  await page.goto(origin);
  await page.locator('.artwork-edit').first().waitFor();
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    for (const tab of ['Nominate','Rank','List','Watch']) {
      await page.getByRole('tab',{name:tab === 'Rank' ? /^Rank/ : tab,exact:tab !== 'Rank'}).click();
      await page.waitForTimeout(80);
      const panel = page.locator('.panel.is-active');
      assert.equal(await panel.locator('.page-artwork-credit:visible').count(),1);
      assert.equal(await panel.locator('.card-art-credit').count(),0);
      const metrics = await panel.locator('article').evaluateAll(cards => cards.map(card => {
        const r=card.getBoundingClientRect(), css=getComputedStyle(card), overlay=getComputedStyle(card,'::after');
        return {ratio:r.width/r.height,width:r.width,height:r.height,fit:getComputedStyle(card.querySelector('.card-background img')).objectFit,gradient:overlay.backgroundImage, layer:overlay.zIndex, controls:[...card.querySelectorAll('button')].map(b=>{const q=b.getBoundingClientRect();return q.top>=r.top-1&&q.bottom<=r.bottom+1&&q.left>=r.left-1&&q.right<=r.right+1;})};
      }));
      for (const metric of metrics) {
        assert(Math.abs(metric.ratio-200/37)<0.02, `${width} ${tab}: ${JSON.stringify(metric)}`);
        assert.equal(metric.fit,'contain'); assert.equal(metric.layer,'-1');
        assert(metric.gradient.includes('0.7') && metric.gradient.includes('20%') && metric.gradient.includes('40%'));
        assert(metric.controls.every(Boolean), `${width} ${tab} controls overflow: ${JSON.stringify(metric)}`);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
  }
  await page.setViewportSize({width:390,height:900});
  await page.getByRole('tab',{name:/^Rank/}).click();
  await page.locator('#rankChoices article').first().click();
  assert.equal(await page.locator('#panel-rank .page-artwork-credit:visible').count(),1);
  const placement = await page.locator('.placement-card').boundingBox();
  assert(Math.abs(placement.width/placement.height-200/37)<0.02);
  await page.getByRole('button',{name:'Cancel placement'}).click();
  await page.getByRole('tab',{name:'Nominate',exact:true}).click();
  await page.screenshot({path:'.wrangler/artwork-mobile.png',fullPage:true});
  await page.getByRole('tab',{name:'List',exact:true}).click();
  await page.screenshot({path:'.wrangler/artwork-list-mobile.png',fullPage:true});
  await page.getByRole('tab',{name:'Nominate',exact:true}).click();
  assert.equal(await page.locator('.artwork-edit').first().evaluate(b=>getComputedStyle(b).color),'rgb(0, 0, 0)');
  await page.locator('.artwork-edit').first().click();
  assert.equal(await page.locator('.artwork-dialog input').count(),0);
  const second=page.getByRole('button',{name:'Banner 2',exact:false});
  await second.focus(); await page.keyboard.press('Space');
  assert.equal(await second.getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.artwork-option[aria-pressed="true"]').count(),1);
  assert.equal(await page.getByRole('button',{name:'Save',exact:true}).evaluate(b=>getComputedStyle(b).color),'rgb(0, 0, 0)');
  assert.equal(await page.locator('[data-save] svg.lucide-save').count(),1);
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.locator('.artwork-dialog').waitFor({state:'detached'});
  assert.equal(selected,'two');
  await page.reload(); await page.locator('.artwork-edit').first().click();
  assert.equal(await page.getByRole('button',{name:'Banner 2',exact:false}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Close artwork selector'}).click();
  failDiscovery=true; await page.locator('.artwork-edit').first().click();
  const retry=page.getByRole('button',{name:'Retry',exact:true}); await retry.waitFor();
  assert.equal(await retry.evaluate(b=>getComputedStyle(b).color),'rgb(0, 0, 0)');
  assert.equal(await retry.locator('svg.lucide-rotate-cw').count(),1);
  failDiscovery=false; await retry.click(); await second.waitFor();
  await page.getByRole('button',{name:'Close artwork selector'}).click();
  empty=true; await page.reload(); await page.getByRole('tab',{name:/^Rank/}).click();
  assert.equal(await page.locator('#panel-rank .page-artwork-credit:visible').count(),0);
  fanart=false; await page.reload();
  for (const tab of ['Nominate','Rank','List','Watch']) {
    await page.getByRole('tab',{name:tab === 'Rank' ? /^Rank/ : tab,exact:tab !== 'Rank'}).click();
    assert.equal(await page.locator('.panel.is-active .page-artwork-credit:visible').count(),0);
  }
  assert.deepEqual(errors,[]);
  console.log('Artwork UI checks passed: 320/390/768/1440px, exact ratios, gradient layers, controls, keyboard picker, save/reopen, retry and empty Rank attribution (fictional API).');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }

