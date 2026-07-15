-- Apply only after Supabase is linked, migrations are deployed, Edge Functions
-- are deployed, and secrets are configured. Replace placeholders before use.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'fff-weekly-metadata-refresh',
  '17 3 * * 1',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.functions.supabase.co/metadata-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer METADATA_REFRESH_SECRET_FROM_SECURE_OPERATOR_CONTEXT'
    ),
    body := jsonb_build_object('limit', 10),
    timeout_milliseconds := 15000
  );
  $$
);
