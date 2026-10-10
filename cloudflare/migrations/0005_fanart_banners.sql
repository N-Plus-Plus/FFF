-- Additive artwork-only state; existing shows, nominations and rankings are preserved.
ALTER TABLE shows ADD COLUMN card_art_manual INTEGER NOT NULL DEFAULT 0 CHECK(card_art_manual IN (0,1));
ALTER TABLE shows ADD COLUMN fanart_banner_id TEXT;
CREATE TABLE fanart_cache (
  tvdb_id TEXT PRIMARY KEY, banners TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL, failure INTEGER NOT NULL DEFAULT 0
);
