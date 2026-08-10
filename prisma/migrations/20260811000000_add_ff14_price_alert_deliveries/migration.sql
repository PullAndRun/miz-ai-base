CREATE TABLE "ff14_price_alert_deliveries" (
    "group_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "listing_key" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ff14_price_alert_deliveries_pkey"
        PRIMARY KEY ("group_id", "region", "item_id", "listing_key")
);

CREATE INDEX "ff14_price_alert_deliveries_last_seen_at_idx"
    ON "ff14_price_alert_deliveries"("last_seen_at");
