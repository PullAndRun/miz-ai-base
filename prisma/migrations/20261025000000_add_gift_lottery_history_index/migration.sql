-- 最近抽奖查询按用户和时间倒序读取记录。
CREATE INDEX "gift_lottery_daily_draws_user_id_drawn_at_idx"
  ON "gift_lottery_daily_draws"("user_id", "drawn_at");