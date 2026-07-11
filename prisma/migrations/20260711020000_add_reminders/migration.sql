CREATE TABLE IF NOT EXISTS "reminders" (
  "id" SERIAL PRIMARY KEY,
  "group_id" TEXT NOT NULL,
  "creator_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "remind_at" TIMESTAMPTZ NOT NULL,
  "sent_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "reminders_sent_at_remind_at_idx"
  ON "reminders" ("sent_at", "remind_at");
