/* Converts a private Supabase data-only JSON export to bound D1 inserts. Never include raw links. */
import { readFile } from "node:fs/promises";

const [input] = process.argv.slice(2);
if (!input) throw new Error("Usage: node cloudflare/scripts/import-d1.mjs <private-export.json>");
const envelope = JSON.parse((await readFile(input, "utf8")).replace(/^\uFEFF/, ""));
const source = envelope.snapshot || envelope.rows?.[0]?.snapshot || envelope;
const tables = ["app_users", "shows", "show_nominations", "user_show_rankings", "app_revisions"];
const columns = {
  app_users: ["id", "display_name", "link_token_hash", "is_admin", "is_active", "token_issued_at", "token_revoked_at", "created_at", "created_by", "updated_at"],
  shows: ["id", "imdb_id", "title", "release_year", "end_year", "title_type", "provider_title_type", "series_status", "total_season_count", "total_episode_count", "total_runtime_minutes", "tvmaze_rating", "metadata_provider", "provider_record_id", "tvdb_record_id", "tvdb_metadata_retrieved_at", "metadata_retrieved_at", "metadata_refresh_attempted_at", "metadata_refresh_succeeded_at", "metadata_refresh_status", "metadata_refresh_failure_category", "poster_url", "poster_source_url", "poster_storage_path", "poster_retrieval_status", "poster_refresh_status", "poster_updated_at", "card_art_storage_path", "card_art_source_url", "card_art_type", "card_art_width", "card_art_height", "card_art_retrieval_status", "card_art_updated_at", "background_url", "disambiguation", "metadata", "metadata_source_provenance", "first_enrolled_by", "created_at", "updated_at", "admin_removed_at", "admin_removed_by", "restored_at", "restored_by"],
  show_nominations: ["user_id", "show_id", "nominated_at", "last_activated_at", "withdrawn_at"],
  user_show_rankings: ["user_id", "show_id", "rank_position", "updated_at"],
  app_revisions: ["singleton", "board_revision", "board_updated_at"]
};
const quote = (value) => value == null ? "NULL" : typeof value === "boolean" ? (value ? "1" : "0") : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
let sql = "PRAGMA foreign_keys = ON;\n";
for (const table of tables) {
  for (const row of source[table] || []) {
    if (table === "app_users" && (!/^[a-f0-9]{64}$/i.test(row.link_token_hash || "") || row.link_token || row.token)) throw new Error("Export must contain SHA-256 hashes only, never raw link tokens.");
    const fields = columns[table];
    const values = fields.map((key) => key === "singleton" ? (row[key] ? 1 : 0) : row[key]);
    const verb = table === "app_revisions" ? "INSERT OR REPLACE" : "INSERT";
    sql += `${verb} INTO ${table} (${fields.join(",")}) VALUES (${values.map((value) => quote(typeof value === "object" && value !== null ? JSON.stringify(value) : value)).join(",")});\n`;
  }
}
process.stdout.write(sql);
