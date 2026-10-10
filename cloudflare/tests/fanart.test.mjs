import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { fixture } from "./fixture.mjs";
import { mappingSql } from "../scripts/prepare-google-mapping.mjs";
import { banners } from "../src/fanart.js";

let test, browser;
const server = createServer(async (req,res) => {
  try {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const response=await test.worker.fetch(new Request(origin+req.url,{method:req.method,headers:req.headers,
      body:["GET","HEAD"].includes(req.method)?undefined:Buffer.concat(chunks),duplex:"half"}),test.env);
    res.statusCode=response.status;
    for(const [name,value] of response.headers) if(name!=="set-cookie") res.setHeader(name,value);
    if(response.headers.getSetCookie().length) res.setHeader("set-cookie",response.headers.getSetCookie());
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.statusCode=500;res.end("Fixture failed");}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
  test=await fixture(origin);
  const {env,request,signIn}=test; env.FANART_TV="synthetic-only-key";
  let calls=0, downloads=0, mode="ok", downloadFailure=false;
  const image=(id,width=1000,height=185,url=`https://assets.fanart.tv/fanart/tv/123/tvbanner/banner-${id}.png`)=>({id:String(id),url,width:String(width),height:String(height),lang:"en"});
  let choices=[image(1,1920,1080),image(2),image(3),image(4,1000,185,"https://untrusted.example/image.jpg"),image(2)];
  // A real PNG fixture for browser loading, never an external request.
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=","base64");
  globalThis.fetch=async (value,options={})=>{
    const url=new URL(value);
    if(url.origin==="https://api.tvmaze.com") {
      if(url.pathname.includes("lookup")) return Response.json({id:1,name:"Synthetic show",externals:{imdb:url.searchParams.get("imdb"),thetvdb:123},image:{original:"https://fixture.test/poster.png"}});
      if(url.pathname.endsWith("episodes")) return Response.json([{runtime:42,season:1}]);
      return Response.json([{type:"banner",resolutions:{original:{url:"https://fixture.test/banner.png",width:1000,height:200}}}]);
    }
    if(url.origin==="https://webservice.fanart.tv") {
      calls++; assert.equal(url.pathname,"/v3.2/tv/123"); assert.equal(url.search,""); assert.equal(options.headers["api-key"],env.FANART_TV);
      if(mode==="429") return new Response("private upstream error",{status:429,headers:{"Retry-After":"600"}});
      if(mode==="404") return new Response(null,{status:404});
      return Response.json({thetvdb_id:mode==="wrong-id"?"999":"123",...(mode==="absent"?{}:{tvbanner:choices})});
    }
    if(url.origin==="https://assets.fanart.tv" || url.origin==="https://fixture.test") {
      downloads++; return downloadFailure?new Response("fail",{status:500}):new Response(png,{headers:{"content-type":"image/png"}});
    }
    throw new Error("Unexpected network access");
  };
  const api=(path,cookie,body={})=>request(path,{method:"POST",cookie,body});
  const login=async(id)=>{
    const identity={sub:`google-${id}`,email:`${id}@example.test`}; await signIn(identity);
    const pending=await env.DB.prepare("SELECT id FROM auth_requests WHERE google_sub=?").bind(identity.sub).first();
    await env.DB.prepare(mappingSql({action:"approve",participantId:id,expectedName:`Participant ${id.toUpperCase()}`,requestId:pending.id,verifiedEmail:identity.email,note:"Synthetic artwork approval"})).run();
    return (await signIn(identity)).cookie;
  };
  const admin=await login("a"), member=await login("b");
  assert.equal((await api("/v1/admin/artwork","",{imdbId:"tt90000001"})).status,401);
  assert.equal((await api("/v1/admin/artwork",member,{imdbId:"tt90000001"})).status,403);
  const enrolled=await (await api("/v1/nominate",admin,{imdbId:"tt90000001"})).json();
  const showId=enrolled.id;
  assert.equal(enrolled.fanart_banner_id,"2","First suitable banner wins");
  assert.equal(enrolled.card_art_manual,0); assert.equal(enrolled.card_art_width,1000);assert.equal(enrolled.card_art_height,185);
  const options=await (await api("/v1/admin/artwork",admin,{imdbId:"tt90000001"})).json();
  assert.deepEqual(options.banners.map(b=>b.id),["2","3"]); assert.equal(calls,1,"D1 caches discovery");
  assert(!JSON.stringify(options).includes(env.FANART_TV)); assert(options.banners.every(b=>b.url.startsWith("/artwork/fanart/")));
  await api("/v1/ranking",admin,{showIds:[showId]});
  const preserved=await Promise.all(["show_nominations","user_show_rankings"].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
  const before=await env.DB.prepare("SELECT * FROM shows WHERE id=?").bind(showId).first();
  assert.equal((await api("/v1/admin/artwork",member,{action:"save",imdbId:"tt90000001",bannerId:"3"})).status,403);
  assert.equal((await api("/v1/admin/artwork",admin,{action:"save",imdbId:"tt90000001",bannerId:"999",url:"https://evil.test"})).status,400);
  downloadFailure=true;
  assert.equal((await api("/v1/admin/artwork",admin,{action:"save",imdbId:"tt90000001",bannerId:"3"})).status,503);
  assert.deepEqual(await env.DB.prepare("SELECT * FROM shows WHERE id=?").bind(showId).first(),before,"Failed save is not a success");
  downloadFailure=false;
  assert.equal((await api("/v1/admin/artwork",admin,{action:"save",imdbId:"tt90000001",bannerId:"3"})).status,200);
  const manual=await env.DB.prepare("SELECT * FROM shows WHERE id=?").bind(showId).first();
  assert.equal(manual.fanart_banner_id,"3");assert.equal(manual.card_art_manual,1);
  for(const key of Object.keys(before).filter(k=>!k.startsWith("card_art_")&&!['fanart_banner_id','background_url'].includes(k))) assert.deepEqual(manual[key],before[key],`Unrelated show field ${key} preserved`);
  const artwork=await request(`/artwork/${manual.card_art_storage_path}`,{cookie:member});
  assert.equal(artwork.status,200);assert.equal(artwork.headers.get("cache-control"),"private, no-store");
  assert.equal((await request(`/artwork/${manual.card_art_storage_path}`)).status,401);
  assert.equal((await request("/artwork/fanart/123/3",{cookie:admin})).status,200);
  const downloaded=downloads;
  assert.equal((await request("/artwork/fanart/123/3",{cookie:admin})).status,200);assert.equal(downloads,downloaded,"R2 reuses downloaded artwork");
  choices=[image(2)];await env.DB.prepare("DELETE FROM fanart_cache").run();
  await api("/v1/metadata",admin,{action:"verify-backgrounds",items:[{showId,imdbId:"tt90000001"}]});
  await env.DB.prepare("UPDATE shows SET metadata_refresh_succeeded_at=NULL WHERE id=?").bind(showId).run();
  const scheduled=[];await test.worker.scheduled({},env,{waitUntil(p){scheduled.push(p);}});await Promise.all(scheduled);
  await api("/v1/nominate",member,{imdbId:"tt90000001"});
  assert.equal((await env.DB.prepare("SELECT * FROM shows WHERE id=?").bind(showId).first()).card_art_storage_path,manual.card_art_storage_path,"Manual choice survives audit, Cron and nomination");
  // Nomination above is intentional fixture setup; verify save itself preserved rows before proceeding.
  await env.DB.prepare("DELETE FROM show_nominations WHERE user_id='b'").run();
  assert.deepEqual(await Promise.all(["show_nominations","user_show_rankings"].map(async table=>(await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)),preserved);
  for(const path of ["/v1/catalogue","/v1/order","/v1/board"]) {
    const data=await (await api(path,admin)).json();const rows=data.shows||data.ranked||data.entries;
    assert.equal(rows[0].card_art_storage_path,manual.card_art_storage_path,`${path} canonical artwork`);
  }
  mode="absent";await env.DB.prepare("DELETE FROM fanart_cache").run();assert.deepEqual(await banners("123",env),[]);
  const fallback=await (await api("/v1/nominate",admin,{imdbId:"tt90000002"})).json();assert.equal(fallback.card_art_type,"banner");assert.equal(fallback.card_art_manual,0);
  mode="404";await env.DB.prepare("DELETE FROM fanart_cache").run();assert.deepEqual(await banners("123",env),[]);
  mode="wrong-id";await env.DB.prepare("DELETE FROM fanart_cache").run();await assert.rejects(()=>banners("123",env),/unavailable/);
  mode="429";await env.DB.prepare("DELETE FROM fanart_cache").run();await assert.rejects(()=>banners("123",env),/unavailable/);
  const rateCalls=calls;await assert.rejects(()=>banners("123",env),/unavailable/);assert.equal(calls,rateCalls);
  assert((await env.DB.prepare("SELECT expires_at FROM fanart_cache").first()).expires_at>Date.now()+590000,"Retry-After respected");
  mode="ok";choices=[image(2),image(3)];await env.DB.prepare("DELETE FROM fanart_cache").run();
  // Search-result artwork may create a canonical row, but never a nomination/ranking.
  const nBefore=(await env.DB.prepare("SELECT count(*) n FROM show_nominations").first()).n;
  assert.equal((await api("/v1/admin/artwork",admin,{action:"save",imdbId:"tt90000003",bannerId:"3"})).status,200);
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM show_nominations").first()).n,nBefore);
  console.log("fanart provider, caching, auth, R2, fallback, immutable manual selection, Cron and data preservation passed.");

  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addCookies([{name:"ww-local-session",value:admin.split("=")[1],url:origin,httpOnly:true,sameSite:"Lax"}]);
  await context.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin);const edit=page.locator("#catalogueList").getByRole("button",{name:"Edit artwork for Synthetic show"}).first();await edit.waitFor();
  const position=await edit.evaluate(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,nextLeft:e.nextElementSibling.getBoundingClientRect().left}));assert(position.right<=position.nextLeft,"Edit sits immediately left of nomination action");
  await edit.click();const dialog=page.getByRole("dialog");await dialog.getByText(/Currently selected/).waitFor();
  assert.equal(await dialog.getByRole("radio",{checked:true}).inputValue(),"3");
  for(const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)) console.log("Overflow",width,await page.evaluate(()=>Array.from(document.querySelectorAll("body *")).filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>[e.tagName,e.className,e.getBoundingClientRect().right])));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const box=await dialog.boundingBox();assert(box.x>=0&&box.x+box.width<=width);
  }
  await dialog.getByRole("radio").first().check();await dialog.getByRole("button",{name:"Save selection"}).click();await dialog.waitFor({state:"detached"});
  const selected=await env.DB.prepare("SELECT card_art_storage_path FROM shows WHERE id=?").bind(showId).first();
  assert((await page.locator('#catalogueList .card-background img').first().getAttribute('src')).includes(selected.card_art_storage_path));
  for(const tab of ["List","Watch"]) {await page.getByRole("tab",{name:tab,exact:true}).click();await page.waitForFunction(path=>Array.from(document.querySelectorAll('.panel.is-active .card-background img')).some(i=>i.src.includes(path)),selected.card_art_storage_path);}
  await page.getByRole("tab",{name:"Nominate",exact:true}).click();await edit.click();await dialog.getByRole("radio").first().waitFor();await page.keyboard.press("Escape");await dialog.waitFor({state:"detached"});assert(await edit.evaluate(e=>e===document.activeElement));
  // UI loading, empty, retryable provider errors and failed-save feedback.
  let release;await page.route("**/v1/admin/artwork",async route=>{await new Promise(resolve=>{release=resolve;});await route.fulfill({json:{banners:[]}});});
  await edit.click();await dialog.getByText("Loading banners…").waitFor();while(!release) await page.waitForTimeout(20);release();await dialog.getByText(/No suitable/).waitFor();assert(await dialog.getByRole("button",{name:"Save selection"}).isDisabled());await page.keyboard.press("Escape");
  await page.unroute("**/v1/admin/artwork");await page.route("**/v1/admin/artwork",route=>route.fulfill({status:503,json:{message:"Mock artwork unavailable"}}));
  await edit.click();await dialog.getByText("Mock artwork unavailable").waitFor();assert(await dialog.getByRole("button",{name:"Retry"}).isVisible());await page.keyboard.press("Escape");await page.unroute("**/v1/admin/artwork");
  await page.route("**/v1/admin/artwork",route=>route.request().postDataJSON().action==="save"?route.fulfill({status:503,json:{message:"Mock save failed"}}):route.continue());
  await edit.click();await dialog.getByRole("radio").last().check();await dialog.getByRole("button",{name:"Save selection"}).click();await dialog.getByText("Mock save failed").waitFor();assert(await dialog.getByRole("button",{name:"Save selection"}).isEnabled());await page.keyboard.press("Escape");
  assert.deepEqual(errors,[]);
  await context.close();
  const ordinary=await browser.newContext();await ordinary.addCookies([{name:"ww-local-session",value:member.split("=")[1],url:origin,httpOnly:true,sameSite:"Lax"}]);const memberPage=await ordinary.newPage();await memberPage.goto(origin);await memberPage.locator('#catalogueList .result-card').first().waitFor();assert.equal(await memberPage.locator('.artwork-edit').count(),0);await ordinary.close();
  console.log("Artwork picker mobile/desktop, current selection, Save, canonical screens, keyboard focus, loading/empty/errors and admin-only UI passed.");
} finally {
  if(browser) await browser.close();await new Promise(resolve=>server.close(resolve));if(test) await test.dispose();
}
