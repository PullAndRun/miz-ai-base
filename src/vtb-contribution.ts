export type VtbContributionDisplayEvent = {
  userName: string;
  kind: "gift" | "super-chat";
  amount: number;
  count: number;
  itemName?: string;
};

export type VtbContributionMessageContext = {
  streamerName?: string;
  liveRoomUrl?: string;
};

/** Bilibili contribution amounts are stored in milli-batteries; 10 batteries equal 1 RMB. */
export const getVtbContributionAmount = (events: readonly VtbContributionDisplayEvent[]) =>
  events.reduce((sum, event) => sum + Math.max(0, event.amount), 0);

export const meetsVtbContributionThreshold = (
  events: readonly VtbContributionDisplayEvent[],
  thresholdRmb: number,
) => getVtbContributionAmount(events) >= Math.max(0, thresholdRmb) * 10_000;

export const formatVtbBattery = (amount: number) =>
  `${(amount / 1_000).toFixed(2).replace(/\.?0+$/, "")} 电池`;

const formatBattery = (amount: number) => formatVtbBattery(amount);

export const formatVtbContributionMessage = (event: VtbContributionDisplayEvent, context: VtbContributionMessageContext = {}) => {
  const itemName = event.itemName || (event.kind === "super-chat" ? "醒目留言" : "礼物");
  const room = context.streamerName ? `【${context.streamerName}】直播间` : "";
  const link = context.liveRoomUrl ? `\n🔗 ${context.liveRoomUrl}` : "";
  return `🎁 ${room}收到高能投喂！\n${event.userName} 送来 ${itemName} ×${event.count} · 价值 ${formatBattery(event.amount)}\n感谢老板的投喂，直播间直接起飞！${link}`;
};

export const formatVtbContributionBatchMessage = (events: readonly VtbContributionDisplayEvent[], context: VtbContributionMessageContext = {}) => {
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
  const totalAmount = getVtbContributionAmount(events);
  const lines = entries.slice(0, 30).map((entry) => {
    const items = [...entry.items.entries()].map(([itemName, item]) =>
      `${itemName} ×${item.count}（${formatBattery(item.amount)}）`);
    return `- ${entry.userName}：${items.join("、")}`;
  });
  if (entries.length > 30) lines.push(`- 还有 ${entries.length - 30} 位观众的打赏，已合并统计`);
  const room = context.streamerName ? `【${context.streamerName}】直播间` : "直播间";
  const link = context.liveRoomUrl ? `\n🔗 ${context.liveRoomUrl}` : "";
  return [
    `🎁 ${room}高能投喂战报（达标礼物）`,
    ...lines,
    `本轮合计 ${formatBattery(totalAmount)}，感谢各位老板，直播间热度拉满！${link}`,
  ].join("\n");
};
