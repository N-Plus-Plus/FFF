import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture } from "./fixture.mjs";
import { outstandingCount, reminderWednesday, reminderText, sendRankingReminders } from "../src/ranking-reminders.js";

const event = (iso, cron = "0 1 * * 3") => ({ scheduledTime: Date.parse(iso), cron });
// Wednesdays immediately before/after both Sydney DST transitions, plus summer/winter.
for (const [day, hour] of [["2026-01-07", "01"], ["2026-04-01", "01"], ["2026-04-08", "02"],
  ["2026-07-01", "02"], ["2026-09-30", "02"], ["2026-10-07", "01"], ["2026-12-30", "01"]]) {
  assert.equal(reminderWednesday(Date.parse(`${day}T${hour}:00:00Z`)), day);
  assert.equal(reminderWednesday(Date.parse(`${day}T${hour === "01" ? "02" : "01"}:00:00Z`)), null);
  assert.equal(reminderWednesday(Date.parse(`${day}T${hour}:01:00Z`)), null);
}
assert.equal(reminderWednesday(Date.parse("2026-10-08T01:00:00Z")), null);
assert.equal(reminderWednesday(undefined), null);
assert.equal(reminderWednesday(NaN), null);

let snapshot;
const preserved = ["app_users", "shows", "show_nominations", "user_show_rankings", "participant_google_auth", "participant_google_preapprovals"];
const dump = db => Promise.all(preserved.map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results));
const test = await fixture(undefined, {
  async beforeMigration(name, db) { if (name === "0007_ranking_reminders.sql") snapshot = await dump(db); },
  async afterMigration(name, db) { if (name === "0007_ranking_reminders.sql") assert.deepEqual(await dump(db), snapshot); }
});
const { env, signIn, request, worker } = test;
const db = env.DB, stamp = "2026-01-01";
const deliveries = async () => (await db.prepare("SELECT * FROM ranking_reminder_deliveries ORDER BY user_id,local_wednesday").all()).results;
try {
  for (const id of ["d", "e", "f", "g"]) await db.prepare(`INSERT INTO app_users
    (id,display_name,link_token_hash,token_issued_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .bind(id, `Fictional ${id}`, id.repeat(64), stamp, stamp, stamp).run();
  for (const id of ["a", "b", "c", "d", "e", "f"]) await db.prepare("INSERT INTO participant_google_auth VALUES(?,?,?,?,?,?)")
    .bind(id, `synthetic-${id}`, `${id}@example.test`, id === "f" ? 0 : 1, stamp, "Fictional approval").run();
  await db.prepare("INSERT INTO participant_google_preapprovals VALUES('g','unclaimed@example.test',1,?,'Fictional preapproval',NULL)").bind(stamp).run();
  for (const [id, removed] of [["s1", null], ["s2", null], ["s3", null], ["removed", stamp], ["withdrawn", null], ["inactive", null]]) {
    await db.prepare("INSERT INTO shows(id,imdb_id,title,first_enrolled_by,created_at,updated_at,admin_removed_at) VALUES(?,?,?,?,?,?,?)")
      .bind(id, `tt${90000000 + ["s1", "s2", "s3", "removed", "withdrawn", "inactive"].indexOf(id)}`, id, "a", stamp, stamp, removed).run();
    if (id !== "inactive") await db.prepare("INSERT INTO show_nominations VALUES('a',?,?,?,?)")
      .bind(id, stamp, stamp, id === "withdrawn" ? stamp : null).run();
  }
  await db.prepare("INSERT INTO show_nominations VALUES('b','s2',?,?,NULL)").bind(stamp, stamp).run();
  await db.prepare("INSERT INTO user_show_rankings VALUES('a','s1',1,?)").bind(stamp).run();
  await db.prepare("INSERT INTO user_show_rankings VALUES('a','s2',NULL,?)").bind(stamp).run();
  for (const [index, id] of ["s1", "s2", "s3"].entries()) await db.prepare("INSERT INTO user_show_rankings VALUES('d',?,?,?)")
    .bind(id, index + 1, stamp).run();
  assert.equal(await outstandingCount(db, "a"), 2);
  assert.equal(await outstandingCount(db, "b"), 3);
  assert.equal(await outstandingCount(db, "d"), 0);
  assert.equal(await outstandingCount(db, "e"), 3, "All global shows, not only own nominations");
  const login = await signIn({ sub: "synthetic-a", email: "a@example.test" });
  assert.equal(login.response.status, 200);
  const api = (path, body = {}) => request(path, { method: "POST", cookie: login.cookie, body });
  const order = await (await api("/v1/order")).json();
  assert.equal(order.unranked.length, await outstandingCount(db, "a"), "Reminder uses actual Order semantics including NULL ranks");

  const sent = [];
  const enabled = { ...env, RANKING_REMINDERS_ENABLED: "true", RANKING_EMAIL: { async send(message) {
    sent.push(message);
    if (message.to === "b@example.test") throw new Error("Sensitive provider diagnostic b@example.test");
  } } };
  const summer = event("2026-10-14T01:00:00Z");
  await sendRankingReminders(summer, { ...enabled, RANKING_REMINDERS_ENABLED: "false" });
  await sendRankingReminders(event("2026-10-14T02:00:00Z", "0 2 * * 3"), enabled);
  assert.deepEqual(await deliveries(), []);
  // Concurrent D1 claims, not just sequential replay. Failed sends also dedupe.
  await Promise.all([sendRankingReminders(summer, enabled), sendRankingReminders(summer, enabled)]);
  await sendRankingReminders(summer, enabled);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map(m => m.to).sort(), ["a@example.test", "b@example.test", "e@example.test"]);
  for (const message of sent) {
    assert.deepEqual(Object.keys(message).sort(), ["from", "subject", "text", "to"]);
    assert.equal(message.from, "troy@nissen.nexus");
    assert.equal(message.subject, "Wire Wednesday needs you!");
    assert.equal(message.text, `You have ${message.to === "a@example.test" ? 2 : 3} shows to rank in Wire Wednesday app. Log in at https://wirewednesday.nissen.nexus/ to complete rankings.\n\nCheers,\nRobotroy`);
  }
  const audit = await deliveries();
  assert.deepEqual(audit.map(r => [r.user_id, r.status]), [["a", "accepted"], ["b", "failed"], ["e", "accepted"]]);
  assert.doesNotMatch(JSON.stringify(audit), /@|Wire Wednesday|Robotroy|Sensitive/);
  assert.equal(await db.prepare("SELECT 1 FROM ranking_reminder_deliveries WHERE user_id='d'").first(), null);

  // Real withdrawal path clears the actor's ranking; another nomination retains visibility.
  assert.equal((await api("/v1/withdraw", { showId: "s2" })).status, 200);
  assert.equal(await outstandingCount(db, "e"), 3);
  const loginB = await signIn({ sub: "synthetic-b", email: "b@example.test" });
  assert.equal((await request("/v1/withdraw", { method: "POST", cookie: loginB.cookie, body: { showId: "s2" } })).status, 200);
  assert.equal(await outstandingCount(db, "e"), 2, "Final withdrawal removes show globally");
  assert.equal(await db.prepare("SELECT 1 FROM user_show_rankings WHERE show_id='s2'").first(), null);
  assert.equal((await api("/v1/admin/remove", { showId: "s3" })).status, 200);
  assert.equal(await outstandingCount(db, "e"), 1, "Admin-removed shows are invisible");
  assert.equal(await outstandingCount(db, "a"), 0);
  // Failures do not suppress next week's independent attempt.
  const next = event("2026-10-21T01:00:00Z");
  await sendRankingReminders(next, { ...enabled, RANKING_EMAIL: { async send(m) { sent.push(m); } } });
  assert.equal(sent.length, 5);
  assert.equal((await deliveries()).find(r => r.user_id === "b" && r.local_wednesday === "2026-10-21").status, "accepted");

  // Simulate an interrupted invocation with a claimed/unknown send outcome.
  await db.prepare("INSERT INTO ranking_reminder_deliveries VALUES('e','2026-10-28',1,'claimed',?,NULL)").bind(stamp).run();
  await db.prepare("UPDATE participant_google_auth SET enabled=0 WHERE user_id='b'").run();
  await sendRankingReminders(event("2026-10-28T01:00:00Z"), enabled);
  assert.equal(sent.length, 5, "Unknown outcomes never reacquire send authority");
  // Revalidate membership after the claim, including a revocation during a run.
  const revoking = { ...enabled, DB: { prepare(sql) {
    if (sql.startsWith("SELECT a.approved_email")) return { bind(id) { return { async first() {
      await db.prepare("UPDATE participant_google_auth SET enabled=0 WHERE user_id=?").bind(id).run(); return null;
    } }; } };
    return db.prepare(sql);
  } } };
  await sendRankingReminders(event("2026-11-04T01:00:00Z"), revoking);
  assert.equal(sent.length, 5);
  assert.equal((await deliveries()).find(r => r.local_wednesday === "2026-11-04").status, "blocked");

  // Acceptance followed by a failed audit write is an uncertain outcome. Keep
  // the claim, finish other users, report only a safe error, and never resend.
  await db.prepare("UPDATE participant_google_auth SET enabled=1 WHERE user_id IN ('b','e')").run();
  const uncertain = { ...enabled, RANKING_EMAIL: { async send(m) { sent.push(m); } }, DB: { prepare(sql) {
    if (sql.startsWith("UPDATE ranking_reminder_deliveries")) return { bind(...values) {
      if (values[2] === "b") return { async run() { throw new Error("Private D1/provider payload b@example.test"); } };
      return db.prepare(sql).bind(...values);
    } };
    return db.prepare(sql);
  } } };
  const interrupted = event("2026-11-11T01:00:00Z");
  await assert.rejects(sendRankingReminders(interrupted, uncertain), { message: "Ranking reminder processing incomplete; inspect private delivery audit." });
  assert.equal(sent.length, 7, "Audit failure for one user cannot stop the next user's send");
  assert.deepEqual((await deliveries()).filter(r => r.local_wednesday === "2026-11-11").map(r => r.status), ["claimed", "accepted"]);
  await sendRankingReminders(interrupted, enabled);
  assert.equal(sent.length, 7);
  // Never allow recipient header injection from a malformed private mapping.
  await db.prepare("UPDATE participant_google_auth SET enabled=0 WHERE user_id='b'").run();
  await db.prepare("UPDATE participant_google_auth SET approved_email='bad@example.test,other@example.test' WHERE user_id='e'").run();
  await sendRankingReminders(event("2026-11-18T01:00:00Z"), enabled);
  assert.equal(sent.length, 7);
  assert.equal((await deliveries()).find(r => r.local_wednesday === "2026-11-18").status, "blocked");

  for (const path of ["/v1/load", "/v1/order", "/v1/board", "/v1/admin/status"]) {
    const response = await api(path);
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /@example\.test|approved_email|ranking_reminder_deliveries|local_wednesday/);
  }
  assert.equal((await api("/v1/ranking-reminders")).status, 404, "No HTTP send capability");
  const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
  assert.deepEqual(config.send_email, [{ name: "RANKING_EMAIL", allowed_sender_addresses: ["troy@nissen.nexus"], remote: false }]);
  assert.equal(config.vars.RANKING_REMINDERS_ENABLED, "false");
  assert.doesNotMatch(JSON.stringify(config), /@example\.test|allowed_destination_addresses|destination_address/);
  // Cron dispatch preserves metadata at 02:00 and never runs it at 01:00.
  let metadataRuns = 0;
  const dispatchEnv = { ...env, DB: { prepare(sql) {
    assert.match(sql, /metadata_refresh_succeeded_at/);
    metadataRuns++;
    return { async all() { return { results: [] }; } };
  } } };
  for (const cron of config.triggers.crons) {
    const tasks = [];
    await worker.scheduled(event(`2026-10-14T0${cron.includes(" 2 ") ? "2" : "1"}:00:00Z`, cron), dispatchEnv, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
  }
  assert.equal(metadataRuns, 1);
  assert.equal(reminderText(1).includes("1 shows"), true, "Preserve requested wording");
  console.log("Ranking reminder counts, withdrawals/removal, privacy, DST, concurrency, failure and Cron dispatch passed; disposable D1 and synthetic email only.");
} finally { await test.dispose(); }
