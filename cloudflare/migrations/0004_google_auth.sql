-- Additive, forward-only authentication cutover. Existing participant IDs,
-- nominations, rankings, and inert historical link columns remain untouched.
CREATE TABLE participant_google_auth (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES app_users(id),
  google_sub TEXT NOT NULL UNIQUE CHECK(length(google_sub) BETWEEN 1 AND 255),
  approved_email TEXT NOT NULL UNIQUE CHECK(approved_email = lower(trim(approved_email))),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  approved_at TEXT NOT NULL,
  approval_note TEXT NOT NULL
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
  user_id TEXT NOT NULL REFERENCES participant_google_auth(user_id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_flows (
  state_hash TEXT PRIMARY KEY NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- Verified identities can request approval, but never create participants.
CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY NOT NULL,
  google_sub TEXT NOT NULL UNIQUE,
  verified_email TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE TRIGGER google_mapping_update AFTER UPDATE ON participant_google_auth BEGIN
  DELETE FROM auth_sessions WHERE user_id=OLD.user_id;
  UPDATE app_revisions SET board_revision=board_revision+1,board_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
END;
CREATE TRIGGER google_mapping_insert AFTER INSERT ON participant_google_auth BEGIN
  UPDATE app_revisions SET board_revision=board_revision+1,board_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
END;
CREATE TRIGGER google_mapping_delete AFTER DELETE ON participant_google_auth BEGIN
  DELETE FROM auth_sessions WHERE user_id=OLD.user_id;
  UPDATE app_revisions SET board_revision=board_revision+1,board_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
END;
