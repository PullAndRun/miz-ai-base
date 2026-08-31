ALTER TABLE "vtb_dynamic_status"
  ADD COLUMN IF NOT EXISTS "last_dynamic_key" TEXT;

CREATE TABLE IF NOT EXISTS "vtb_dynamic_deliveries" (
  "streamer_mid" BIGINT NOT NULL,
  "dynamic_key" TEXT NOT NULL,
  "group_id" TEXT NOT NULL,
  "published_at" TIMESTAMPTZ NOT NULL,
  "delivered_at" TIMESTAMPTZ,
  "claimed_until" TIMESTAMPTZ,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMPTZ,
  CONSTRAINT "vtb_dynamic_deliveries_pkey" PRIMARY KEY ("streamer_mid", "dynamic_key", "group_id"),
  CONSTRAINT "vtb_dynamic_deliveries_streamer_mid_fkey"
    FOREIGN KEY ("streamer_mid") REFERENCES "vtb_streamers"("mid") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "vtb_dynamic_deliveries_streamer_mid_published_at_idx"
  ON "vtb_dynamic_deliveries"("streamer_mid", "published_at");
CREATE INDEX IF NOT EXISTS "vtb_dynamic_deliveries_claimed_until_idx"
  ON "vtb_dynamic_deliveries"("claimed_until");
