CREATE TABLE IF NOT EXISTS "gift_lottery_daily_draws" (
  "user_id" TEXT NOT NULL,
  "draw_date" TEXT NOT NULL,
  "gift_id" INTEGER NOT NULL,
  "gift_name" TEXT NOT NULL,
  "drawn_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_lottery_daily_draws_pkey" PRIMARY KEY ("user_id", "draw_date")
);

CREATE INDEX IF NOT EXISTS "gift_lottery_daily_draws_draw_date_idx"
  ON "gift_lottery_daily_draws"("draw_date");