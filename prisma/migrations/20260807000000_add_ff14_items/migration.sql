CREATE TABLE "ff14_items" (
    "query_name" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ff14_items_pkey" PRIMARY KEY ("query_name")
);

CREATE INDEX "ff14_items_item_id_idx" ON "ff14_items"("item_id");

INSERT INTO "ff14_items" ("query_name", "item_id", "name", "updated_at") VALUES
    ('火之碎晶', 2, '火之碎晶', CURRENT_TIMESTAMP),
    ('冰之碎晶', 3, '冰之碎晶', CURRENT_TIMESTAMP),
    ('风之碎晶', 4, '风之碎晶', CURRENT_TIMESTAMP),
    ('土之碎晶', 5, '土之碎晶', CURRENT_TIMESTAMP),
    ('雷之碎晶', 6, '雷之碎晶', CURRENT_TIMESTAMP),
    ('水之碎晶', 7, '水之碎晶', CURRENT_TIMESTAMP),
    ('火之水晶', 8, '火之水晶', CURRENT_TIMESTAMP),
    ('冰之水晶', 9, '冰之水晶', CURRENT_TIMESTAMP),
    ('风之水晶', 10, '风之水晶', CURRENT_TIMESTAMP),
    ('土之水晶', 11, '土之水晶', CURRENT_TIMESTAMP),
    ('雷之水晶', 12, '雷之水晶', CURRENT_TIMESTAMP),
    ('水之水晶', 13, '水之水晶', CURRENT_TIMESTAMP),
    ('火之晶簇', 14, '火之晶簇', CURRENT_TIMESTAMP),
    ('冰之晶簇', 15, '冰之晶簇', CURRENT_TIMESTAMP),
    ('风之晶簇', 16, '风之晶簇', CURRENT_TIMESTAMP),
    ('土之晶簇', 17, '土之晶簇', CURRENT_TIMESTAMP),
    ('雷之晶簇', 18, '雷之晶簇', CURRENT_TIMESTAMP),
    ('水之晶簇', 19, '水之晶簇', CURRENT_TIMESTAMP);
