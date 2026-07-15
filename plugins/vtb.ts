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
    "查询 B 站主播的直播和动态，也可以管理本群的主播订阅。",
    "查询直播：miz vtb live 主播昵称",
    "查询动态：miz vtb dynamic 主播昵称",
    "查看订阅：miz vtb list",
    "添加订阅：miz vtb subscribe 主播昵称",
    "取消订阅：miz vtb unsubscribe 主播昵称",
    "同步昵称与直播间：miz vtb sync",
    "订阅管理需要管理员或直播订阅白名单权限，资料同步需要同步白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    const [type, ...nameParts] = command.args.trim().split(/\s+/);
    const streamerName = nameParts.join(" ").trim();
    if (
      (type !== "live" && type !== "dynamic" && type !== "sync" && type !== "list" && type !== "subscribe" && type !== "unsubscribe") ||
      ((type === "live" || type === "dynamic" || type === "subscribe" || type === "unsubscribe") && !streamerName)
    ) {
      await reply([
        "B 站主播功能这样用：",
        "直播状态：miz vtb live 主播昵称",
        "最新动态：miz vtb dynamic 主播昵称",
        "订阅列表：miz vtb list",
        "添加订阅：miz vtb subscribe 主播昵称",
        "取消订阅：miz vtb unsubscribe 主播昵称",
        "同步资料：miz vtb sync",
      ].join("\n"));
      return;
    }

    if (!config.vtb.enabled) {
      await reply("B 站主播功能还没启用，请联系管理员处理。");
      return;
    }

    const missingLiveApi = type === "live" &&
      (!config.vtb.userApiUrl || !config.vtb.cardApiUrl || !config.vtb.liveApiUrl);
    const missingDynamicApi = type === "dynamic" &&
      (!config.vtb.userApiUrl || !config.vtb.dynamicApiUrl);
    const missingSyncApi = type === "sync" &&
      (!config.vtb.userApiUrl || !config.vtb.cardApiUrl || !config.vtb.liveApiUrl);
    if (missingLiveApi || missingDynamicApi || missingSyncApi) {
      await reply("需要的 B 站接口还没配置完整，请联系管理员处理。");
      return;
    }

    try {
      if (type === "list" || type === "subscribe" || type === "unsubscribe") {
        if (message.groupId === undefined) {
          await reply("主播订阅按群管理，请回到目标群里操作。私聊仍然可以查询直播和动态。");
          return;
        }
        if (!isGroupAdministrator(message.raw) && !isSubscriptionWhitelisted(
          message.userId,
          config.vtb.subscriptionWhitelistUserIds,
        )) {
          await reply("查询直播和动态可以直接用；管理本群订阅需要管理员或主播订阅白名单权限。");
          return;
        }

        if (type === "list") {
          const subscription = findVtbSubscription(config.vtb.subscriptions, message.groupId);
          await reply(
            subscription?.streamers.length
              ? [`这个群订阅了 ${subscription.streamers.length} 位主播：`, ...subscription.streamers.map((name) => `· ${name}`)].join("\n")
              : "这个群还没订阅主播。\n添加：miz vtb subscribe 主播昵称",
          );
          return;
        }

        const result = type === "subscribe"
          ? await addVtbSubscription(message.groupId, streamerName)
          : await removeVtbSubscription(message.groupId, streamerName);
        if (!result.changed) {
          await reply(type === "subscribe" ? `已经订阅 ${streamerName} 了。` : `订阅列表里没有 ${streamerName}。`);
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
            ? `已订阅 ${streamerName}。\n之后的开播和新动态会发到这个群。`
            : `已订阅 ${streamerName}。\n资料暂时没同步好，后台会继续重试。`
          : `已取消订阅 ${streamerName}。`);
        return;
      }

      if (type === "sync") {
        if (!isSyncWhitelisted(message.userId, config.vtb.syncWhitelistUserIds)) {
          await reply("资料同步只对同步白名单成员开放。");
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
            `资料同步完成：新增 ${databaseSync.added.length} 位，移除 ${databaseSync.removed.length} 位，没找到 ${databaseSync.skipped.length} 位。`,
            renamed.length > 0
              ? [
                  `已根据 MID 更新 ${renamed.length} 位主播的昵称：`,
                  ...renamed.map((item) => `- ${item.previousName} → ${item.name}（MID：${item.mid}）`),
                ].join("\n")
              : "主播昵称与 B 站资料一致。",
            ...(roomUpdated.length > 0 ? [`更新了 ${roomUpdated.length} 个直播间 ID。`] : []),
            ...(failed.length > 0
              ? [
                  `${failed.length} 位主播同步失败：`,
                  ...failed.slice(0, 10).map((item) => `- ${item.name}：${item.reason}`),
                  ...(failed.length > 10 ? ["其余结果可以到日志里查看。"] : []),
                ]
              : []),
          ].join("\n"),
        );
        return;
      }

      const repository = await getVtbRepository(config);
      const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
      if (!streamer) {
        await reply(`没找到“${streamerName}”。请试试主播当前使用的完整 B 站昵称。`);
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
        await reply("这位主播现在没有可展示的动态。");
        return;
      }
      await reply(formatDynamicMessage(latestDynamic));
    } catch (error) {
      logger.error("plugin", "vtb query failed", error);
      await reply("B 站数据刚才没响应，过一会儿再查吧。");
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
