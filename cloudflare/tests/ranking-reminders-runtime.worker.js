import { reminderWednesday, reminderText } from "../src/ranking-reminders.js";

export default {
  async fetch(_request, env) {
    // Local-only email simulator, reserved fictional addresses. No remote I/O.
    await env.EMAIL.send({ from: "sender@example.test", to: "recipient@example.test",
      subject: "Synthetic reminder", text: reminderText(2) });
    let rejectedSender = false;
    try {
      await env.EMAIL.send({ from: "other@example.test", to: "recipient@example.test",
        subject: "Synthetic forbidden sender", text: "Fixture" });
    } catch { rejectedSender = true; }
    return Response.json({ rejectedSender, dates: ["2026-04-01T01:00:00Z", "2026-04-08T02:00:00Z",
      "2026-09-30T02:00:00Z", "2026-10-07T01:00:00Z", "2026-10-07T02:00:00Z"].map(t => reminderWednesday(Date.parse(t))) });
  }
};
