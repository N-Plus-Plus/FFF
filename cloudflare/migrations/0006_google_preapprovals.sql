-- Operator-only initial email approvals. First verified sign-in claims each once.
-- No existing participant, mapping, nomination or ranking is altered.
CREATE TABLE participant_google_preapprovals (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES app_users(id),
  approved_email TEXT NOT NULL UNIQUE CHECK(
    approved_email = lower(trim(approved_email)) AND
    length(approved_email) BETWEEN 3 AND 254 AND
    instr(approved_email,'@') > 1
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  approved_at TEXT NOT NULL,
  approval_note TEXT NOT NULL CHECK(length(trim(approval_note)) > 0),
  claimed_at TEXT
);
CREATE TRIGGER google_preapproval_insert_guard BEFORE INSERT ON participant_google_preapprovals
WHEN NEW.claimed_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM participant_google_auth
  WHERE user_id=NEW.user_id OR approved_email=NEW.approved_email
) BEGIN
  SELECT RAISE(ABORT,'Preapproval cannot replace an established mapping.');
END;
-- Consumption is atomic with ANY first mapping insertion, including an
-- operator-reviewed third-party account; deleting a mapping cannot re-open it.
CREATE TRIGGER google_preapproval_claim AFTER INSERT ON participant_google_auth BEGIN
  UPDATE participant_google_preapprovals
  SET claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=NEW.user_id AND claimed_at IS NULL;
END;
CREATE TRIGGER google_preapproval_update_guard BEFORE UPDATE ON participant_google_preapprovals
WHEN (OLD.claimed_at IS NOT NULL AND (
  NEW.claimed_at IS NOT OLD.claimed_at OR NEW.user_id IS NOT OLD.user_id OR
  NEW.approved_email IS NOT OLD.approved_email
)) OR ((NEW.user_id IS NOT OLD.user_id OR NEW.approved_email IS NOT OLD.approved_email) AND EXISTS (
  SELECT 1 FROM participant_google_auth
  WHERE user_id=NEW.user_id OR approved_email=NEW.approved_email
)) BEGIN
  SELECT RAISE(ABORT,'Preapproval cannot reassign an established identity.');
END;
