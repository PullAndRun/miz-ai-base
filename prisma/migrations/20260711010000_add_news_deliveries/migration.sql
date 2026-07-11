CREATE TABLE IF NOT EXISTS "news_deliveries" (
  "target_key" TEXT NOT NULL,
  "news_id" TEXT NOT NULL,
  "delivered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("target_key", "news_id")
);

CREATE INDEX IF NOT EXISTS "news_deliveries_target_key_delivered_at_idx"
  ON "news_deliveries" ("target_key", "delivered_at");
