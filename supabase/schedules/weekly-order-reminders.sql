-- Apply only after Supabase is linked, migrations are deployed, the
-- weekly-order-reminders Edge Function is deployed, and secrets are configured.
-- Replace placeholders before use. The cron is 02:00 UTC each Wednesday,
-- which is 12:00 AEST.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'fff-weekly-order-reminders',
  '0 2 * * 3',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/weekly-order-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ORDER_REMINDER_SECRET_FROM_SECURE_OPERATOR_CONTEXT'
    ),
    body := jsonb_build_object(),
    timeout_milliseconds := 15000
  );
  $$
);
