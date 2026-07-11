import type { MizPlugin } from "@/plugins";
import {
  formatDynamicMessage,
  formatLiveQueryMessage,
  getVtbRepository,
  getVtbDynamics,
  getVtbFanCount,
  getVtbLiveInfo,
  resolveTrackedVtbStreamer,
  syncVtbSubscriptionNames,
} from "@/vtb";
import {
  addVtbSubscription,
  loadConfig,
  removeVtbSubscription,
  updateVtbSubscriptionNames,
} from "@/config";
import { changeVtbSubscriptions, findVtbSubscription } from "@/vtb-subscriptions";

const vtbPlugin: MizPlugin = {
  name: "vtb",
  commands: ["vtb"],
  description: [
    "查询 B 站主播直播与动态，也可管理本群订阅。",
    "查询直播：miz vtb live 主播名",
    "查询动态：miz vtb dynamic 主播名",
    "查看订阅：miz vtb list",
    "添加订阅：miz vtb subscribe 主播名",
    "取消订阅：miz vtb unsubscribe 主播名",
    "同步昵称与直播间：miz vtb sync",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    const [type, ...nameParts] = command.args.trim().split(/\s+/);
    const streamerName = nameParts.join(" ").trim();
    if (
      (type !== "live" && type !== "dynamic" && type !== "sync" && type !== "list" && type !== "subscribe" && type !== "unsubscribe") ||
      ((type === "live" || type === "dynamic" || type === "subscribe" || type === "unsubscribe") && !streamerName)
    ) {
      await reply([
        "查询直播：miz vtb live 主播名",
        "查询动态：miz vtb dynamic 主播名",
        "查看本群订阅：miz vtb list",
        "订阅或取消：miz vtb subscribe 主播名 / miz vtb unsubscribe 主播名",
        "同步主播昵称：miz vtb sync",
      ].join("\n"));
      return;
    }

    if (!config.vtb.enabled) {
      await reply("VTB 功能目前没有开启，请联系机器人管理员。");
      return;
    }

    try {
      if (type === "list" || type === "subscribe" || type === "unsubscribe") {
        if (message.groupId === undefined) {
          await reply("订阅管理只能在群聊中使用，因为订阅会绑定到当前群。\n你仍可以在这里查询主播直播和动态。");
          return;
        }
        if (!isGroupAdministrator(message.raw) && !isSubscriptionWhitelisted(
          message.userId,
          config.vtb.subscriptionWhitelistUserIds,
        )) {
          await reply("管理本群订阅需要群主、群管理员或 VTB 订阅白名单权限。");
          return;
        }

        if (type === "list") {
          const subscription = findVtbSubscription(config.vtb.subscriptions, message.groupId);
          await reply(
            subscription?.streamers.length
              ? `本群已订阅 ${subscription.streamers.length} 位主播：\n${subscription.streamers.join("\n")}`
              : "本群还没有 VTB 订阅。可使用 miz vtb subscribe 主播名 添加。",
          );
          return;
        }

        const result = type === "subscribe"
          ? await addVtbSubscription(message.groupId, streamerName)
          : await removeVtbSubscription(message.groupId, streamerName);
        if (!result.changed) {
          await reply(type === "subscribe" ? "这位主播已经在本群订阅列表中了。" : "本群没有订阅这位主播，无需重复取消。");
          return;
        }

        const nextSubscriptions = changeVtbSubscriptions(
          config.vtb.subscriptions,
          message.groupId,
          streamerName,
          type,
        );
        let databaseSynchronized = true;
        if (type === "subscribe") {
          try {
            const repository = await getVtbRepository(config);
            const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
            if (streamer) {
              databaseSynchronized = true;
            } else {
              databaseSynchronized = false;
            }
          } catch (error) {
            databaseSynchronized = false;
            logger.warn("plugin", "vtb subscription saved but database synchronization failed", {
              groupId: message.groupId,
              streamerName,
              error: error instanceof Error ? { name: error.name, message: error.message } : error,
            });
          }
          if (!databaseSynchronized) {
            logger.warn("plugin", "vtb subscription saved but streamer was not found for database synchronization", {
              groupId: message.groupId,
              streamerName,
            });
          }
        } else if (!nextSubscriptions.some((subscription) => subscription.streamers.includes(streamerName))) {
          const repository = await getVtbRepository(config);
          const removed = await repository.deleteStreamerByName(streamerName);
          if (removed) {
            logger.info("plugin", "vtb streamer removed from database after final subscription was cancelled", {
              streamerName,
            });
          }
        }
        logger.info("plugin", "vtb group subscription updated", {
          action: type,
          groupId: message.groupId,
          streamerName,
        });
        await reply(type === "subscribe"
          ? databaseSynchronized
            ? `已订阅：${streamerName}\n之后开播和新动态会推送到本群。`
            : `已订阅：${streamerName}\n订阅已保存；主播资料暂时无法同步，机器人会在后续轮询时自动重试。`
          : `已取消订阅：${streamerName}`);
        return;
      }

      if (type === "sync") {
        if (!isSyncWhitelisted(message.userId, config.vtb.syncWhitelistUserIds)) {
          await reply("同步主播昵称仅限 VTB 同步白名单中的 QQ 号使用。");
          return;
        }

        const fullConfig = await loadConfig();
        const { databaseSync, renamed, roomUpdated, failed } = await syncVtbSubscriptionNames(fullConfig);
        if (renamed.length > 0) {
          await updateVtbSubscriptionNames(new Map(renamed.map((item) => [item.previousName, item.name])));
          // The config watcher reloads the persisted change. Do not mutate the
          // current runtime snapshot while a command is executing.
        }
        logger.info("plugin", "vtb subscription names checked by command", {
          renamed,
          roomUpdated,
          databaseSync,
          failed,
        });
        await reply(
          [
            `数据库同步：新增 ${databaseSync.added.length} 位，移除 ${databaseSync.removed.length} 位，跳过 ${databaseSync.skipped.length} 位。`,
            renamed.length > 0
              ? [
                  `已根据 MID 更新 ${renamed.length} 位主播的昵称：`,
                  ...renamed.map((item) => `- ${item.previousName} → ${item.name}（MID：${item.mid}）`),
                ].join("\n")
              : "昵称检查完成，数据库昵称与 B 站名片昵称一致。",
            ...(roomUpdated.length > 0 ? [`已更新 ${roomUpdated.length} 位主播的直播间 ID。`] : []),
            ...(failed.length > 0
              ? [
                  `其中 ${failed.length} 位主播暂时无法检查：`,
                  ...failed.slice(0, 10).map((item) => `- ${item.name}：${item.reason}`),
                  ...(failed.length > 10 ? ["其余失败项请查看机器人日志。"] : []),
                ]
              : []),
          ].join("\n"),
        );
        return;
      }

      const repository = await getVtbRepository(config);
      const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
      if (!streamer) {
        await reply(`没有找到“${streamerName}”。请检查昵称是否正确，或换一个更完整的名称试试。`);
        return;
      }

      if (type === "live") {
        const [live, fans] = await Promise.all([
          getVtbLiveInfo(streamer, config.vtb),
          getVtbFanCount(streamer.mid, config.vtb),
        ]);
        await reply([
          {
            type: "text",
            data: {
              text: [
                formatLiveQueryMessage(live, fans),
              ].join("\n"),
            },
          },
          ...(live.coverUrl
            ? [
                {
                  type: "image",
                  data: { file: live.coverUrl },
                },
              ]
            : []),
        ]);
        return;
      }

      const feed = await getVtbDynamics(streamer, config.vtb);
      const latestDynamic = feed.items[0];
      if (!latestDynamic) {
        await reply("这位主播暂时没有可展示的最新动态。");
        return;
      }
      await reply(formatDynamicMessage(latestDynamic));
    } catch (error) {
      logger.error("plugin", "vtb query failed", error);
      await reply("主播信息暂时无法获取，请稍后再试。");
    }
  },
};

export default vtbPlugin;

const isSyncWhitelisted = (
  userId: string | number | undefined,
  whitelistUserIds: readonly (string | number)[],
) => userId !== undefined && whitelistUserIds.some((id) => String(id) === String(userId));

const isGroupAdministrator = (raw: Record<string, unknown>) => {
  const sender = raw.sender;
  if (!sender || typeof sender !== "object") {
    return false;
  }

  const role = (sender as Record<string, unknown>).role;
  return role === "admin" || role === "owner";
};

const isSubscriptionWhitelisted = (
  userId: string | number | undefined,
  whitelistUserIds: readonly (string | number)[],
) => userId !== undefined && whitelistUserIds.some((id) => String(id) === String(userId));
