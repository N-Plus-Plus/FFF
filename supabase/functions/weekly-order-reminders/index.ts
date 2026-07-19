import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type ReminderCandidate = {
  user_id: string;
  display_name: string;
  unranked_show_count: number;
};

type ReminderRecipient = {
  name: string;
  email: string;
  link: string;
};

Deno.serve((request) => handleRequest(request).catch((error) => {
  const message = error instanceof ReminderConfigurationError
    ? error.message
    : "Unexpected reminder failure.";
  const code = error instanceof ReminderConfigurationError
    ? error.code
    : "unexpected_failure";
  return json({ error: code, message }, 500);
}));

async function handleRequest(request: Request) {
  if (request.method !== "POST") {
    return json({ error: "invalid_method", message: "Use POST." }, 405);
  }

  if (!isTrustedServiceCall(request)) {
    return json({ error: "forbidden", message: "Service-role authorization is required." }, 403);
  }

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  const recipients = configuredRecipients();
  const recipientsByName = new Map(recipients.map((recipient) => [normalizeName(recipient.name), recipient]));
  const supabase = serviceClient();

  const { data, error } = await supabase.rpc("admin_list_order_reminder_recipients");
  if (error) {
    return json({ error: "recipient_query_failed", message: "Reminder recipients could not be loaded." }, 500);
  }

  const candidates = ((data || []) as ReminderCandidate[])
    .map((candidate) => ({
      candidate,
      recipient: recipientsByName.get(normalizeName(candidate.display_name))
    }))
    .filter((entry) => entry.candidate.unranked_show_count > 0);

  const missingConfigCount = candidates.filter((entry) => !entry.recipient).length;
  const sendable = candidates.filter((entry): entry is { candidate: ReminderCandidate; recipient: ReminderRecipient } => Boolean(entry.recipient));

  if (dryRun) {
    return json({
      ok: true,
      dry_run: true,
      would_send: sendable.length,
      skipped_missing_recipient_config: missingConfigCount
    }, 200);
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
  const from = Deno.env.get("ORDER_REMINDER_FROM") || "";
  if (sendable.length > 0 && (!resendApiKey || !from)) {
    return json({ error: "email_configuration_missing", message: "RESEND_API_KEY and ORDER_REMINDER_FROM are required." }, 500);
  }

  let sent = 0;
  let failed = 0;
  for (const entry of sendable) {
    try {
      await sendReminderEmail({
        apiKey: resendApiKey,
        from,
        recipient: entry.recipient
      });
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  console.log("weekly-order-reminders summary", {
    candidates: candidates.length,
    sent,
    failed,
    skipped_missing_recipient_config: missingConfigCount
  });

  return json({
    ok: failed === 0,
    sent,
    failed,
    skipped_missing_recipient_config: missingConfigCount
  }, failed === 0 ? 200 : 502);
}

function configuredRecipients() {
  const raw = recipientJsonSecret();
  const parsed = parseRecipientJson(raw);
  if (!Array.isArray(parsed)) {
    throw new ReminderConfigurationError("recipient_configuration_invalid", "ORDER_REMINDER_RECIPIENTS_JSON must be a JSON array.");
  }
  return parsed
    .map((item) => isRecord(item) ? {
      name: stringValue(item.name),
      email: stringValue(item.email),
      link: stringValue(item.link)
    } : null)
    .filter((item): item is ReminderRecipient => Boolean(item?.name && item.email && item.link));
}

function recipientJsonSecret() {
  const encoded = Deno.env.get("ORDER_REMINDER_RECIPIENTS_B64") || "";
  if (encoded) {
    try {
      return atob(encoded);
    } catch {
      throw new ReminderConfigurationError("recipient_configuration_invalid", "ORDER_REMINDER_RECIPIENTS_B64 must be valid base64.");
    }
  }
  return Deno.env.get("ORDER_REMINDER_RECIPIENTS_JSON") || "[]";
}

function parseRecipientJson(raw: string): unknown {
  const attempts = [
    raw,
    raw.replace(/\\"/g, '"')
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed.replace(/\\"/g, '"'));
        } catch {
          continue;
        }
      }
      return parsed;
    } catch {
      continue;
    }
  }

  throw new ReminderConfigurationError("recipient_configuration_invalid", "ORDER_REMINDER_RECIPIENTS_JSON must be valid JSON.");
}

async function sendReminderEmail(options: { apiKey: string; from: string; recipient: ReminderRecipient }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${options.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: options.from,
      to: [options.recipient.email],
      subject: "FFF ordering reminder",
      text: reminderText(options.recipient)
    })
  });

  if (!response.ok) {
    throw new Error("email_send_failed");
  }
}

function reminderText(recipient: ReminderRecipient) {
  return `Hey there ${recipient.name}

It's that time of the week... and there are shows you have not yet put into a preference order.

To order shows, or add your own nominations, give this a red hot click: ${recipient.link}

Let me know if these notifications are more annoying than useful and I'll make them stop ... but until then ... Happy ordering <3

Troybot`;
}

function isTrustedServiceCall(request: Request) {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const scheduleSecret = Deno.env.get("ORDER_REMINDER_SECRET") || "";
  const header = request.headers.get("authorization") || "";
  return (Boolean(serviceKey) && header === `Bearer ${serviceKey}`)
    || (Boolean(scheduleSecret) && header === `Bearer ${scheduleSecret}`);
}

function serviceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    throw new ReminderConfigurationError("supabase_configuration_missing", "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
  return createClient(supabaseUrl, serviceKey, {
    global: { headers: { "x-application-name": "fff-weekly-order-reminders" } }
  });
}

class ReminderConfigurationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
