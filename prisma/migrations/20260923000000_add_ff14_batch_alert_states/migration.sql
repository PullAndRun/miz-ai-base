CREATE TABLE "ff14_batch_alert_states" (
    "group_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "notified_price" INTEGER NOT NULL,
    "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ff14_batch_alert_states_pkey" PRIMARY KEY ("group_id", "region", "item_id")
);