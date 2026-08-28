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
  resolveVtbStreamerForQuery,
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
  setVtbContributionStreamer,
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
  addSubscription?: (...args: Parameters<typeof addVtbSubscription>) => Promise<{ changed: boolean; streamers?: string[]; dynamicStreamers?: string[] }>;
  removeSubscription?: (...args: Parameters<typeof removeVtbSubscription>) => Promise<{ changed: boolean; streamers?: string[]; dynamicStreamers?: string[] }>;
  setAtAllStreamer?: typeof setVtbAtAllStreamer;
  setDynamicStreamer?: typeof setVtbDynamicStreamer;
  setDynamicAtAllStreamer?: typeof setVtbDynamicAtAllStreamer;
  setContributionStreamer?: typeof setVtbContributionStreamer;
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
  setContributionStreamer = setVtbContributionStreamer,
  getRepository = getVtbRepository,
  notifySubscriptionChange = notifyVtbSubscriptionChange,
}: VtbPluginDependencies = {}): MizPlugin => ({
  name: "vtb",
  commands: ["vtb"],
  description: [
    "VTB 直播订阅：miz vtb subscribe live|dynamic|contribution <主播>",
    "取消一项订阅：miz vtb unsubscribe live|dynamic|contribution <主播>",
    "设置 @全体：miz vtb atall live|dynamic enable/disable <主播>",
    "跟踪 B 站主播的直播、动态和打赏感谢，群里一条命令搞定。",
    "查直播：miz vtb live 主播昵称",
    "查动态：miz vtb dynamic 主播昵称",
    "看订阅：miz vtb list",
    "同步资料：miz vtb sync",
    "登录 B 站：miz vtb login",
    "退出登录：miz vtb logout",
    "订阅管理和资料同步需要群管理员或 VTB 管理员白名单；登录和退出登录仅限私聊，并需要同样的白名单权限。",
  ].join("\n"),
  async handle({ command, config, logger, message, reply }) {
    const [type, ...rawArgumentParts] = command.args.trim().split(/\s+/);
    const subscriptionType = (type === "subscribe" || type === "unsubscribe") &&
      (rawArgumentParts[0] === "live" || rawArgumentParts[0] === "dynamic" || rawArgumentParts[0] === "contribution")
      ? rawArgumentParts[0]
      : undefined;
    const argumentParts = subscriptionType ? rawArgumentParts.slice(1) : rawArgumentParts;
    const atAllType = type === "atall" && (argumentParts[0] === "live" || argumentParts[0] === "dynamic")
      ? argumentParts[0]
      : undefined;
    const atAllAction = type === "atall" ? parseAtAllAction(argumentParts[1]) : undefined;
    const dynamicAction = type === "dynamic" ? parseAtAllAction(argumentParts[0]) : undefined;
    const dynamicAtAllAction = type === "dynamicatall" || type === "dynamic-atall"
      ? parseAtAllAction(argumentParts[0])
      : undefined;
    const nameParts = type === "atall"
      ? argumentParts.slice(2)
      : argumentParts;
    const streamerName = nameParts.join(" ").trim();
    if (
      (type !== "live" && type !== "dynamic" && type !== "sync" && type !== "list" && type !== "subscribe" && type !== "unsubscribe" && type !== "atall" && type !== "login" && type !== "logout") ||
      ((type === "live" || type === "dynamic" || type === "subscribe" || type === "unsubscribe" || type === "atall") && !streamerName) ||
      (type === "subscribe" && subscriptionType === undefined) ||
      (type === "unsubscribe" && subscriptionType === undefined) ||
      (type === "dynamic" && dynamicAction !== undefined) ||
      (type === "atall" && (atAllType === undefined || atAllAction === undefined))
    ) {
      await reply([
        "这条命令格式不对，照着下面发：",
        "看看直播：miz vtb live 主播昵称",
        "看看动态：miz vtb dynamic 主播昵称",
        "查看关注：miz vtb list",
        "开启直播提醒：miz vtb subscribe live 主播昵称",
        "开启动态提醒：miz vtb subscribe dynamic 主播昵称",
        "开启打赏感谢：miz vtb subscribe contribution 主播昵称",
        "关闭提醒：miz vtb unsubscribe live/dynamic/contribution 主播昵称",
        "设置 @全体：miz vtb atall live/dynamic enable/disable 主播昵称",
        "同步主播资料：miz vtb sync",
        "登录 B 站：miz vtb login（私聊）",
        "退出 B 站登录：miz vtb logout（私聊）",
      ].join("\n"));
      return;
    }

    if (type === "login") {
      if (message.groupId !== undefined) {
        await reply("登录失败：扫码只能在私聊进行，请私聊发送 miz vtb login。");
        return;
      }
      if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
        await reply("登录失败：你的账号不在 VTB 管理员白名单里，请让管理员来操作。");
        return;
      }
      if (vtbLoginInProgress) {
        await reply("已经有一个登录二维码在等扫码啦，请等它完成或过期后再试。");
        return;
      }

      vtbLoginInProgress = true;
      try {
        const qr = await generateBilibiliQrLogin(config.vtb.proxyUrl);
        await reply([
          { type: "text", data: { text: "请打开哔哩哔哩 App 扫描下方二维码，5 分钟内有效～" } },
          { type: "image", data: { file: `base64://${qr.image.toString("base64")}` } },
        ]);
        await waitForBilibiliQrLogin(qr.qrcodeKey, config.vtb.proxyUrl);
        await reply("✅ B 站登录成功！之后的 VTB 请求会自动使用这份登录状态。\n需要换号时，再发一次 miz vtb login 就好。");
      } catch (error) {
        logger.warn("plugin", "vtb bilibili QR login failed", { error: summarizeError(error) });
        await reply(formatVtbCommandFailure("login", "", error));
      } finally {
        vtbLoginInProgress = false;
      }
      return;
    }

    if (type === "logout") {
      if (message.groupId !== undefined) {
        await reply("退出失败：登录状态只能在私聊清除，请私聊发送 miz vtb logout。");
        return;
      }
      if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
        await reply("退出失败：你的账号不在 VTB 管理员白名单里，请让管理员来操作。");
        return;
      }
      try {
        await clearBilibiliCredential();
      } catch (error) {
        logger.warn("plugin", "vtb bilibili credential logout failed", { error: summarizeError(error) });
        await reply(formatVtbCommandFailure("logout", "", error));
        return;
      }
      await reply("✅ 已退出 B 站登录，之后的 VTB 请求和视频下载不会再携带登录状态。");
      return;
    }

    if (!config.vtb.enabled) {
      await reply("VTB 功能还没开通，请管理员先开启 miz.vtb.enabled。");
      return;
    }

    const performsStreamerLookup = type === "live" ||
      (type === "dynamic" && dynamicAction === undefined) ||
      type === "subscribe";
    if (performsStreamerLookup && looksLikeUrl(streamerName)) {
      await reply("这里要填主播当前的完整 B 站昵称，不是直播间链接～换成昵称再试一次。");
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
      await reply("VTB 接口还没配齐，请管理员补好配置后再来试。");
      return;
    }

    try {
      const isDynamicMutation = type === "dynamic" && dynamicAction !== undefined;
      const isContributionMutation = (type === "subscribe" || type === "unsubscribe") && subscriptionType === "contribution";
      const isDynamicAtAllMutation =
        (String(type) === "dynamicatall" || String(type) === "dynamic-atall") && dynamicAtAllAction !== undefined;
      if (type === "list" || type === "subscribe" || type === "unsubscribe" || type === "atall" || isDynamicMutation || isDynamicAtAllMutation) {
        if (message.groupId === undefined) {
          await reply("订阅名单只能在群里管理，请到目标群发送这条命令。");
          return;
        }
        if (!isGroupAdministrator(message.raw) && !isWhitelistedUser(
          message.userId,
          config.vtb.adminWhitelistUserIds,
        )) {
          await reply("这项设置需要群管理员或 VTB 管理员来操作～");
          return;
        }

        if (type === "list") {
          {
            const latestConfig = await loadCurrentConfig();
            const subscription = findVtbSubscription(latestConfig.vtb.subscriptions, message.groupId);
            const names = subscription
              ? [...new Set([...subscription.streamers, ...(subscription.dynamicStreamers ?? [])])]
              : [];
            if (names.length === 0) {
              await reply("📺 本群还没有关注主播～\n添加：miz vtb subscribe live 主播昵称");
              return;
            }
            await reply(formatVtbSubscriptionList(subscription!));
            return;
            await reply([
              `\u{1F4FA} 本群已订阅 ${names.length} 位主播：`,
              ...names.flatMap((name, index) => {
                const live = subscription?.streamers.includes(name) === true;
                const dynamic = subscription?.dynamicStreamers?.includes(name) === true;
                return [
                  `${index + 1}. ${name}`,
                  ...(live ? ["   · 直播推送"] : []),
                  ...(dynamic ? ["   · 动态推送"] : []),
                  ...(subscription?.atAllStreamers?.includes(name) ? ["   · 开播 @全体成员"] : []),
                  ...(subscription?.dynamicAtAllStreamers?.includes(name) ? ["   · 动态 @全体成员"] : []),
                  ...(index < names.length - 1 ? [""] : []),
                  `   · 直播推送：${live ? "开启" : "关闭"}`,
                  `   · 动态推送：${dynamic ? "开启" : "关闭"}`,
                ];
              }),
            ].join("\n"));
            return;
          }
        }

        if (type === "atall") {
          const enabled = atAllAction === "enable";
          const result = atAllType === "dynamic"
            ? await setDynamicAtAllStreamer(message.groupId, streamerName, enabled)
            : await setAtAllStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
          await reply(`${streamerName} 还没开启直播提醒，请先发送 miz vtb subscribe live ${streamerName}。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的开播 @全体提醒已经${enabled ? "开启" : "关闭"}啦。`);
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
          await reply(`已${enabled ? "开启" : "关闭"} ${streamerName} 的开播 @全体提醒～`);
          return;
        }

        if (isDynamicMutation) {
          const enabled = dynamicAction === "enable";
          const result = await setDynamicStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
          await reply(`${streamerName} 还没开启直播提醒，请先发送 miz vtb subscribe live ${streamerName}。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的动态提醒已经${enabled ? "开启" : "关闭"}啦。`);
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
          await reply(`${streamerName} 的动态提醒已${enabled ? "开启" : "关闭"}～`);
          return;
        }

        if (isContributionMutation) {
          const enabled = type === "subscribe";
          const result = await setContributionStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
            await reply(`${streamerName} 还没开启直播提醒，请先发送 miz vtb subscribe live ${streamerName}。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的实时打赏感谢已经${enabled ? "开启" : "关闭"}啦。`);
            return;
          }
          const nextSubscriptions = (await loadCurrentConfig()).vtb.subscriptions;
          notifySubscriptionChange({ groupId: message.groupId, subscriptions: nextSubscriptions });
          await reply(`${streamerName} 的实时打赏感谢已${enabled ? "开启" : "关闭"}～`);
          return;
        }

        if (isDynamicAtAllMutation) {
          const enabled = dynamicAtAllAction === "enable";
          const result = await setDynamicAtAllStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
          await reply(`${streamerName} 还没开启对应提醒，请先订阅这位主播。`);
            return;
          }
          if (!result.changed) {
            await reply(`${streamerName} 的动态 @全体提醒已经${enabled ? "开启" : "关闭"}啦。`);
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
          await reply(`${streamerName} 的动态 @全体提醒已${enabled ? "开启" : "关闭"}～`);
          return;
        }

        const regularSubscriptionType = subscriptionType === "contribution" ? undefined : subscriptionType;
        const result = type === "subscribe"
          ? regularSubscriptionType
            ? await addSubscription(message.groupId, streamerName, regularSubscriptionType)
            : await addSubscription(message.groupId, streamerName)
          : regularSubscriptionType
            ? await removeSubscription(message.groupId, streamerName, regularSubscriptionType)
            : await removeSubscription(message.groupId, streamerName);
        if (!result.changed) {
          await reply(type === "subscribe"
            ? `${streamerName} 已经在关注名单里啦，不用重复添加。`
            : `关注名单里没有 ${streamerName}，检查一下昵称再试～`);
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
        } else if (!nextSubscriptions.some((subscription) =>
          subscription.streamers.includes(streamerName) || subscription.dynamicStreamers?.includes(streamerName) === true)) {
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
          action: subscriptionType ? `${type}-${subscriptionType}` : type,
          groupId: message.groupId,
          streamerName,
        });
        notifySubscriptionChange({
          groupId: message.groupId,
          subscriptions: nextSubscriptions,
        });
        if (subscriptionType) {
          await reply(type === "subscribe"
            ? subscriptionType === "live"
              ? `📺 ${streamerName} 的直播提醒已上线！想看动态，再发 miz vtb subscribe dynamic ${streamerName}。`
              : `📮 ${streamerName} 的动态提醒已上线！想蹲开播，再发 miz vtb subscribe live ${streamerName}。`
            : `已关闭 ${streamerName} 的${subscriptionType === "live" ? "直播" : "动态"}提醒。`);
          return;
        }
        await reply(type === "subscribe"
          ? databaseSynchronized
              ? `📺 已关注 ${streamerName}！\n之后开播、下播都会来群里报到；动态提醒默认关闭，需要时发送 miz vtb dynamic enable ${streamerName}。`
              : `📺 已把 ${streamerName} 加入关注名单！\n资料还在同步，稍后会补齐开播和下播提醒。`
          : `已取消关注 ${streamerName}。下次想看，随时再加回来～`);
        return;
      }

      if (type === "sync") {
        if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
          await reply("资料同步需要 VTB 管理员权限，请让管理员来执行 miz vtb sync～");
          return;
        }

        const fullConfig = await loadCurrentConfig();
        const { databaseSync, renamed, roomUpdated, failed } = await syncVtbSubscriptionNames(fullConfig);
        const syncFailures = [
          ...databaseSync.failed,
          ...failed,
        ];
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
            `🔄 资料同步完成：新增 ${databaseSync.added.length} 位，移除 ${databaseSync.removed.length} 位，暂未找到 ${databaseSync.skipped.length} 位。`,
            renamed.length > 0
              ? [
                  `✏️ 根据 MID 更新了 ${renamed.length} 位主播的昵称：`,
                  ...renamed.map((item) => `- ${item.previousName} → ${item.name}（MID：${item.mid}）`),
                ].join("\n")
              : "主播昵称都和 B 站资料对上啦～",
            ...(roomUpdated.length > 0 ? [`🏠 已匹配 ${roomUpdated.length} 个直播间。`] : []),
            ...(databaseSync.skipped.length > 0
              ? [
                  `有 ${databaseSync.skipped.length} 位主播没找到：${databaseSync.skipped.slice(0, 10).join("、")}`,
                  "请确认关注名单里填的是主播当前的完整 B 站昵称～",
                ]
              : []),
            ...(syncFailures.length > 0
              ? [
                  `有 ${syncFailures.length} 位主播没同步上，原因是：`,
                  ...syncFailures.slice(0, 10).map((item) => `- ${item.name}：${item.reason}`),
                  ...(syncFailures.length > 10 ? ["其余失败原因请查看日志。"] : []),
                  "检查一下 B 站接口和网络，再发送 miz vtb sync。",
                ]
              : []),
          ].join("\n"),
        );
        return;
      }

      const repository = await getRepository(config);
      const streamer = await resolveVtbStreamerForQuery(streamerName, config.vtb, repository);
      if (!streamer) {
        await reply(`没找到“${streamerName}”，换成主播当前的完整 B 站昵称再试试～`);
        return;
      }

      if (type === "live") {
        const [live, cachedCard] = await Promise.all([
          getVtbLiveInfo(streamer, config.vtb),
          getVtbCardInfo(streamer.mid, config.vtb).catch((error) => {
            // Avatar data is optional for a live status query. A
            // transient card API failure should not hide the live result.
            logger.warn("plugin", "vtb live query card lookup failed; continuing without card data", {
              streamerName,
              error: summarizeError(error),
            });
            return {} as VtbCardInfo;
          }),
        ]);
        let imageFile: string | undefined;
        try {
          imageFile = await getVtbImageFile(live.coverUrl ?? cachedCard.avatarUrl, config.vtb);
        } catch (error) {
          logger.warn("plugin", "vtb query image unavailable; sending text only", { streamerName, error });
        }
        await reply(createVtbNotificationMessage(
          formatLiveQueryMessage(live, cachedCard.fans, config.vtb.liveWebUrl),
          imageFile,
        ));
        return;
      }

      const feed = await getVtbDynamics(streamer, config.vtb);
      const latestDynamic = feed.items[0];
      if (!latestDynamic) {
        await reply("这位主播最近还没有新动态，晚点再来看看～");
        return;
      }
      const dynamicImageFiles = await Promise.all((latestDynamic.imageUrls ?? []).map(async (imageUrl) => {
        try {
          return await getVtbImageFile(imageUrl, config.vtb);
        } catch (error) {
          logger.warn("plugin", "vtb dynamic image unavailable", { streamerName, imageUrl, error });
          return undefined;
        }
      }));
      let imageFiles = dynamicImageFiles.filter((file): file is string => file !== undefined);
      if (imageFiles.length === 0) {
        try {
          const avatarFile = await getVtbImageFile(feed.avatarUrl, config.vtb);
          imageFiles = avatarFile ? [avatarFile] : [];
        } catch (error) {
          logger.warn("plugin", "vtb query image unavailable; sending text only", { streamerName, error });
        }
      }
      await reply(createVtbNotificationMessage(
        formatDynamicMessage(latestDynamic, config.vtb.webUrl),
        imageFiles,
      ));
    } catch (error) {
      logger.error("plugin", "vtb command failed", error);
      if (type === "dynamic" && error instanceof Error && error.message.includes("logged-in credential")) {
        await reply(formatVtbCommandFailure("dynamic", streamerName, error));
        return;
      }
      if (error instanceof Error) {
        const protectedError = error as Error & {
          cooldownReason?: "risk" | "transient";
          cooldownUntil?: number;
          retryAfterMs?: number;
          status?: number;
        };
        const isExplicitProtection = error.name === "VtbRateLimitError" ||
          protectedError.status === 412 ||
          protectedError.status === 429 ||
          (error.name === "VtbCooldownError" && protectedError.cooldownReason === "risk");
        if (isExplicitProtection) {
          const remainingMs = typeof protectedError.cooldownUntil === "number"
            ? protectedError.cooldownUntil - Date.now()
            : protectedError.retryAfterMs;
          const remainingMinutes = typeof remainingMs === "number"
            ? Math.max(1, Math.ceil(remainingMs / 60_000))
            : 5;
          await reply(`${formatVtbFailure(type, streamerName, dynamicAction !== undefined)}：B站暂时限流，约 ${remainingMinutes} 分钟后再试～`);
          return;
        }
        if (error.name === "VtbCooldownError") {
          await reply(`${formatVtbFailure(type, streamerName, dynamicAction !== undefined)}：B站接口没回话，晚点再试～`);
          return;
        }
      }
      await reply(formatVtbCommandFailure(type, streamerName, error, dynamicAction !== undefined));
    }
  },
});

const vtbPlugin = createVtbPlugin();

const parseAtAllAction = (action: string | undefined) => {
  if (action === "enable" || action === "on" || action === "开启") return "enable" as const;
  if (action === "disable" || action === "off" || action === "关闭") return "disable" as const;
  return undefined;
};

const looksLikeUrl = (value: string) =>
  /^(?:https?:\/\/|www\.)/i.test(value) || /(?:^|\.)bilibili\.com\//i.test(value);

const formatVtbOperation = (type: string, dynamicMutation = false) => {
  if (type === "login") return "登录";
  if (type === "logout") return "退出登录";
  if (type === "subscribe") return "订阅";
  if (type === "unsubscribe") return "取消订阅";
  if (type === "atall") return "设置开播 @全体成员";
  if (type === "dynamicatall" || type === "dynamic-atall") {
    return "设置动态 @全体成员";
  }
  if (type === "dynamic") {
    return dynamicMutation
      ? "设置动态推送"
      : "查询动态";
  }
  if (type === "live") return "查询直播";
  if (type === "sync") return "资料同步";
  if (type === "list") return "读取订阅列表";
  return "执行 VTB 操作";
};

const formatVtbFailure = (type: string, streamerName: string, dynamicMutation = false) => {
  const operation = formatVtbOperation(type, dynamicMutation);
  return `${operation}失败${streamerName ? `（主播“${streamerName}”）` : ""}`;
};

const formatVtbCommandFailure = (
  type: string,
  streamerName: string,
  error: unknown,
  dynamicMutation = false,
) => {
  const failure = formatVtbFailure(type, streamerName, dynamicMutation);
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("logged-in credential")) {
    return `${failure}：还没登录 B 站，请让管理员私聊发送 miz vtb login～`;
  }
  if (message.includes("qr code expired") || message.includes("qr login timed out") || message.includes("timed out while waiting")) {
    return `${failure}：二维码过期或等待超时，请重新发送 miz vtb login 扫码～`;
  }
  if (error instanceof Error && (error.name === "VtbRateLimitError" || error.name === "VtbCooldownError")) {
    return `${failure}：B站暂时限流，等一会儿再试～`;
  }
  if (type === "subscribe" || type === "unsubscribe" || type === "atall" ||
    type === "dynamicatall" || type === "dynamic-atall" || type === "list" || dynamicMutation) {
    return `${failure}：订阅名单暂时读写不了，请检查 config/vtb.toml～`;
  }
  if (/eacces|eperm|permission denied|read-only|vtb\.toml|config file/.test(message)) {
    return `${failure}：VTB 配置文件读写失败，请检查 config/vtb.toml 是否存在且可写～`;
  }
  if (/database|prisma|postgres|connection refused|econnrefused/.test(message)) {
    return `${failure}：数据库暂时没连上，检查一下状态再试～`;
  }
  if (/fetch failed|network|timeout|timed out|socket|dns|bilibili .*api|api failed|http \d/.test(message)) {
    return `${failure}：B站接口没回话，检查网络或代理配置再试～`;
  }
  return `${failure}：这次没跑顺，稍后再试～`;
};

const formatVtbSubscriptionList = (
  subscription: Readonly<{
    groupId: string | number;
    streamers: readonly string[];
    atAllStreamers?: readonly string[];
    dynamicStreamers?: readonly string[];
    dynamicAtAllStreamers?: readonly string[];
    contributionStreamers?: readonly string[];
  }>,
) => {
  const names = [...new Set([
    ...subscription.streamers,
    ...(subscription.dynamicStreamers ?? []),
  ])];
  const legacyLines = names.flatMap((name, index) => [
    `${index + 1}. ${name}`,
    ...(subscription.streamers.includes(name) ? ["   · 直播推送"] : []),
    ...(subscription.dynamicStreamers?.includes(name) ? ["   · 动态推送"] : []),
    ...(subscription.atAllStreamers?.includes(name) ? ["   · 开播 @全体成员"] : []),
    ...(subscription.dynamicAtAllStreamers?.includes(name) ? ["   · 动态 @全体成员"] : []),
    ...(subscription.contributionStreamers?.includes(name) ? ["   · 实时打赏感谢"] : []),
    ...(index < names.length - 1 ? [""] : []),
  ]);
  return [
    `📺 本群关注了 ${names.length} 位主播：`,
    ...legacyLines,
  ].join("\n");
};

export default vtbPlugin;
