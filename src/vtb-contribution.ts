export type VtbContributionDisplayEvent = {
  userName: string;
  kind: "gift" | "super-chat";
  amount: number;
  count: number;
  itemName?: string;
};

const formatBattery = (amount: number) => `${(amount / 1_000).toFixed(2)} 电池`;

export const formatVtbContributionMessage = (event: VtbContributionDisplayEvent) => {
  const itemName = event.itemName || (event.kind === "super-chat" ? "醒目留言" : "礼物");
  return `🎁 ${event.userName} 送来支持，感谢投喂！\n${itemName} ×${event.count} · 价值 ${formatBattery(event.amount)}`;
};

export const formatVtbContributionBatchMessage = (events: readonly VtbContributionDisplayEvent[]) => {
  const users = new Map<string, { userName: string; items: Map<string, { count: number; amount: number }>; amount: number }>();
  for (const event of events) {
    const userName = event.userName || "观众";
    const itemName = event.itemName || (event.kind === "super-chat" ? "醒目留言" : "礼物");
    const user = users.get(userName) ?? { userName, items: new Map(), amount: 0 };
    const item = user.items.get(itemName) ?? { count: 0, amount: 0 };
    item.count += Math.max(1, event.count);
    item.amount += Math.max(0, event.amount);
    user.items.set(itemName, item);
    user.amount += Math.max(0, event.amount);
    users.set(userName, user);
  }
  const entries = [...users.values()].sort((a, b) => b.amount - a.amount || a.userName.localeCompare(b.userName));
  const totalAmount = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const lines = entries.slice(0, 30).map((entry) => {
    const items = [...entry.items.entries()].map(([itemName, item]) =>
      `${itemName} ×${item.count}（${formatBattery(item.amount)}）`);
    return `- ${entry.userName}：${items.join("、")}`;
  });
  if (entries.length > 30) lines.push(`- 还有 ${entries.length - 30} 位观众的打赏，已合并统计`);
  return [
    "🎁 这一波打赏感谢名单：",
    ...lines,
    `本轮共收到 ${formatBattery(totalAmount)}，感谢大家的投喂！`,
  ].join("\n");
};
