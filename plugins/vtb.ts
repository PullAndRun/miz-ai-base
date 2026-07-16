import type { MizPlugin } from "@/plugins";
import { isGroupAdministrator, isWhitelistedUser } from "@/group-permissions";
import { summarizeError } from "@/errors";
import {
  createVtbNotificationMessage,
  formatDynamicMessage,
  formatLiveQueryMessage,
  getVtbCardInfo,
  getVtbRepository,
  getVtbDynamics,
  getVtbImageFile,
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
    "追踪 B 站主播的直播和动态，也能管理本群的关注名单。",
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
        "📺 B 站主播功能这样用：",
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
      await reply("主播追踪频道还没开启，喊管理员来接通一下吧。");
      return;
    }

    const missingLiveApi = type === "live" &&
      (!config.vtb.userApiUrl || !config.vtb.cardApiUrl || !config.vtb.liveApiUrl ||
        !config.vtb.webUrl || !config.vtb.liveWebUrl);
    const missingDynamicApi = type === "dynamic" &&
      (!config.vtb.userApiUrl || !config.vtb.dynamicApiUrl || !config.vtb.webUrl);
    const missingSyncApi = type === "sync" &&
      (!config.vtb.userApiUrl || !config.vtb.cardApiUrl || !config.vtb.liveApiUrl || !config.vtb.webUrl);
    if (missingLiveApi || missingDynamicApi || missingSyncApi) {
      await reply("主播追踪需要的接口还没接完整，请联系管理员完成配置。");
      return;
    }

    try {
      if (type === "list" || type === "subscribe" || type === "unsubscribe") {
        if (message.groupId === undefined) {
          await reply("主播关注名单跟着群聊走，回到目标群里管理吧。私聊仍然可以查询直播和动态。");
          return;
        }
        if (!isGroupAdministrator(message.raw) && !isWhitelistedUser(
          message.userId,
          config.vtb.subscriptionWhitelistUserIds,
        )) {
          await reply("查询直播和动态可以直接用；调整本群关注名单需要管理员或主播订阅白名单权限。");
          return;
        }

        if (type === "list") {
          const subscription = findVtbSubscription(config.vtb.subscriptions, message.groupId);
          await reply(
            subscription?.streamers.length
              ? [`📺 这个群正在关注 ${subscription.streamers.length} 位主播：`, ...subscription.streamers.map((name) => `· ${name}`)].join("\n")
              : "📺 关注名单还是空的。\n添加：miz vtb subscribe 主播昵称",
          );
          return;
        }

        const result = type === "subscribe"
          ? await addVtbSubscription(message.groupId, streamerName)
          : await removeVtbSubscription(message.groupId, streamerName);
        if (!result.changed) {
          await reply(type === "subscribe" ? `${streamerName} 已经在关注名单里啦。` : `关注名单里没有 ${streamerName}。`);
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
              error: summarizeError(error),
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
            ? `📺 已关注 ${streamerName}！\n之后的开播和新动态会来到这个群。`
            : `📺 已把 ${streamerName} 加入关注名单。\n资料还在同步，后台会继续追上。`
          : `已经取消关注 ${streamerName}。`);
        return;
      }

      if (type === "sync") {
        if (!isWhitelistedUser(message.userId, config.vtb.syncWhitelistUserIds)) {
          await reply("资料同步通道只对同步白名单成员开放。");
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
            `🔄 资料同步跑完啦：新增 ${databaseSync.added.length} 位，移除 ${databaseSync.removed.length} 位，没找到 ${databaseSync.skipped.length} 位。`,
            renamed.length > 0
              ? [
                  `✏️ 根据 MID 更新了 ${renamed.length} 位主播的昵称：`,
                  ...renamed.map((item) => `- ${item.previousName} → ${item.name}（MID：${item.mid}）`),
                ].join("\n")
              : "主播昵称都和 B 站资料对上啦。",
            ...(roomUpdated.length > 0 ? [`🏠 对上了 ${roomUpdated.length} 个直播间 ID。`] : []),
            ...(failed.length > 0
              ? [
                  `⚠️ ${failed.length} 位主播暂时没同步上：`,
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
        await reply(`没找到“${streamerName}”。换成主播当前使用的完整 B 站昵称再试试吧。`);
        return;
      }

      if (type === "live") {
        const [live, card] = await Promise.all([
          getVtbLiveInfo(streamer, config.vtb),
          getVtbCardInfo(streamer.mid, config.vtb),
        ]);
        let imageFile: string | undefined;
        try {
          imageFile = await getVtbImageFile(live.coverUrl ?? card.avatarUrl, config.vtb);
        } catch (error) {
          logger.warn("plugin", "vtb query image unavailable; sending text only", { streamerName, error });
        }
        await reply(createVtbNotificationMessage(
          formatLiveQueryMessage(live, card.fans, config.vtb.liveWebUrl),
          imageFile,
        ));
        return;
      }

      const feed = await getVtbDynamics(streamer, config.vtb);
      const latestDynamic = feed.items[0];
      if (!latestDynamic) {
        await reply("这位主播最近还没有可以展示的新动态。");
        return;
      }
      let imageFile: string | undefined;
      try {
        imageFile = await getVtbImageFile(feed.avatarUrl, config.vtb);
      } catch (error) {
        logger.warn("plugin", "vtb query image unavailable; sending text only", { streamerName, error });
      }
      await reply(createVtbNotificationMessage(
        formatDynamicMessage(latestDynamic, config.vtb.webUrl),
        imageFile,
      ));
    } catch (error) {
      logger.error("plugin", "vtb query failed", error);
      await reply("B 站数据刚才在路上卡了一下，过一会儿再查吧。");
    }
  },
};

export default vtbPlugin;
