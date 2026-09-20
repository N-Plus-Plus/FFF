-- Canonical Cloudflare schema. Import rows retain Supabase UUIDs and SHA-256 link hashes.
CREATE TABLE app_users (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, link_token_hash TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
  token_issued_at TEXT NOT NULL, token_revoked_at TEXT, created_at TEXT NOT NULL,
  created_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE shows (
  id TEXT PRIMARY KEY, imdb_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  release_year INTEGER, end_year INTEGER, title_type TEXT, provider_title_type TEXT,
  series_status TEXT, total_season_count INTEGER, total_episode_count INTEGER,
  total_runtime_minutes INTEGER, metadata_provider TEXT, provider_record_id TEXT,
  tvdb_record_id TEXT, metadata_retrieved_at TEXT, metadata_refresh_attempted_at TEXT,
  metadata_refresh_succeeded_at TEXT, metadata_refresh_status TEXT,
  metadata_refresh_failure_category TEXT, poster_url TEXT, poster_source_url TEXT,
  poster_storage_path TEXT, poster_retrieval_status TEXT, poster_updated_at TEXT,
  card_art_storage_path TEXT, card_art_source_url TEXT, card_art_type TEXT,
  card_art_width INTEGER, card_art_height INTEGER, card_art_retrieval_status TEXT,
  card_art_updated_at TEXT, background_url TEXT, disambiguation TEXT, metadata TEXT NOT NULL DEFAULT '{}',
  first_enrolled_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  admin_removed_at TEXT, admin_removed_by TEXT, restored_at TEXT, restored_by TEXT
);
CREATE TABLE show_nominations (
  user_id TEXT NOT NULL, show_id TEXT NOT NULL, nominated_at TEXT NOT NULL,
  last_activated_at TEXT NOT NULL, withdrawn_at TEXT, PRIMARY KEY(user_id, show_id),
  FOREIGN KEY(user_id) REFERENCES app_users(id), FOREIGN KEY(show_id) REFERENCES shows(id)
);
CREATE TABLE user_show_rankings (
  user_id TEXT NOT NULL, show_id TEXT NOT NULL, rank_position INTEGER,
  updated_at TEXT NOT NULL, PRIMARY KEY(user_id, show_id),
  FOREIGN KEY(user_id) REFERENCES app_users(id), FOREIGN KEY(show_id) REFERENCES shows(id)
);
CREATE UNIQUE INDEX rankings_position ON user_show_rankings(user_id, rank_position) WHERE rank_position IS NOT NULL;
CREATE TABLE app_revisions (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), board_revision INTEGER NOT NULL, board_updated_at TEXT NOT NULL);
INSERT INTO app_revisions VALUES (1, 1, datetime('now'));
CREATE INDEX shows_refresh_due ON shows(metadata_refresh_succeeded_at, admin_removed_at);
CREATE INDEX nominations_active ON show_nominations(show_id, withdrawn_at);
