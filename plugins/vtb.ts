import type { MizPlugin } from "@/plugins";
import { isGroupAdministrator, isWhitelistedUser } from "@/group-permissions";
import { summarizeError } from "@/errors";
import {
  createVtbNotificationMessage,
  findVtbNameChanges,
  formatDynamicMessage,
  formatLiveQueryMessage,
  getVtbCardInfo,
  getVtbCardInfos,
  getVtbRepository,
  getVtbDynamics,
  getVtbImageFile,
  getVtbLiveInfo,
  resolveTrackedVtbStreamer,
  syncVtbSubscriptionNames,
  type VtbCardInfo,
} from "@/vtb";
import {
  addVtbSubscription,
  loadConfig,
  removeVtbSubscription,
  setVtbAtAllStreamer,
  setVtbDynamicStreamer,
  setVtbDynamicAtAllStreamer,
  updateVtbSubscriptionNames,
} from "@/config";
import { findVtbSubscription } from "@/vtb-subscriptions";
import { notifyVtbSubscriptionChange } from "@/vtb-subscription-runtime";
import {
  clearBilibiliCredential,
  generateBilibiliQrLogin,
  waitForBilibiliQrLogin,
} from "@/bilibili-credential";

type VtbPluginDependencies = {
  loadCurrentConfig?: typeof loadConfig;
  addSubscription?: typeof addVtbSubscription;
  removeSubscription?: typeof removeVtbSubscription;
  setAtAllStreamer?: typeof setVtbAtAllStreamer;
  setDynamicStreamer?: typeof setVtbDynamicStreamer;
  setDynamicAtAllStreamer?: typeof setVtbDynamicAtAllStreamer;
  getRepository?: typeof getVtbRepository;
  notifySubscriptionChange?: typeof notifyVtbSubscriptionChange;
};

let vtbLoginInProgress = false;

export const createVtbPlugin = ({
  loadCurrentConfig = loadConfig,
  addSubscription = addVtbSubscription,
  removeSubscription = removeVtbSubscription,
  setAtAllStreamer = setVtbAtAllStreamer,
  setDynamicStreamer = setVtbDynamicStreamer,
  setDynamicAtAllStreamer = setVtbDynamicAtAllStreamer,
  getRepository = getVtbRepository,
  notifySubscriptionChange = notifyVtbSubscriptionChange,
}: VtbPluginDependencies = {}): MizPlugin => ({
  name: "vtb",
  commands: ["vtb"],
  description: [
    "追踪 B 站主播的直播和动态，也能管理本群的关注名单。",
    "查询直播：miz vtb live 主播昵称",
    "查询动态：miz vtb dynamic 主播昵称",
    "查看订阅：miz vtb list",
    "添加订阅：miz vtb subscribe 主播昵称",
    "取消订阅：miz vtb unsubscribe 主播昵称",
    "开播 @全体：miz vtb atall enable/disable 主播昵称",
    "动态推送：miz vtb dynamic enable/disable 主播昵称",
    "动态 @全体：miz vtb dynamicatall enable/disable 主播昵称",
    "同步昵称与直播间：miz vtb sync",
    "扫码登录：miz vtb login",
    "退出登录：miz vtb logout",
    "订阅管理、推送开关和资料同步需要 VTB 管理员白名单权限；扫码登录和退出登录仅限私聊，并需要同样的白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    const [type, ...argumentParts] = command.args.trim().split(/\s+/);
    const atAllAction = type === "atall" ? parseAtAllAction(argumentParts[0]) : undefined;
    const dynamicAction = type === "dynamic" ? parseAtAllAction(argumentParts[0]) : undefined;
    const dynamicAtAllAction = type === "dynamicatall" || type === "dynamic-atall"
      ? parseAtAllAction(argumentParts[0])
      : undefined;
    const nameParts = type === "atall" || type === "dynamicatall" || type === "dynamic-atall"
      ? argumentParts.slice(1)
      : type === "dynamic" && dynamicAction !== undefined
        ? argumentParts.slice(1)
        : argumentParts;
    const streamerName = nameParts.join(" ").trim();
    if (
      (type !== "live" && type !== "dynamic" && type !== "sync" && type !== "list" && type !== "subscribe" && type !== "unsubscribe" && type !== "atall" && type !== "dynamicatall" && type !== "dynamic-atall" && type !== "login" && type !== "logout") ||
      ((type === "live" || type === "dynamic" || type === "subscribe" || type === "unsubscribe" || type === "atall" || type === "dynamicatall" || type === "dynamic-atall") && !streamerName) ||
      (type === "atall" && atAllAction === undefined) ||
      ((type === "dynamicatall" || type === "dynamic-atall") && dynamicAtAllAction === undefined)
    ) {
      await reply([
        "📺 B 站主播功能这样用：",
        "直播状态：miz vtb live 主播昵称",
        "最新动态：miz vtb dynamic 主播昵称",
        "订阅列表：miz vtb list",
        "添加订阅：miz vtb subscribe 主播昵称",
        "取消订阅：miz vtb unsubscribe 主播昵称",
        "开播 @全体：miz vtb atall enable/disable 主播昵称",
        "动态推送：miz vtb dynamic enable/disable 主播昵称",
        "动态 @全体：miz vtb dynamicatall enable/disable 主播昵称",
        "同步资料：miz vtb sync",
        "扫码登录：miz vtb login（私聊）",
        "退出登录：miz vtb logout（私聊）",
      ].join("\n"));
      return;
    }

    if (type === "login") {
      if (message.groupId !== undefined) {
        await reply("B 站扫码登录只允许在私聊中发起，避免二维码泄露。");
        return;
      }
      if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
        await reply("B 站登录只对 VTB 管理员白名单开放。");
        return;
      }
      if (vtbLoginInProgress) {
        await reply("已经有一个 B 站扫码登录在进行中了，请先完成或等待二维码过期。");
        return;
      }

      vtbLoginInProgress = true;
      try {
        const qr = await generateBilibiliQrLogin(config.vtb.proxyUrl);
        await reply([
          { type: "text", data: { text: "请使用 Bilibili App 扫描下方二维码登录；二维码 5 分钟内有效。" } },
          { type: "image", data: { file: `base64://${qr.image.toString("base64")}` } },
        ]);
        await waitForBilibiliQrLogin(qr.qrcodeKey, config.vtb.proxyUrl);
        await reply("B 站登录成功，完整凭据已保存，后续 VTB 请求会自动使用。\n如需重新登录，再次发送 miz vtb login 即可。");
      } catch (error) {
        logger.warn("plugin", "vtb bilibili QR login failed", { error: summarizeError(error) });
        await reply("B 站扫码登录没有完成，请稍后重新发送 miz vtb login 再试。");
      } finally {
        vtbLoginInProgress = false;
      }
      return;
    }

    if (type === "logout") {
      if (message.groupId !== undefined) {
        await reply("B 站登录凭据只允许在私聊中清除。");
        return;
      }
      if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
        await reply("B 站登录只对 VTB 管理员白名单开放。");
        return;
      }
      try {
        await clearBilibiliCredential();
      } catch (error) {
        logger.warn("plugin", "vtb bilibili credential logout failed", { error: summarizeError(error) });
        await reply("B 站登录凭据暂时没能清除，请稍后再试；当前凭据仍会继续使用。");
        return;
      }
      await reply("B 站已退出扫码登录；后续 VTB 和视频下载将不再携带登录凭据。");
      return;
    }

    if (!config.vtb.enabled) {
      await reply("主播追踪频道还没开启，喊管理员来接通一下吧。");
      return;
    }

    const missingLiveApi = type === "live" &&
      (!config.vtb.userApiUrl || !config.vtb.liveApiUrl ||
        !config.vtb.webUrl || !config.vtb.liveWebUrl);
    const missingDynamicApi = type === "dynamic" && dynamicAction === undefined &&
      (!config.vtb.userApiUrl || !config.vtb.webUrl);
    const missingSyncApi = type === "sync" &&
      (!config.vtb.userApiUrl || !config.vtb.cardApiUrl || !config.vtb.liveApiUrl || !config.vtb.webUrl);
    if (missingLiveApi || missingDynamicApi || missingSyncApi) {
      await reply("主播追踪需要的接口还没接完整，请联系管理员完成配置。");
      return;
    }

    try {
      const isDynamicMutation = type === "dynamic" && dynamicAction !== undefined;
      const isDynamicAtAllMutation =
        (type === "dynamicatall" || type === "dynamic-atall") && dynamicAtAllAction !== undefined;
      if (type === "list" || type === "subscribe" || type === "unsubscribe" || type === "atall" || isDynamicMutation || isDynamicAtAllMutation) {
        if (message.groupId === undefined) {
          await reply("主播关注名单跟着群聊走，回到目标群里管理吧。私聊仍然可以查询直播和动态。");
          return;
        }
        if (!isGroupAdministrator(message.raw) && !isWhitelistedUser(
          message.userId,
          config.vtb.adminWhitelistUserIds,
        )) {
          await reply("查询直播和动态可以直接用；调整本群关注名单需要群管理员或 VTB 管理员白名单权限。");
          return;
        }

        if (type === "list") {
          // Subscription commands persist directly to vtb.toml. The plugin's
          // config is an immutable runtime snapshot and can stay stale until
          // the debounced config watcher reloads it, so always list the latest
          // persisted subscriptions.
          const latestConfig = await loadCurrentConfig();
          const subscription = findVtbSubscription(latestConfig.vtb.subscriptions, message.groupId);
          await reply(
            subscription?.streamers.length
              ? [
                  `📺 这个群正在关注 ${subscription.streamers.length} 位主播：`,
                  ...subscription.streamers.map((name) =>
                    [
                      `· ${name}（开播 @全体成员：${subscription.atAllStreamers?.includes(name) ? "是" : "否"}）`,
                      `  直播推送：是；动态推送：${subscription.dynamicStreamers?.includes(name) ? "是" : "否"}`,
                    ].join("\n")),
                ].join("\n")
              : "📺 关注名单还是空的。\n添加：miz vtb subscribe 主播昵称",
          );
          return;
        }

        if (type === "atall") {
          const enabled = atAllAction === "enable";
          const result = await setAtAllStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
            await reply(`关注名单里没有 ${streamerName}，请先用 miz vtb subscribe ${streamerName} 添加订阅。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的开播 @全体成员已经${enabled ? "开启" : "关闭"}了。`);
            return;
          }
          logger.info("plugin", "vtb group at-all setting updated", {
            action: enabled ? "enable" : "disable",
            groupId: message.groupId,
            streamerName,
          });
          notifySubscriptionChange({
            groupId: message.groupId,
            subscriptions: (await loadCurrentConfig()).vtb.subscriptions,
          });
          await reply(`已${enabled ? "开启" : "关闭"} ${streamerName} 的开播 @全体成员。`);
          return;
        }

        if (isDynamicMutation) {
          const enabled = dynamicAction === "enable";
          const result = await setDynamicStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
            await reply(`关注名单里没有 ${streamerName}，请先用 miz vtb subscribe ${streamerName} 添加订阅。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的动态推送已经${enabled ? "开启" : "关闭"}了。`);
            return;
          }
          const nextSubscriptions = (await loadCurrentConfig()).vtb.subscriptions;
          logger.info("plugin", "vtb group dynamic setting updated", {
            action: enabled ? "enable" : "disable",
            groupId: message.groupId,
            streamerName,
          });
          notifySubscriptionChange({
            groupId: message.groupId,
            subscriptions: nextSubscriptions,
          });
          await reply(`${streamerName} 的动态推送已${enabled ? "开启" : "关闭"}。`);
          return;
        }

        if (isDynamicAtAllMutation) {
          const enabled = dynamicAtAllAction === "enable";
          const result = await setDynamicAtAllStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
            await reply(`未在关注名单里找到 ${streamerName}，请先用 miz vtb subscribe ${streamerName} 添加订阅。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的动态 @全体成员已经${enabled ? "开启" : "关闭"}了。`);
            return;
          }
          const nextSubscriptions = (await loadCurrentConfig()).vtb.subscriptions;
          logger.info("plugin", "vtb group dynamic at-all setting updated", {
            action: enabled ? "enable" : "disable",
            groupId: message.groupId,
            streamerName,
          });
          notifySubscriptionChange({
            groupId: message.groupId,
            subscriptions: nextSubscriptions,
          });
          await reply(`动态推送的 @全体成员已${enabled ? "开启" : "关闭"}：${streamerName}。`);
          return;
        }

        const result = type === "subscribe"
          ? await addSubscription(message.groupId, streamerName)
          : await removeSubscription(message.groupId, streamerName);
        if (!result.changed) {
          await reply(type === "subscribe" ? `${streamerName} 已经在关注名单里啦。` : `关注名单里没有 ${streamerName}。`);
          return;
        }

        // Use the state after the atomic file update. Besides making an
        // immediate follow-up command consistent, this prevents an
        // unsubscribe from deleting a streamer that a stale runtime snapshot
        // did not know was still subscribed in another group.
        const nextSubscriptions = (await loadCurrentConfig()).vtb.subscriptions;
        let databaseSynchronized = true;
        if (type === "subscribe") {
          try {
            const repository = await getRepository(config);
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
          try {
            const repository = await getRepository(config);
            const removed = await repository.deleteStreamerByName(streamerName);
            if (removed) {
              logger.info("plugin", "vtb streamer removed from database after final subscription was cancelled", {
                streamerName,
              });
            }
          } catch (error) {
            // The config file is already the source of truth. A database
            // cleanup failure should not make a successful unsubscribe look
            // like it failed or prevent the runtime snapshot from refreshing.
            logger.warn("plugin", "vtb streamer database cleanup failed after unsubscribe", {
              streamerName,
              error: summarizeError(error),
            });
          }
        }
        logger.info("plugin", "vtb group subscription updated", {
          action: type,
          groupId: message.groupId,
          streamerName,
        });
        notifySubscriptionChange({
          groupId: message.groupId,
          subscriptions: nextSubscriptions,
        });
        await reply(type === "subscribe"
          ? databaseSynchronized
            ? `📺 已关注 ${streamerName}！\n之后的开播和下播会来到这个群；动态推送默认关闭，需要时发送 miz vtb dynamic enable ${streamerName}。`
            : `📺 已把 ${streamerName} 加入关注名单。\n资料还在同步，后台会继续追上；同步完成后默认推送开播和下播，动态可另行开启。`
          : `已经取消关注 ${streamerName}。`);
        return;
      }

      if (type === "sync") {
        if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
          await reply("资料同步通道只对 VTB 管理员白名单成员开放。");
          return;
        }

        const fullConfig = await loadCurrentConfig();
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

      const repository = await getRepository(config);
      const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
      if (!streamer) {
        await reply(`没找到“${streamerName}”。换成主播当前使用的完整 B 站昵称再试试吧。`);
        return;
      }

      if (type === "live") {
        const [live, cachedCard] = await Promise.all([
          getVtbLiveInfo(streamer, config.vtb),
          getVtbCardInfo(streamer.mid, config.vtb).catch((error) => {
            // Fan count and avatar are optional for a live status query. A
            // transient card API failure should not hide the live result.
            logger.warn("plugin", "vtb live query card lookup failed; continuing without card data", {
              streamerName,
              error: summarizeError(error),
            });
            return {} as VtbCardInfo;
          }),
        ]);
        let card = cachedCard;
        if (live.name !== streamer.name) {
          try {
            card = (await getVtbCardInfos([streamer.mid], config.vtb)).get(streamer.mid) ?? cachedCard;
          } catch (error) {
            logger.warn("plugin", "vtb live query nickname refresh failed; using available card data", {
              streamerName,
              error: summarizeError(error),
            });
          }
        }
        const renamed = findVtbNameChanges([streamer], new Map([[streamer.mid, card]]));
        if (renamed.length > 0) {
          const latestName = renamed[0].name;
          await updateVtbSubscriptionNames(new Map([[streamer.name, latestName]]));
          await repository.upsertStreamer({ ...streamer, name: latestName });
          logger.info("plugin", "vtb subscription name updated after live query detected a change", {
            renamed,
          });
        }
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
      if (type === "dynamic" && error instanceof Error && error.message.includes("logged-in credential")) {
        await reply("查询 B 站动态需要先完成登录，请管理员私聊发送 miz vtb login 扫码登录。\n登录后再试一次 miz vtb dynamic 主播昵称；已开启的动态推送也会在登录后恢复。");
        return;
      }
      if (error instanceof Error && error.name === "VtbCooldownError") {
        await reply("B 站接口刚才触发了保护，机器人已暂时放慢请求；过几分钟再查一次就好。");
        return;
      }
      await reply("B 站数据刚才在路上卡了一下，过一会儿再查吧。");
    }
  },
});

const vtbPlugin = createVtbPlugin();

const parseAtAllAction = (action: string | undefined) => {
  if (action === "enable" || action === "on" || action === "开启") return "enable" as const;
  if (action === "disable" || action === "off" || action === "关闭") return "disable" as const;
  return undefined;
};

export default vtbPlugin;
