CREATE TABLE IF NOT EXISTS "vtb_streamers" (
  "mid" BIGINT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "live_room" BIGINT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "vtb_live_sessions" (
  "streamer_mid" BIGINT PRIMARY KEY,
  "streamer_name" TEXT NOT NULL,
  "live_room" BIGINT,
  "live_started_at" TIMESTAMPTZ NOT NULL,
  "start_fans" INTEGER,
  "ended_at" TIMESTAMPTZ,
  "end_fans" INTEGER
);

ALTER TABLE "vtb_live_sessions" ADD COLUMN IF NOT EXISTS "start_fans" INTEGER;
ALTER TABLE "vtb_live_sessions" ADD COLUMN IF NOT EXISTS "ended_at" TIMESTAMPTZ;
ALTER TABLE "vtb_live_sessions" ADD COLUMN IF NOT EXISTS "end_fans" INTEGER;

CREATE TABLE IF NOT EXISTS "vtb_dynamic_status" (
  "streamer_mid" BIGINT PRIMARY KEY,
  "last_published_at" TIMESTAMPTZ NOT NULL
);
