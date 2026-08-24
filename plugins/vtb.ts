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
        "这条命令没用对。请按下面的格式发送：",
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
        await reply("登录没成功：扫码登录只能在私聊进行。请私聊发送 miz vtb login。");
        return;
      }
      if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
        await reply("登录没成功：这个账号不在 VTB 管理员白名单中。请让 VTB 管理员来登录。");
        return;
      }
      if (vtbLoginInProgress) {
        await reply("登录没成功：已经有一个扫码登录在进行中。等它完成或过期后，再发送 miz vtb login。");
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
        await reply(formatVtbCommandFailure("login", "", error));
      } finally {
        vtbLoginInProgress = false;
      }
      return;
    }

    if (type === "logout") {
      if (message.groupId !== undefined) {
        await reply("退出登录没成功：只能在私聊清除 B 站登录凭据。请私聊发送 miz vtb logout。");
        return;
      }
      if (!isWhitelistedUser(message.userId, config.vtb.adminWhitelistUserIds)) {
        await reply("退出登录没成功：这个账号不在 VTB 管理员白名单中。请让 VTB 管理员来操作。");
        return;
      }
      try {
        await clearBilibiliCredential();
      } catch (error) {
        logger.warn("plugin", "vtb bilibili credential logout failed", { error: summarizeError(error) });
        await reply(formatVtbCommandFailure("logout", "", error));
        return;
      }
      await reply("B 站已退出扫码登录；后续 VTB 和视频下载将不再携带登录凭据。");
      return;
    }

    if (!config.vtb.enabled) {
      await reply("操作没成功：VTB 还没有开通。请管理员打开配置里的 miz.vtb.enabled，再试一次。");
      return;
    }

    const performsStreamerLookup = type === "live" ||
      (type === "dynamic" && dynamicAction === undefined) ||
      type === "subscribe";
    if (performsStreamerLookup && looksLikeUrl(streamerName)) {
      await reply("没查成：这里要填主播当前使用的完整 B 站昵称，不是直播间链接。换成昵称再试。");
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
      await reply("没查成：VTB 接口还没配齐。请管理员补好配置，再试一次。");
      return;
    }

    try {
      const isDynamicMutation = type === "dynamic" && dynamicAction !== undefined;
      const isDynamicAtAllMutation =
        (type === "dynamicatall" || type === "dynamic-atall") && dynamicAtAllAction !== undefined;
      if (type === "list" || type === "subscribe" || type === "unsubscribe" || type === "atall" || isDynamicMutation || isDynamicAtAllMutation) {
        if (message.groupId === undefined) {
          await reply("没改成：订阅名单只能在群里管理。请到目标群发送命令。");
          return;
        }
        if (!isGroupAdministrator(message.raw) && !isWhitelistedUser(
          message.userId,
          config.vtb.adminWhitelistUserIds,
        )) {
          await reply("没改成：你没有修改本群 VTB 订阅的权限。请让群管理员或 VTB 管理员来操作。");
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
                  `📺 本群已订阅 ${subscription.streamers.length} 位主播：`,
                  ...subscription.streamers.flatMap((name, index) => {
                    const enabledItems = [
                      "直播推送",
                      ...(subscription.dynamicStreamers?.includes(name) ? ["动态推送"] : []),
                      ...(subscription.atAllStreamers?.includes(name) ? ["开播 @全体成员"] : []),
                      ...(subscription.dynamicAtAllStreamers?.includes(name) ? ["动态 @全体成员"] : []),
                    ];
                    return [
                      `${index + 1}. ${name}`,
                      ...enabledItems.map((item) => `   · ${item}`),
                      ...(index < subscription.streamers.length - 1 ? [""] : []),
                    ];
                  }),
                ].join("\n")
              : "📺 关注名单还是空的。\n添加：miz vtb subscribe 主播昵称",
          );
          return;
        }

        if (type === "atall") {
          const enabled = atAllAction === "enable";
          const result = await setAtAllStreamer(message.groupId, streamerName, enabled);
          if (!result.subscribed) {
            await reply(`设置没成功：${streamerName} 还没订阅。请先发送 miz vtb subscribe ${streamerName}。`);
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
            await reply(`设置没成功：${streamerName} 还没订阅。请先发送 miz vtb subscribe ${streamerName}。`);
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
            await reply(`设置没成功：${streamerName} 还没订阅。请先发送 miz vtb subscribe ${streamerName}。`);
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
          await reply(type === "subscribe"
            ? `没订上：${streamerName} 已经在关注名单里了，不用重复订阅。`
            : `没取消成：关注名单里没有 ${streamerName}。检查一下昵称再试。`);
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
          await reply("同步没成功：这个账号不在 VTB 管理员白名单中。请让 VTB 管理员执行 miz vtb sync。");
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
            `🔄 资料同步跑完啦：新增 ${databaseSync.added.length} 位，移除 ${databaseSync.removed.length} 位，没找到 ${databaseSync.skipped.length} 位。`,
            renamed.length > 0
              ? [
                  `✏️ 根据 MID 更新了 ${renamed.length} 位主播的昵称：`,
                  ...renamed.map((item) => `- ${item.previousName} → ${item.name}（MID：${item.mid}）`),
                ].join("\n")
              : "主播昵称都和 B 站资料对上啦。",
            ...(roomUpdated.length > 0 ? [`🏠 对上了 ${roomUpdated.length} 个直播间 ID。`] : []),
            ...(databaseSync.skipped.length > 0
              ? [
                  `有 ${databaseSync.skipped.length} 位主播没找到：${databaseSync.skipped.slice(0, 10).join("、")}`,
                  "请确认关注名单里填的是主播当前的完整 B 站昵称。",
                ]
              : []),
            ...(syncFailures.length > 0
              ? [
                  `有 ${syncFailures.length} 位主播没同步上，原因是：`,
                  ...syncFailures.slice(0, 10).map((item) => `- ${item.name}：${item.reason}`),
                  ...(syncFailures.length > 10 ? ["其余失败原因请查看日志。"] : []),
                  "请检查 B 站接口和网络，再发送 miz vtb sync。",
                ]
              : []),
          ].join("\n"),
        );
        return;
      }

      const repository = await getRepository(config);
      const streamer = await resolveVtbStreamerForQuery(streamerName, config.vtb, repository);
      if (!streamer) {
        await reply(`没查到“${streamerName}”：请换成主播当前完整的 B 站昵称再试。`);
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
          await reply(`${formatVtbFailure(type, streamerName, dynamicAction !== undefined)}：B 站这会儿限流了。等约 ${remainingMinutes} 分钟再试。`);
          return;
        }
        if (error.name === "VtbCooldownError") {
          await reply(`${formatVtbFailure(type, streamerName, dynamicAction !== undefined)}：B 站接口这会儿没回消息。稍后再试。`);
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
  return `${operation}没成功${streamerName ? `（主播“${streamerName}”）` : ""}`;
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
    return `${failure}：还没登录 B 站。请让管理员私聊发送 miz vtb login，登录后再试。`;
  }
  if (message.includes("qr code expired") || message.includes("qr login timed out") || message.includes("timed out while waiting")) {
    return `${failure}：二维码过期了，或者等超时了。请重新发送 miz vtb login，扫新的二维码。`;
  }
  if (error instanceof Error && (error.name === "VtbRateLimitError" || error.name === "VtbCooldownError")) {
    return `${failure}：B 站暂时不让查。等一会儿再试。`;
  }
  if (type === "subscribe" || type === "unsubscribe" || type === "atall" ||
    type === "dynamicatall" || type === "dynamic-atall" || type === "list" || dynamicMutation) {
    return `${failure}：VTB 订阅名单没能读写。请检查 config/vtb.toml，再试一次。`;
  }
  if (/eacces|eperm|permission denied|read-only|vtb\.toml|config file/.test(message)) {
    return `${failure}：VTB 配置文件读写失败。请检查 config/vtb.toml 是否存在、可写，再试一次。`;
  }
  if (/database|prisma|postgres|connection refused|econnrefused/.test(message)) {
    return `${failure}：数据库没连上。请检查数据库状态，再试一次。`;
  }
  if (/fetch failed|network|timeout|timed out|socket|dns|bilibili .*api|api failed|http \d/.test(message)) {
    return `${failure}：B 站接口这会儿没回消息。请检查网络或代理配置，再试一次。`;
  }
  return `${failure}：系统这次没处理好。请稍后再试。`;
};

export default vtbPlugin;
