import { ACTIVE_SHOW_SQL } from "./show-visibility.js";

export const REMINDER_SENDER = "troy@nissen.nexus";
export const REMINDER_SUBJECT = "Wire Wednesday needs you!";
export const reminderText = (count) => `You have ${count} shows to rank in Wire Wednesday app. Log in at https://wirewednesday.nissen.nexus/ to complete rankings.\n\nCheers,\nRobotroy`;

const sydney = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", weekday: "short", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

// Use the scheduled time, not wall-clock invocation time: late delivery of the
// Cron event must still select the same local Wednesday and deduplication key.
export function reminderWednesday(scheduledTime) {
  if (!Number.isFinite(scheduledTime)) return null;
  const parts = Object.fromEntries(sydney.formatToParts(new Date(scheduledTime)).map(({ type, value }) => [type, value]));
  if (parts.weekday !== "Wed" || parts.hour !== "12" || parts.minute !== "00" || parts.second !== "00") return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function outstandingCount(db, userId) {
  const row = await db.prepare(`SELECT count(*) AS outstanding FROM shows s WHERE ${ACTIVE_SHOW_SQL}
    AND NOT EXISTS (SELECT 1 FROM user_show_rankings r WHERE r.show_id=s.id AND r.user_id=? AND r.rank_position IS NOT NULL)`)
    .bind(userId).first();
  return Number(row.outstanding);
}

const validRecipient = (email) => typeof email === "string" && email.length <= 254 &&
  email === email.trim().toLowerCase() && /^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(email);

export async function sendRankingReminders(event, env) {
  const day = reminderWednesday(event.scheduledTime);
  if (env.RANKING_REMINDERS_ENABLED !== "true" || !day) return;
  if (!env.RANKING_EMAIL?.send) throw new Error("Ranking reminder email binding unavailable.");
  const db = env.DB;
  // Match Board's active-participant rule. Preapprovals/auth_requests do not
  // grant app access and must never supply recipient addresses.
  const users = (await db.prepare(`SELECT u.id FROM app_users u
    JOIN participant_google_auth a ON a.user_id=u.id WHERE u.is_active=1 AND a.enabled=1 ORDER BY u.id`).all()).results;
  let failures = 0;
  for (const user of users) {
    try {
      const count = await outstandingCount(db, user.id);
      if (!count) continue;
      const stamp = new Date().toISOString();
      // The unique key is the only send authority. No lease expiry/reclaim:
      // a crash after email acceptance cannot safely be distinguished from a
      // crash before sending. INSERT is atomic across overlapping invocations.
      const claim = await db.prepare(`INSERT INTO ranking_reminder_deliveries
        (user_id,local_wednesday,outstanding_count,status,attempted_at)
        SELECT ?,?,?, 'claimed',? WHERE EXISTS (SELECT 1 FROM app_users u
          JOIN participant_google_auth a ON a.user_id=u.id WHERE u.id=? AND u.is_active=1 AND a.enabled=1)
        ON CONFLICT(user_id,local_wednesday) DO NOTHING RETURNING user_id`)
        .bind(user.id, day, count, stamp, user.id).first();
      if (!claim) continue;
      // Recheck approval immediately before I/O; do not use an earlier email
      // snapshot or fall back to a consumed initial preapproval after recovery.
      const approved = await db.prepare(`SELECT a.approved_email FROM app_users u
        JOIN participant_google_auth a ON a.user_id=u.id WHERE u.id=? AND u.is_active=1 AND a.enabled=1`)
        .bind(user.id).first();
      let status = "blocked";
      if (validRecipient(approved?.approved_email)) {
        try {
          await env.RANKING_EMAIL.send({ from: REMINDER_SENDER, to: approved.approved_email,
            subject: REMINDER_SUBJECT, text: reminderText(count) });
          status = "accepted"; // API acceptance is not proof of inbox delivery.
        } catch { status = "failed"; }
      }
      await db.prepare(`UPDATE ranking_reminder_deliveries SET status=?,completed_at=?
        WHERE user_id=? AND local_wednesday=? AND status='claimed'`)
        .bind(status, new Date().toISOString(), user.id, day).run();
    } catch {
      // Process the rest before reporting a fixed, non-sensitive infrastructure
      // error. Existing claims remain terminal, including uncertain outcomes.
      failures++;
    }
  }
  if (failures) throw new Error("Ranking reminder processing incomplete; inspect private delivery audit.");
}
