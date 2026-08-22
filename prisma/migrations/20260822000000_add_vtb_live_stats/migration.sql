ALTER TABLE "vtb_live_sessions"
  ADD COLUMN IF NOT EXISTS "start_fan_club" INTEGER,
  ADD COLUMN IF NOT EXISTS "start_guards" INTEGER,
  ADD COLUMN IF NOT EXISTS "end_fan_club" INTEGER,
  ADD COLUMN IF NOT EXISTS "end_guards" INTEGER;
