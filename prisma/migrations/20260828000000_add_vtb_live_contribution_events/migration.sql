CREATE TABLE "vtb_live_contribution_events" (
    "event_id" TEXT NOT NULL,
    "streamer_mid" BIGINT NOT NULL,
    "session_start" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 1,
    "item_name" TEXT,
    "role_name" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vtb_live_contribution_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "vtb_live_contribution_events_streamer_mid_session_start_idx"
ON "vtb_live_contribution_events"("streamer_mid", "session_start");

ALTER TABLE "vtb_live_contribution_events"
ADD CONSTRAINT "vtb_live_contribution_events_streamer_mid_fkey"
FOREIGN KEY ("streamer_mid") REFERENCES "vtb_live_sessions"("streamer_mid") ON DELETE CASCADE ON UPDATE CASCADE;
