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
  let selected = 'one', failDiscovery = false, empty = false, fanart = true, admin = true;
  let rankedIds = ['a','b'];
  const mutations = [];
  const show = (id) => ({ id, imdb_id: id === 'a' ? 'tt90000001' : 'tt90000002', title: 'A deliberately long fictional television title for responsive verification', release_year: 2020, total_episode_count: 100, total_season_count: 5, total_runtime_minutes: 4000, tvmaze_rating: 8.5, card_art_type: fanart ? 'fanart-tvbanner' : 'banner', card_art_source_url: `${origin}/banner-${selected}.svg`, current_user_nominated: true });
  const board = () => ({ entries: empty ? [] : [{...show('a'), show_id:'a', ranked_count:2, is_confirmed:true}] });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'No external provider access');
    if (url.pathname === '/avatar.png') return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="orange"/></svg>'});
    if (url.pathname.startsWith('/banner-')) return route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="185"><rect width="1000" height="185" fill="#a6bdcf"/><circle cx="950" cy="92" r="50" fill="#f90"/></svg>'});
    if (url.pathname === '/auth/session') return route.fulfill({json:{current_user:{id:'test', is_admin:admin}}});
    if (!url.pathname.startsWith('/v1/')) return route.continue();
    let data = {};
    if (url.pathname === '/v1/load') data = {current_user:{id:'test',display_name:'Fixture participant',is_admin:admin},shows:[show('a'),show('b')],ranked:rankedIds.map(show),unranked:empty?[]:[show('b'),show('a')],board:board()};
    if (url.pathname === '/v1/catalogue') data = {shows:[show('a'),show('b')]};
    if (url.pathname === '/v1/order') data = {ranked:rankedIds.map(show),unranked:empty?[]:[show('b'),show('a')]};
    if (['/v1/nominate','/v1/withdraw','/v1/admin/remove','/v1/ranking'].includes(url.pathname)) mutations.push(url.pathname);
    if (url.pathname === '/v1/ranking') {
      rankedIds = route.request().postDataJSON().showIds;
      data = {revision:2,updated_at:new Date().toISOString(),order:{ranked:rankedIds.map(show),unranked:[]}};
    }
    if (url.pathname === '/v1/metadata' && route.request().postDataJSON().action==='search') data = {results:[show('a'),{...show('c'),imdb_id:'tt90000003',current_user_nominated:false}]};
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
  assert.equal(await page.locator('#userBadge').count(),0);
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);
  const accountTrigger=page.locator('#accountMenuButton');
  await page.waitForFunction(()=>document.querySelector('#accountAvatar').naturalWidth>0);
  assert.deepEqual(await accountTrigger.evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,top:getComputedStyle(e).top,right:getComputedStyle(e).right})),{width:64,height:64,top:'0px',right:'0px'});
  assert.equal(await accountTrigger.locator('svg:visible').count(),0);
  assert.equal(await page.locator('#sequenceStatus, #retrySaveButton').count(),0);
  assert.equal(await page.getByText('Active shows',{exact:true}).count(),0);
  assert.equal(await page.getByText('Your ranked list',{exact:true}).count(),0);
  await accountTrigger.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('#accountMenuButton').getAttribute('aria-expanded')==='true');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);
  await accountTrigger.click(); await page.locator('h1').click();
  assert.equal(await page.getByRole('button',{name:'Sign out',exact:true}).isVisible(),false);

  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(await accountTrigger.evaluate(e=>[e.getBoundingClientRect().width,e.getBoundingClientRect().height]),[64,64]);
    for (const tab of ['Nominate','Rank','List','Watch']) {
      await page.getByRole('tab',{name:tab === 'Rank' ? /^Rank/ : tab,exact:tab !== 'Rank'}).click();
      await page.waitForTimeout(80);
      const panel = page.locator('.panel.is-active');
      assert(await panel.locator('.show-title, .show-subtitle').evaluateAll(nodes=>nodes.every(e=>parseFloat(getComputedStyle(e).paddingLeft)>=6)));
      assert.equal(await panel.locator('.page-artwork-credit:visible').count(),1);
      assert.equal(await panel.locator('.card-art-credit').count(),0);
      const metrics = await panel.locator('article').evaluateAll(cards => cards.map(card => {
        const r=card.getBoundingClientRect(), css=getComputedStyle(card), overlay=getComputedStyle(card,'::after');
        return {ratio:r.width/r.height,width:r.width,height:r.height,fit:getComputedStyle(card.querySelector('.card-background img')).objectFit,gradient:overlay.backgroundImage, layer:overlay.zIndex, controls:[...card.querySelectorAll('button')].map(b=>{const q=b.getBoundingClientRect();return q.top>=r.top-1&&q.bottom<=r.bottom+1&&q.left>=r.left-1&&q.right<=r.right+1;})};
      }));
      for (const metric of metrics) {
        assert(Math.abs(metric.ratio-200/37)<0.02, `${width} ${tab}: ${JSON.stringify(metric)}`);
        assert.equal(metric.fit,'contain'); assert.equal(metric.gradient,'none');

        assert(metric.controls.every(Boolean), `${width} ${tab} controls overflow: ${JSON.stringify(metric)}`);
      }
      assert(await panel.locator('.show-meta').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).textShadow!=='none')));
      if (tab==='Nominate' || tab==='List') assert(await panel.locator('.show-meta').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).paddingLeft==='8px')));
      if (tab !== 'Rank') {
        const lines = await panel.locator('article').evaluateAll(cards => cards.map(card => {
          const nodes = [card.querySelector('.show-title'), ...card.querySelectorAll('.show-details .show-subtitle')];
          const bounds = card.getBoundingClientRect();
          return nodes.map(node => { const r=node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,inside:r.top>=bounds.top&&r.bottom<=bounds.bottom}; });
        }));
        for (const line of lines) {
          assert(line.every(part=>part.inside), `${width} ${tab} text clips: ${JSON.stringify(line)}`);
          assert(line[0].bottom<=line[1].top+1);
          assert(line[1].bottom<=line[2].top+1, 'Desktop year and episodes stack');
          assert(line[2].bottom<=line[3].top+1, 'Runtime is the last line');
        }
      }
      if (tab==='Nominate') {
        await accountTrigger.click();
        const menuBox=await page.locator('#accountMenu').boundingBox();
        assert(menuBox.x>=0 && menuBox.x+menuBox.width<=width, 'Account menu fits viewport');
        await page.keyboard.press('Escape');
        assert.equal(await panel.getByRole('button',{name:/^(Nominate|Withdraw)$/}).count(),0);
        const tools=await panel.locator('article').first().locator('.card-actions button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect(),c=getComputedStyle(b);return {width:r.width,height:r.height,top:r.top,background:c.backgroundColor,color:c.color,text:b.textContent.trim(),name:b.getAttribute('aria-label')};}));
        assert.equal(tools.length,2);
        assert.deepEqual(tools.map(t=>[t.width,t.height,t.top]),[ [32,32,tools[0].top], [32,32,tools[0].top] ]);
        assert(tools.every(t=>t.background==='rgb(62, 71, 80)'&&t.color==='rgb(255, 255, 255)'&&t.text===''&&t.name));
      }
      if (tab==='List') {
        assert.equal(await panel.locator('article').first().locator('.rank-controls button').count(),3);
        assert(await panel.locator('.rank-controls button').evaluateAll(buttons=>buttons.every(b=>{const r=b.getBoundingClientRect();return r.width===32&&r.height===32&&getComputedStyle(b).backgroundColor==='rgb(62, 71, 80)';})));
      }
      if (tab!=='Rank' && [390,1440].includes(width)) await page.screenshot({path:`.wrangler/cards-${tab.toLowerCase()}-${width}.png`,fullPage:true});
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
  assert.equal(await page.locator('.artwork-edit').first().evaluate(b=>getComputedStyle(b).color),'rgb(255, 255, 255)');
  const editControl=page.locator('.artwork-edit').first();
  await editControl.hover();
  assert.equal(await editControl.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(45, 45, 45)');
  await editControl.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await editControl.evaluate(b=>getComputedStyle(b).outlineStyle),'solid');
  await page.keyboard.press('Enter');
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
  fanart=true; empty=false;
  await page.reload(); await page.getByRole('tab',{name:'List',exact:true}).click();
  await page.locator('#rankedList article').first().getByRole('button',{name:'Move down'}).click();
  await page.waitForResponse(r=>r.url().endsWith('/v1/board') && r.request().method()==='POST');
  assert.deepEqual(rankedIds,['b','a']);
  await page.locator('#rankedList article').last().getByRole('button',{name:'Move up'}).click();
  await page.waitForResponse(r=>r.url().endsWith('/v1/board') && r.request().method()==='POST');
  assert.deepEqual(rankedIds,['a','b']);
  await page.locator('#rankedList article').last().getByRole('button',{name:'Remove from ranking'}).click();
  await page.waitForResponse(r=>r.url().endsWith('/v1/board') && r.request().method()==='POST');
  assert.deepEqual(rankedIds,['a']);
  admin=false;
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900}); await page.goto(origin);
    await page.waitForFunction(()=>document.querySelector('#accountMenuButton').dataset.participantName==='Fixture participant');
    assert.equal(await page.locator('#catalogueList button').count(),0, 'Ordinary users have no persistent card actions');
    await page.locator('#titleInput').fill('fictional');
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await page.locator('#searchResults article').first().waitFor();
    assert.equal(await page.locator('#searchResults').getByRole('button',{name:'Nominate',exact:true}).count(),1);
    assert.equal(await page.locator('#searchResults').getByRole('button',{name:'Withdraw',exact:true}).count(),1);
    assert.equal(await page.locator('#searchResults .artwork-edit, #searchResults .artwork-remove').count(),0);
    assert(await page.locator('#searchResults article').evaluateAll(cards=>cards.every(card=>{
      const r=card.getBoundingClientRect();
      return Math.abs(r.width/r.height-200/37)<0.02 && [...card.querySelectorAll('.show-title, .show-subtitle')].every(node=>{const n=node.getBoundingClientRect();return n.top>=r.top&&n.bottom<=r.bottom;});
    })), 'Search preserves nomination access and card layout');
  }
  assert(mutations.every(path=>path==='/v1/ranking'), 'No nominations or removals changed during layout checks');
  assert.deepEqual(errors,[]);
  console.log('Artwork UI checks passed: 320/390/768/1440px, stacked text, admin/ordinary permissions, matching controls, retained ranking actions, exact ratios, no artwork overlay, keyboard picker, save/reopen, retry and empty Rank attribution (fictional API).');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }

