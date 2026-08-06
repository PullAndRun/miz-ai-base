CREATE TABLE "ff14_price_alert_suppressions" (
    "group_id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "disabled_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ff14_price_alert_suppressions_pkey" PRIMARY KEY ("group_id", "item_name")
);
