ALTER TABLE "vtb_live_sessions"
  DROP COLUMN IF EXISTS "streamer_name",
  DROP COLUMN IF EXISTS "start_guard_ids",
  DROP COLUMN IF EXISTS "start_guard_names",
  DROP COLUMN IF EXISTS "start_guard_snapshot_captured",
  DROP COLUMN IF EXISTS "end_guard_ids",
  DROP COLUMN IF EXISTS "end_guard_names";
