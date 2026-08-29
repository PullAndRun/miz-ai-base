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

const RAW_UNITS_PER_BATTERY = 100;
const BATTERIES_PER_RMB = 10;
const RAW_UNITS_PER_RMB = RAW_UNITS_PER_BATTERY * BATTERIES_PER_RMB;

/** Bilibili contribution amounts use 1/100-battery units; 10 batteries equal 1 RMB. */
export const getVtbContributionAmount = (events: readonly VtbContributionDisplayEvent[]) =>
  events.reduce((sum, event) => sum + Math.max(0, event.amount), 0);

export const meetsVtbContributionThreshold = (
  events: readonly VtbContributionDisplayEvent[],
  thresholdRmb: number,
) => getVtbContributionAmount(events) >= Math.max(0, thresholdRmb) * RAW_UNITS_PER_RMB;

export const formatVtbBattery = (amount: number) =>
  `${(amount / RAW_UNITS_PER_BATTERY).toFixed(2).replace(/\.?0+$/, "")} 电池`;

const formatBattery = (amount: number) => formatVtbBattery(amount);

export const formatVtbContributionMessage = (event: VtbContributionDisplayEvent, context: VtbContributionMessageContext = {}) => {
  const itemName = event.itemName || (event.kind === "super-chat" ? "醒目留言" : "礼物");
  const room = context.streamerName ? `【${context.streamerName}】直播间` : "";
  const link = context.liveRoomUrl ? `\n🔗 ${context.liveRoomUrl}` : "";
  return `🎁 ${room}礼物来啦！\n${event.userName} 送来：${itemName} ×${event.count}\n这波投喂折合：${formatBattery(event.amount)}\n哇！老板大气，主播我收到啦～能量条继续充能中！${link}`;
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
    return `· ${entry.userName}：${items.join(" + ")}`;
  });
  if (entries.length > 30) lines.push(`· 还有 ${entries.length - 30} 位观众的礼物，已合并统计`);
  const room = context.streamerName ? `【${context.streamerName}】直播间` : "直播间";
  const link = context.liveRoomUrl ? `\n🔗 ${context.liveRoomUrl}` : "";
  return [
    `🎁 ${room}礼物雨来啦！`,
    "老板们的爱，主播都收到啦！",
    ...lines,
    `这一波共收到：${formatBattery(totalAmount)}`,
    `老板大气！有你们在，直播间就不会冷场～${link}`,
  ].join("\n");
};
