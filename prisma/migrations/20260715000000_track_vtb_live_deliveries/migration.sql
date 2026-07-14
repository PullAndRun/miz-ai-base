ALTER TABLE "vtb_live_sessions"
  ADD COLUMN IF NOT EXISTS "delivered_group_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
