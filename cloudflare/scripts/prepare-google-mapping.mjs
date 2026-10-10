import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function mappingSql(input) {
  const { action, participantId, expectedName, note } = input;
  for (const value of [participantId, expectedName, note]) if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error("Participant ID, expected display name and approval note are required.");
  const user = `(SELECT id FROM app_users WHERE id=${quote(participantId)} AND display_name=${quote(expectedName)})`;
  if (action === "disable") return `UPDATE participant_google_auth SET enabled=0,approval_note=${quote(note)} WHERE user_id=${user} RETURNING user_id,enabled;\n`;
  if (action !== "approve") throw new Error("Use approve or disable.");
  const { requestId, verifiedEmail, previousSubject = null } = input;
  if (typeof requestId !== "string" || !requestId || typeof verifiedEmail !== "string" || !/^[^\s@]+@[^\s@]+$/.test(verifiedEmail)) throw new Error("A verified approval request ID and email are required.");
  if (previousSubject !== null && (typeof previousSubject !== "string" || !previousSubject || previousSubject.length > 255)) throw new Error("Invalid expected previous Google subject.");
  const email = verifiedEmail.trim().toLowerCase();
  const subject = `(SELECT google_sub FROM auth_requests WHERE id=${quote(requestId)} AND verified_email=${quote(email)} AND requested_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'))`;
  // NULL participant/subject causes a constraint failure. Uniqueness prevents
  // cross-participant aliases. Replacement requires the exact previous subject.
  return `INSERT INTO participant_google_auth(user_id,google_sub,approved_email,enabled,approved_at,approval_note)
VALUES(${user},${subject},${quote(email)},1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),${quote(note)})
ON CONFLICT(user_id) DO UPDATE SET google_sub=excluded.google_sub,approved_email=excluded.approved_email,enabled=1,approved_at=excluded.approved_at,approval_note=excluded.approval_note
WHERE participant_google_auth.google_sub=${previousSubject === null ? "NULL" : quote(previousSubject)}
RETURNING user_id,enabled;\n`;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href) {
  const root = resolve("cloudflare");
  const [inputPath, outputPath] = process.argv.slice(2);
  for (const path of [inputPath, outputPath]) {
    if (!path || !/^private-[^/\\]+\.(json|sql)$/.test(relative(root, resolve(path)))) throw new Error("Use ignored cloudflare/private-*.json and cloudflare/private-*.sql paths.");
  }
  const sql = mappingSql(JSON.parse(await readFile(inputPath, "utf8")));
  await writeFile(outputPath, sql, { flag: "wx", mode: 0o600 });
  console.log("Prepared private mapping SQL for operator review. No database was contacted.");
}
