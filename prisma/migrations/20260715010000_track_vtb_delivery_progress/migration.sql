ALTER TABLE "vtb_live_sessions"
  ADD COLUMN IF NOT EXISTS "end_delivered_group_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "vtb_dynamic_status"
  ADD COLUMN IF NOT EXISTS "delivered_group_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Rows created before this migration have already completed their legacy
-- one-shot delivery. Mark them complete so deployment does not replay old
-- offline or dynamic notifications.
UPDATE "vtb_live_sessions"
SET "end_delivered_group_ids" = ARRAY['*']::TEXT[]
WHERE "ended_at" IS NOT NULL;

UPDATE "vtb_dynamic_status"
SET "delivered_group_ids" = ARRAY['*']::TEXT[];
