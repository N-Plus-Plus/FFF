-- Private at-most-once send claims. No addresses, subjects or message bodies.
-- Preserve these keys indefinitely: deleting one can allow a replay to resend.
CREATE TABLE ranking_reminder_deliveries (
  user_id TEXT NOT NULL REFERENCES app_users(id),
  local_wednesday TEXT NOT NULL CHECK(length(local_wednesday)=10),
  outstanding_count INTEGER NOT NULL CHECK(outstanding_count > 0),
  status TEXT NOT NULL CHECK(status IN ('claimed','accepted','failed','blocked')),
  attempted_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(user_id,local_wednesday)
);
