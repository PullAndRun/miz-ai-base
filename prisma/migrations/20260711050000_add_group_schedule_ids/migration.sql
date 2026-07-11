ALTER TABLE "schedule_events"
  ADD COLUMN IF NOT EXISTS "display_id" INTEGER;

WITH ranked_events AS (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "group_id"
    ORDER BY "created_at" ASC, "id" ASC
  )::INTEGER AS "display_id"
  FROM "schedule_events"
)
UPDATE "schedule_events" AS events
SET "display_id" = ranked_events."display_id"
FROM ranked_events
WHERE events."id" = ranked_events."id"
  AND events."display_id" IS NULL;

ALTER TABLE "schedule_events"
  ALTER COLUMN "display_id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "schedule_events_group_id_display_id_key"
  ON "schedule_events" ("group_id", "display_id");
