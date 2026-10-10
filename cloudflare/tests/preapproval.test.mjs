import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
import { mappingSql } from "../scripts/prepare-google-mapping.mjs";

const rows = async (db, table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
const durableTables = ["app_users", "shows", "show_nominations", "user_show_rankings"];
let migrationSnapshot;
const test = await fixture(undefined, {
  async beforeMigration(name, db) {
    if (name !== "0006_google_preapprovals.sql") return;
    await db.prepare("INSERT INTO app_users(id,display_name,link_token_hash,token_issued_at,created_at,updated_at) VALUES('migration-user','Migration fixture',?,'2026-01-01','2026-01-01','2026-01-01')").bind("7".repeat(64)).run();
    await db.prepare("INSERT INTO shows(id,imdb_id,title,first_enrolled_by,created_at,updated_at) VALUES('migration-show','tt90000008','Migration fixture','migration-user','2026-01-01','2026-01-01')").run();
    await db.prepare("INSERT INTO show_nominations VALUES('migration-user','migration-show','2026-01-01','2026-01-01',NULL)").run();
    await db.prepare("INSERT INTO user_show_rankings VALUES('migration-user','migration-show',1,'2026-01-01')").run();
    await db.prepare("INSERT INTO participant_google_auth VALUES('migration-user','migration-sub','migration@example.test',1,'2026-01-01','Preservation fixture')").run();
    await db.prepare("INSERT INTO auth_sessions VALUES(?,'migration-user','migration-sub','2026-01-01','2099-01-01')").bind("8".repeat(64)).run();
    migrationSnapshot = await Promise.all([...durableTables,"participant_google_auth","auth_sessions"].map(t => rows(db,t)));
  },
  async afterMigration(name, db) {
    if (name !== "0006_google_preapprovals.sql") return;
    assert.deepEqual(await Promise.all([...durableTables,"participant_google_auth","auth_sessions"].map(t => rows(db,t))), migrationSnapshot,
      "Additive preapproval migration preserves all existing data and identities");
    // Keep these fixtures to test that established identities cannot be claimed.
  }
});
const { env, request, signIn } = test;
const db = env.DB;
const api = (path, cookie, body = {}) => request(path,{ method:"POST", cookie, body });
const stamp = "2026-01-01";
const preapprove = (id,email,enabled=1) => db.prepare(`INSERT INTO participant_google_preapprovals(user_id,approved_email,enabled,approved_at,approval_note)
  VALUES((SELECT id FROM app_users WHERE id=? AND is_active=1),?,?,?,'Fictional operator preapproval')`).bind(id,email,enabled,stamp).run();
const mapping = id => db.prepare("SELECT * FROM participant_google_auth WHERE user_id=?").bind(id).first();
const preapproval = id => db.prepare("SELECT * FROM participant_google_preapprovals WHERE user_id=?").bind(id).first();
const reject = async (identity,claims={}) => {
  const result=await signIn(identity,claims);
  assert.equal(result.response.status,403);
  assert.deepEqual(await result.response.json(),{message:"This Google account is not approved. Contact the operator."});
  assert.equal(result.cookie,"");
};
try {
  for (const id of ["d","e","f","g","h","i"]) await db.prepare("INSERT INTO app_users(id,display_name,link_token_hash,is_active,token_issued_at,created_at,updated_at) VALUES(?,?,?,1,?,?,?)")
    .bind(id,`Fictional participant ${id}`,id.repeat(64),stamp,stamp,stamp).run();
  await db.prepare("INSERT INTO shows(id,imdb_id,title,first_enrolled_by,created_at,updated_at) VALUES('preserved-show','tt90000001','Fictional series','a',?,?)").bind(stamp,stamp).run();
  const identities = ["a","b","d","e"].map(id => ({id,sub:`preapproved-${id}`,email:`${id}@example.test`,hd:"example.test"}));
  await assert.rejects(() => db.prepare(`INSERT INTO participant_google_preapprovals(user_id,approved_email,approved_at,approval_note)
    VALUES((SELECT id FROM app_users WHERE id='a' AND display_name='Participant A'),'a@example.test',?,'Fictional batch'),
          ((SELECT id FROM app_users WHERE id='b' AND display_name='Wrong participant'),'b@example.test',?,'Fictional batch')`)
    .bind(stamp,stamp).run(),/constraint|NOT NULL/i);
  assert.deepEqual(await rows(db,"participant_google_preapprovals"),[],"A wrong participant in the console batch rolls back all proposed approvals");
  for(const identity of identities) {
    await preapprove(identity.id,identity.email);
    await db.prepare("INSERT INTO show_nominations VALUES(?,'preserved-show',?,?,NULL)").bind(identity.id,stamp,stamp).run();
    await db.prepare("INSERT INTO user_show_rankings VALUES(?,'preserved-show',1,?)").bind(identity.id,stamp).run();
  }
  assert.equal((await rows(db,"participant_google_preapprovals")).length,4);
  assert.equal(await mapping("a"),null,"Preapproval needs no prior sign-in/sub");
  const preserved = await Promise.all(durableTables.map(t=>rows(db,t)));
  // Invalid credentials cannot consume the email allowance or establish a sub.
  for(const claims of [{email_verified:false},{aud:"wrong"},{iss:"https://wrong.test"},{nonce:"wrong"},{exp:1}]) {
    assert.equal((await signIn(identities[0],claims)).response.status,401);
    assert.equal((await preapproval("a")).claimed_at,null);assert.equal(await mapping("a"),null);
  }
  const flow=await test.begin();const token=(await test.credential(flow.nonce,identities[0])).split(".");token[2]=(token[2][0]==="A"?"B":"A")+token[2].slice(1);
  assert.equal((await api("/auth/google",flow.cookie,{credential:token.join("."),remember:true})).status,401);
  assert.equal((await preapproval("a")).claimed_at,null);
  await reject({sub:"unknown",email:"unknown@example.test",hd:"example.test"});
  await reject({...identities[0],email:"a+alias@example.test"});
  await reject({...identities[0],email:"a@EXAMPLE.test",hd:undefined}); // Valid verification alone isn't authoritative.
  await assert.rejects(()=>preapprove("missing","missing@example.test"),/constraint|NOT NULL/i);
  await assert.rejects(()=>preapprove("a","other@example.test"),/UNIQUE|constraint/i);
  await assert.rejects(()=>preapprove("f",identities[0].email),/UNIQUE|constraint/i);
  await assert.rejects(()=>preapprove("f","MixedCase@example.test"),/CHECK|constraint/i);
  await assert.rejects(()=>preapprove("migration-user","different@example.test"),/established mapping/i);
  await assert.rejects(()=>preapprove("f","migration@example.test"),/established mapping/i);
  const sessions = new Map();
  for(const identity of identities) {
    const signed=await signIn({...identity,email:identity.email.toUpperCase()});
    assert.equal(signed.response.status,200);assert.deepEqual(await signed.response.json(),{signed_in:true});
    assert.equal((await mapping(identity.id)).google_sub,identity.sub);
    assert.equal((await mapping(identity.id)).approved_email,identity.email);
    assert((await preapproval(identity.id)).claimed_at);
    assert.equal((await (await request("/auth/session",{cookie:signed.cookie})).json()).current_user.id,identity.id);
    sessions.set(identity.id,signed.cookie);
  }
  assert.deepEqual(await Promise.all(durableTables.map(t=>rows(db,t))),preserved,"First sign-ins preserve participant IDs and all nominations/rankings");
  const claimed=await preapproval("a"), established=await mapping("a");
  await reject({...identities[0],sub:"replacement-sub"});
  await assert.rejects(()=>db.prepare("UPDATE participant_google_preapprovals SET claimed_at=NULL WHERE user_id='a'").run(),/established identity/i);
  await assert.rejects(()=>db.prepare("UPDATE participant_google_preapprovals SET approved_email='replacement@example.test' WHERE user_id='a'").run(),/established identity/i);
  assert.deepEqual(await preapproval("a"),claimed);assert.deepEqual(await mapping("a"),established);
  const renamed=await signIn({...identities[0],email:"changed@example.test",hd:undefined});
  assert.equal(renamed.response.status,200,"Future authentication uses stable sub even when email changes");
  assert.deepEqual(await mapping("a"),established,"Future sign-in cannot rewrite approval data");
  await preapprove("f","changed@example.test");
  await signIn({...identities[0],email:"changed@example.test",hd:"example.test"});
  assert.equal(await mapping("f"),null,"Established subject cannot claim another participant");
  assert.equal((await preapproval("f")).claimed_at,null);
  await db.prepare("UPDATE participant_google_auth SET enabled=0 WHERE user_id='a'").run();
  assert.equal((await request("/auth/session",{cookie:renamed.cookie})).status,401);
  await reject(identities[0]);await reject({...identities[0],email:"changed@example.test"});
  assert.equal(await mapping("f"),null,"Disabled established subject cannot be reassigned");
  await db.prepare("DELETE FROM participant_google_auth WHERE user_id='b'").run();await reject(identities[1]);
  assert.equal(await mapping("b"),null,"Consumed preapproval cannot silently recreate a deleted mapping");
  await preapprove("g","g@example.test",0);await reject({sub:"google-g",email:"g@example.test",hd:"example.test"});
  assert.equal((await preapproval("g")).claimed_at,null);
  await db.prepare("INSERT INTO participant_google_preapprovals VALUES('c','c@example.test',1,?,'Inactive fictional participant',NULL)").bind(stamp).run();
  await reject({sub:"google-c",email:"c@example.test",hd:"example.test"});assert.equal(await mapping("c"),null);
  await preapprove("h","fictional.preapproval.h@gmail.com");
  const gmail=await signIn({sub:"gmail-h",email:"fictional.preapproval.h@gmail.com"});assert.equal(gmail.response.status,200,"Gmail needs no hosted-domain claim");
  assert.equal((await api("/auth/google",gmail.flow.cookie,gmail.body)).status,401,"A signed first-use credential cannot replay its consumed challenge");
  await preapprove("i","race@example.test");
  await db.prepare("CREATE TRIGGER fixture_claim_abort AFTER INSERT ON participant_google_auth WHEN NEW.user_id='i' BEGIN SELECT RAISE(ABORT,'Fictional failure'); END;").run();
  assert.equal((await signIn({sub:"failed-claim",email:"race@example.test",hd:"example.test"})).response.status,500);
  assert.equal(await mapping("i"),null);assert.equal((await preapproval("i")).claimed_at,null,"A failed binding rolls back its consumption trigger");
  await db.prepare("DROP TRIGGER fixture_claim_abort").run();
  const race=await Promise.all([signIn({sub:"race-one",email:"race@example.test",hd:"example.test"}),signIn({sub:"race-two",email:"race@example.test",hd:"example.test"})]);
  assert.deepEqual(race.map(r=>r.response.status).sort(),[200,403]);
  const winner=(await mapping("i")).google_sub;
  assert(["race-one","race-two"].includes(winner));
  assert.equal((await signIn({sub:winner,email:"race@example.test",hd:"example.test"})).response.status,200,"Concurrent claim winner can sign in again");
  // Non-authoritative email recovery still requires human-reviewed stable subject.
  const thirdParty={sub:"third-party-g",email:"g@example.test"};await reject(thirdParty);
  const approvalRequest=await db.prepare("SELECT id FROM auth_requests WHERE google_sub=?").bind(thirdParty.sub).first();
  await db.prepare(mappingSql({action:"approve",participantId:"g",expectedName:"Fictional participant g",requestId:approvalRequest.id,verifiedEmail:thirdParty.email,note:"Fictional operator checked account ownership"})).run();
  assert((await preapproval("g")).claimed_at,"Operator-reviewed first binding also consumes its allowance");
  assert.equal((await signIn(thirdParty)).response.status,200,"Reviewed third-party identity remains supported");
  // Existing operator recovery requires the exact previous subject, no automatic replacement.
  const replacement={sub:"reviewed-replacement",email:"replacement@example.test"};await reject(replacement);
  const recoveryRequest=await db.prepare("SELECT id FROM auth_requests WHERE google_sub=?").bind(replacement.sub).first();
  const recovery={action:"approve",participantId:"a",expectedName:"Participant A",requestId:recoveryRequest.id,verifiedEmail:replacement.email,note:"Fictional operator recovery"};
  assert.equal((await db.prepare(mappingSql({...recovery,previousSubject:"wrong"})).all()).results.length,0);
  assert.equal((await db.prepare(mappingSql({...recovery,previousSubject:identities[0].sub})).all()).results.length,1);
  assert.equal((await signIn(replacement)).response.status,200);
  await reject(identities[0]);assert.deepEqual(await preapproval("a"),claimed);
  assert.deepEqual(await Promise.all(durableTables.map(t=>rows(db,t))),preserved);
  const privateValues=[...identities.map(i=>i.email),...identities.map(i=>i.sub),"race@example.test","reviewed-replacement"];
  for(const path of ["/auth/config","/auth/session","/v1/load","/v1/admin/status"]) {
    const response=path.startsWith("/v1/")?await api(path,sessions.get("d")):await request(path,{cookie:sessions.get("d")});
    assert.equal(response.status,path==="/v1/admin/status"?403:200);
    const body=await response.text();for(const value of privateValues) assert(!body.includes(value),`${path} does not expose approvals`);
    assert.equal(response.headers.get("cache-control"),"private, no-store");
  }
  for(const path of ["/v1/preapprove","/v1/admin/preapprove","/auth/preapprove"]) assert.equal((await api(path,sessions.get("d"))).status,404,"No browser approval endpoint");
  for(const path of ["/app.js","/store.js","/config.js","/index.html","/login.html"]) {
    const body=await (await request(path,{cookie:sessions.get("d")})).text();for(const value of privateValues) assert(!body.includes(value));
  }
  console.log("Preapproval migration/data preservation, four first-use mappings, verification/authority, replay, races, stable-sub login, revocation, recovery and response/asset privacy passed.");
} finally { await test.dispose(); }
