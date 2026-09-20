-- PostgreSQL JSON booleans from the initial import were represented as text by SQLite.
-- Preserve the imported hashes and identifiers; normalise only boolean lifecycle fields.
UPDATE app_users
SET is_active = CASE lower(trim(CAST(is_active AS TEXT)))
  WHEN 'true' THEN 1 WHEN '1' THEN 1 ELSE 0 END,
    is_admin = CASE lower(trim(CAST(is_admin AS TEXT)))
  WHEN 'true' THEN 1 WHEN '1' THEN 1 ELSE 0 END;
