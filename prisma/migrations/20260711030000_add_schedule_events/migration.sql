CREATE TABLE IF NOT EXISTS "schedule_events" (
  "id" SERIAL PRIMARY KEY,
  "group_id" TEXT NOT NULL,
  "creator_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "event_at" TIMESTAMPTZ NOT NULL,
  "remind_at" TIMESTAMPTZ NOT NULL,
  "reminded_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "schedule_events_reminded_at_remind_at_idx"
  ON "schedule_events" ("reminded_at", "remind_at");

CREATE INDEX IF NOT EXISTS "schedule_events_group_id_event_at_idx"
  ON "schedule_events" ("group_id", "event_at");
