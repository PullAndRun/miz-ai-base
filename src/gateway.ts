import { NapLink, type ConnectionState, type Logger as NapLinkLogger } from "@naplink/naplink";
import { z } from "zod";
import { createExpiringCache, readExpiringCache, writeExpiringCache } from "@/cache";
import type { MizConfig } from "@/config";
import type { Logger } from "@/logger";
import type { ForwardMessageContent } from "@/plugins";

export type IncomingMessage = {
  text: string;
  messageType?: string;
  messageId?: number | string;
  groupId?: number | string;
  userId?: number | string;
  raw: Record<string, unknown>;
};

export type ForwardMessageOptions = {
  title?: string;
  source?: string;
  summary?: string;
  senderName?: string;
  senderUin?: number | string;
};

export type MessageSendOptions = {
  timeoutMs?: number;
};

export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

export type GroupMessageUnavailableError = Error & Readonly<{
  groupId: number | string;
}>;

export type GroupSendPermission = Readonly<{
  allowed: boolean;
  wholeBan?: boolean;
  mutedUntil?: number;
}>;

export const createGroupMessageUnavailableError = (
  groupId: number | string,
): GroupMessageUnavailableError => Object.assign(
  new Error(`Group message was not sent because group ${groupId} is muted or its send permission is unavailable`),
  { name: "GroupMessageUnavailableError", groupId },
);

export const isGroupMessageUnavailableError = (error: unknown): error is GroupMessageUnavailableError =>
  error instanceof Error && error.name === "GroupMessageUnavailableError";

export type Gateway = {
  connect(): Promise<void>;
  dispose(): void;
  reportServerInfo(): Promise<void>;
  getGroupList(): Promise<unknown>;
  canMentionAllGroupMembers(groupId: number | string): Promise<boolean>;
  sendGroupMessage(groupId: number | string, message: unknown): Promise<unknown>;
  sendGroupMessageWithoutRetry(
    groupId: number | string,
    message: unknown,
    options?: MessageSendOptions,
  ): Promise<unknown>;
  sendPrivateMessage(userId: number | string, message: unknown): Promise<unknown>;
  sendPrivateMessageWithoutRetry(
    userId: number | string,
    message: unknown,
    options?: MessageSendOptions,
  ): Promise<unknown>;
  sendForwardMessage(
    target: IncomingMessage,
    messages: readonly ForwardMessageContent[],
    options?: ForwardMessageOptions,
  ): Promise<unknown>;
  onMessage(handler: MessageHandler): () => void;
};

const idSchema = z.union([z.string(), z.number()]);
const FOLLOWED_GROUP_MEMBER_ID = "361390990";
const GROUP_PERMISSION_CACHE_MS = 3_000;
const GROUP_PERMISSION_CHECK_TIMEOUT_MS = 5_000;
const MAX_GROUP_PERMISSION_CACHE_ENTRIES = 5_000;
const MESSAGE_DEDUPLICATION_WINDOW_MS = 10 * 60 * 1_000;
const MAX_DEDUPLICATED_MESSAGE_IDS = 5_000;
export const NAPLINK_RECONNECT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

const textSegmentSchema = z
  .looseObject({
    type: z.literal("text"),
    data: z
      .looseObject({
        text: z.string(),
      }),
  });

const napCatEventSchema = z
  .looseObject({
    post_type: z.string().optional(),
    message_type: z.string().optional(),
    notice_type: z.string().optional(),
    request_type: z.string().optional(),
    meta_event_type: z.string().optional(),
    sub_type: z.string().optional(),
    message: z.union([z.string(), z.array(z.unknown())]).optional(),
    raw_message: z.string().optional(),
    message_id: idSchema.optional(),
    group_id: idSchema.optional(),
    user_id: idSchema.optional(),
    self_id: idSchema.optional(),
  });

type NapCatEvent = z.infer<typeof napCatEventSchema>;

export const createGateway = (config: MizConfig, logger: Logger): Gateway => {
  const client = createNapLinkClient(config, logger);
  const messageHandlers = new Set<MessageHandler>();
  const canSendGroupMessage = createGroupSendPermissionChecker(client, logger);
  const canMentionAllGroupMembers = createAtAllPermissionChecker(client, logger);
  let cachedGroupList: unknown[] | undefined;

  registerEvents(client, logger, messageHandlers, canSendGroupMessage, createMessageDeduplicator());

  return {
    connect: () => client.connect(),
    dispose: () => client.dispose(),
    reportServerInfo: () => reportServerInfo(client, logger),
    getGroupList: async () => {
      try {
        const groupList = await client.getGroupList();
        if (Array.isArray(groupList)) {
          cachedGroupList = [...groupList];
        }
        return groupList;
      } catch (error) {
        if (!cachedGroupList) {
          throw error;
        }
        logger.warn("gateway", "group list refresh failed; using last successful result", error);
        return [...cachedGroupList];
      }
    },
    canMentionAllGroupMembers,
    sendGroupMessage: async (groupId, message) => {
      if (!await canSendGroupMessage(groupId)) {
        throw createGroupMessageUnavailableError(groupId);
      }
      return client.sendGroupMessage(groupId, message);
    },
    sendGroupMessageWithoutRetry: async (groupId, message, options) => {
      if (!await canSendGroupMessage(groupId)) {
        throw createGroupMessageUnavailableError(groupId);
      }
      return callApiWithoutRetry(
        client,
        "send_group_msg",
        { group_id: groupId, message },
        options?.timeoutMs,
      );
    },
    sendPrivateMessage: (userId, message) => client.sendPrivateMessage(userId, message),
    sendPrivateMessageWithoutRetry: (userId, message, options) =>
      callApiWithoutRetry(
        client,
        "send_private_msg",
        { user_id: userId, message },
        options?.timeoutMs,
      ),
    sendForwardMessage: (target, messages, options) =>
      sendForwardMessage(client, target, messages, options, canSendGroupMessage),
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
  };
};

const sendForwardMessage = (
  client: NapLink,
  target: IncomingMessage,
  messages: readonly ForwardMessageContent[],
  options: ForwardMessageOptions = {},
  canSendGroupMessage: (groupId: number | string) => Promise<boolean>,
) => {
  const forwardMessages = messages.map((message) => createForwardNode(message, options));

  if (target.groupId !== undefined) {
    return canSendGroupMessage(target.groupId).then((allowed) => {
      if (!allowed) {
        throw createGroupMessageUnavailableError(target.groupId!);
      }
      return client.sendForwardMsg({
        group_id: target.groupId,
        messages: forwardMessages,
        source: options.source,
        summary: options.summary,
        prompt: options.title,
      });
    });
  }

  if (target.userId !== undefined) {
    return client.sendForwardMsg({
      user_id: target.userId,
      messages: forwardMessages,
      source: options.source,
      summary: options.summary,
      prompt: options.title,
    });
  }

  throw new Error("Cannot send forward message: target has no group_id or user_id");
};

const createForwardNode = (message: ForwardMessageContent, options: ForwardMessageOptions) => ({
  type: "node",
  data: {
    name: options.senderName ?? "miz",
    uin: String(options.senderUin ?? 0),
    content:
      typeof message === "string"
        ? [
            {
              type: "text",
              data: {
                text: message,
              },
            },
          ]
        : message,
  },
});

const createNapLinkClient = (config: MizConfig, logger: Logger) =>
  new NapLink({
    connection: {
      url: config.gateway.url,
      token: config.gateway.accessToken,
      timeout: config.naplink.connectTimeoutMs,
      pingInterval: config.naplink.pingIntervalMs,
    },
    reconnect: {
      enabled: true,
      maxAttempts: NAPLINK_RECONNECT_MAX_ATTEMPTS,
    },
    logging: {
      level: config.naplink.logLevel,
      logger: createNapLinkLogger(logger),
    },
    api: {
      timeout: config.naplink.apiTimeoutMs,
      retries: config.naplink.apiRetries,
    },
  });

const createNapLinkLogger = (logger: Logger): NapLinkLogger => ({
  debug: (message, ...metadata) => logger.debug("gateway", message, metadataOrUndefined(metadata)),
  info: (message, ...metadata) => logger.info("gateway", message, metadataOrUndefined(metadata)),
  warn: (message, ...metadata) => {
    if (isIgnorableNapLinkWarning(message)) {
      return;
    }

    logger.warn("gateway", message, metadataOrUndefined(metadata));
  },
  error: (message, error, ...metadata) =>
    logger.error("gateway", message, error ?? metadataOrUndefined(metadata)),
});

const metadataOrUndefined = (metadata: unknown[]) => (metadata.length === 0 ? undefined : metadata);

const isIgnorableNapLinkWarning = (message: string) =>
  message === "收到未知请求的响应: undefined";

const registerEvents = (
  client: NapLink,
  logger: Logger,
  messageHandlers: Set<MessageHandler>,
  canSendGroupMessage: (groupId: number | string) => Promise<boolean>,
  isDuplicateMessage: (message: IncomingMessage) => boolean,
) => {
  client.on("state_change", (state: ConnectionState) => {
    logger.info("gateway", `state=${state}`);
  });

  client.on("connection:lost", (detail) => {
    logger.error("gateway", "connection lost", detail);
  });

  client.on("connection:restored", (detail) => {
    logger.info("gateway", "connection restored", detail);
  });

  client.on("message", (event) => {
    const parsedEvent = napCatEventSchema.safeParse(event);
    if (!parsedEvent.success) {
      logger.warn("gateway", "invalid message event ignored", parsedEvent.error);
      return;
    }

    const message = toIncomingMessage(parsedEvent.data);
    if (isDuplicateMessage(message)) {
      logger.warn("gateway", "duplicate message event ignored", {
        messageId: message.messageId,
        groupId: message.groupId,
        userId: message.userId,
      });
      return;
    }

    logger.info("gateway", `event=${formatEventName(parsedEvent.data)}`);
    notifyMessageHandlers(messageHandlers, message, logger);
  });

  client.on("notice", (event) => {
    const parsedEvent = napCatEventSchema.safeParse(event);
    logger.info("gateway", `event=${parsedEvent.success ? formatEventName(parsedEvent.data) : "unknown"}`);
    if (!parsedEvent.success || !isFollowedMemberLeavingGroup(parsedEvent.data)) {
      if (parsedEvent.success && isNewGroupMember(parsedEvent.data)) {
        void sendNewMemberWelcome(client, parsedEvent.data, logger, canSendGroupMessage).catch(
          (error) => logger.error("gateway", "failed to send new member welcome", {
            groupId: parsedEvent.data.group_id,
            userId: parsedEvent.data.user_id,
            error,
          }),
        );
      }
      return;
    }

    void client.setGroupLeave(parsedEvent.data.group_id!).then(
      () => logger.info("gateway", "left group after followed member left", {
        groupId: parsedEvent.data.group_id,
        userId: parsedEvent.data.user_id,
      }),
      (error) => logger.error("gateway", "failed to leave group after followed member left", {
        groupId: parsedEvent.data.group_id,
        userId: parsedEvent.data.user_id,
        error,
      }),
    );
  });

  client.on("request", (event) => {
    logger.info("gateway", `event=${formatEventNameOrUnknown(event)}`);
  });

  client.on("error", (error) => {
    logger.error("gateway", "error", error);
  });
};

const notifyMessageHandlers = (
  messageHandlers: Set<MessageHandler>,
  message: IncomingMessage,
  logger: Logger,
) => {
  for (const handler of messageHandlers) {
    Promise.resolve(handler(message)).catch((error) => {
      logger.error("gateway", "message handler failed", error);
    });
  }
};

const toIncomingMessage = (event: NapCatEvent): IncomingMessage => ({
  text: extractMessageText(event),
  messageType: event.message_type,
  messageId: event.message_id,
  groupId: event.group_id,
  userId: event.user_id,
  raw: event,
});

const createMessageDeduplicator = () => {
  const seenMessageIds = new Map<string, number>();

  return (message: IncomingMessage) => {
    if (message.messageId === undefined) {
      return false;
    }

    const now = Date.now();
    for (const [key, receivedAt] of seenMessageIds) {
      if (now - receivedAt <= MESSAGE_DEDUPLICATION_WINDOW_MS) {
        break;
      }
      seenMessageIds.delete(key);
    }

    const key = [message.messageType ?? "unknown", message.groupId ?? message.userId ?? "unknown", message.messageId]
      .map(String)
      .join(":");
    if (seenMessageIds.has(key)) {
      return true;
    }

    seenMessageIds.set(key, now);
    if (seenMessageIds.size > MAX_DEDUPLICATED_MESSAGE_IDS) {
      seenMessageIds.delete(seenMessageIds.keys().next().value!);
    }
    return false;
  };
};

type ApiClientWithRetryOptions = {
  call<T>(
    method: string,
    params: Record<string, unknown>,
    options: { retries: number; timeout?: number },
  ): Promise<T>;
};

const callApiWithoutRetry = <T>(
  client: NapLink,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<T> => {
  // NapLink 1.1.0 exposes retry options on ApiClient but not on every public helper.
  // Keep the no-retry path here for non-idempotent sends and lightweight preflight checks.
  const apiClient = (client as unknown as { apiClient?: ApiClientWithRetryOptions }).apiClient;
  if (!apiClient) {
    throw new Error("NapLink API client is unavailable for a no-retry call");
  }

  return apiClient.call<T>(method, params, {
    retries: 0,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
};

const extractMessageText = (event: NapCatEvent) => {
  const message = event.message;
  if (typeof message === "string") {
    return message;
  }

  if (Array.isArray(message)) {
    return message.map(extractSegmentText).join("");
  }

  return event.raw_message ?? "";
};

const extractSegmentText = (segment: unknown) => {
  if (typeof segment === "string") {
    return segment;
  }

  const parsedSegment = textSegmentSchema.safeParse(segment);
  return parsedSegment.success ? parsedSegment.data.data.text : "";
};

const reportServerInfo = async (client: NapLink, logger: Logger) => {
  try {
    const [loginInfo, status] = await Promise.all([client.getLoginInfo(), client.getStatus()]);
    logger.info("gateway", "login info", loginInfo);
    logger.info("gateway", "status", status);
  } catch (error) {
    logger.warn("gateway", "connected, but failed to read server info", error);
  }
};

const formatEventNameOrUnknown = (event: unknown) => {
  const parsedEvent = napCatEventSchema.safeParse(event);
  return parsedEvent.success ? formatEventName(parsedEvent.data) : "unknown";
};

const formatEventName = (event: NapCatEvent) =>
  [
    event.post_type,
    event.message_type ?? event.notice_type ?? event.request_type ?? event.meta_event_type,
    event.sub_type,
  ]
    .filter(Boolean)
    .join(".");

const isFollowedMemberLeavingGroup = (event: NapCatEvent) =>
  event.notice_type === "group_decrease" &&
  event.group_id !== undefined &&
  event.user_id !== undefined &&
  String(event.user_id) === FOLLOWED_GROUP_MEMBER_ID;

const isNewGroupMember = (event: NapCatEvent) =>
  event.notice_type === "group_increase" &&
  event.group_id !== undefined &&
  event.user_id !== undefined &&
  String(event.user_id) !== String(event.self_id);

const sendNewMemberWelcome = async (
  client: NapLink,
  event: NapCatEvent,
  logger: Logger,
  canSendGroupMessage: (groupId: number | string) => Promise<boolean>,
) => {
  const groupId = event.group_id!;
  const userId = event.user_id!;
  const [groupInfo, memberInfo] = await Promise.all([
    client.getGroupInfo(groupId).catch(() => undefined),
    client.getGroupMemberInfo(groupId, userId).catch(() => undefined),
  ]);
  const groupName = getDisplayName(groupInfo, ["group_name", "groupName"]) ?? "本群";
  const memberName = getDisplayName(memberInfo, ["card", "nickname", "nick", "user_name"]) ?? `QQ 用户 ${userId}`;

  if (!await canSendGroupMessage(groupId)) {
    return;
  }
  await client.sendGroupMessage(groupId, createWelcomeMessage(userId, memberName, groupName));
  logger.info("gateway", "new member welcomed", { groupId, userId, groupName, memberName });
};

const createWelcomeMessage = (userId: string | number, memberName: string, groupName: string) => [
  { type: "at", data: { qq: userId } },
  {
    type: "text",
    data: {
      text: ` 欢迎来到「${groupName}」！🎉\n先逛逛群公告和置顶，熟悉之后就自在聊天吧。有活动时，也欢迎一起加入热闹。`,
    },
  },
];

const getDisplayName = (value: unknown, keys: readonly string[], seen = new Set<object>()): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const name = record[key];
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }

  return getDisplayName(record.data, keys, seen);
};

const createGroupSendPermissionChecker = (client: NapLink, logger: Logger) => {
  let selfId: Promise<string | undefined> | undefined;

  const getSelfId = () => {
    if (!selfId) {
      selfId = callApiWithoutRetry<unknown>(
        client,
        "get_login_info",
        {},
        GROUP_PERMISSION_CHECK_TIMEOUT_MS,
      )
        .then((info) => getIdValue(info, ["user_id", "userId", "uin", "qq"]))
        .catch((error) => {
          selfId = undefined;
          logger.warn("gateway", "unable to read bot account for group send permission check", error);
          return undefined;
        });
    }
    return selfId;
  };

  return async (groupId: number | string) => {
    try {
      const botId = await getSelfId();
      if (!botId) {
        logger.warn("gateway", "group send skipped: unable to identify bot account", { groupId });
        return false;
      }

      const [groupInfo, memberInfo] = await Promise.all([
        callApiWithoutRetry<unknown>(
          client,
          "get_group_info",
          { group_id: groupId, no_cache: true },
          GROUP_PERMISSION_CHECK_TIMEOUT_MS,
        ),
        callApiWithoutRetry<unknown>(
          client,
          "get_group_member_info",
          { group_id: groupId, user_id: botId, no_cache: true },
          GROUP_PERMISSION_CHECK_TIMEOUT_MS,
        ),
      ]);
      return getGroupSendPermission(groupInfo, memberInfo).allowed;
    } catch (error) {
      logger.warn("gateway", "group send skipped: unable to read mute status", { groupId, error });
      return false;
    }
  };
};

export const getGroupSendPermission = (
  groupInfo: unknown,
  memberInfo: unknown,
  nowSeconds = Math.floor(Date.now() / 1_000),
): GroupSendPermission => {
  const wholeBan = getOptionalNonZeroBooleanValue(groupInfo, [
    "whole_ban",
    "wholeBan",
    "group_all_shut",
    "groupAllShut",
    "is_all_shut",
    "isAllShut",
    "shut_up_all",
    "shutUpAll",
  ]);
  const mutedUntil = getNumberValue(memberInfo, ["shut_up_timestamp", "shutUpTimestamp"]);
  const role = getStringValue(memberInfo, ["role"]);
  const bypassesWholeBan = role === "admin" || role === "owner";

  return {
    allowed: wholeBan !== undefined
      && (!wholeBan || bypassesWholeBan)
      && mutedUntil !== undefined
      && mutedUntil <= nowSeconds,
    wholeBan,
    mutedUntil,
  };
};

const createAtAllPermissionChecker = (client: NapLink, logger: Logger) => {
  let cache = createExpiringCache<string, boolean>(MAX_GROUP_PERMISSION_CACHE_ENTRIES);
  let selfId: Promise<string | undefined> | undefined;
  const cachePermission = (key: string, allowed: boolean) => {
    cache = writeExpiringCache(cache, key, allowed, GROUP_PERMISSION_CACHE_MS, Date.now());
  };

  const getSelfId = () => {
    if (!selfId) {
      selfId = client.getLoginInfo()
        .then((info) => getIdValue(info, ["user_id", "userId", "uin", "qq"]))
        .catch((error) => {
          selfId = undefined;
          logger.warn("gateway", "unable to read bot account for @all permission check", error);
          return undefined;
        });
    }
    return selfId;
  };

  return async (groupId: number | string) => {
    const key = String(groupId);
    const cacheRead = readExpiringCache(cache, key, Date.now());
    cache = cacheRead.cache;
    const cached = cacheRead.value;
    if (cached !== undefined) {
      return cached;
    }

    try {
      const botId = await getSelfId();
      if (!botId) {
        return false;
      }

      const memberInfo = await client.getGroupMemberInfo(groupId, botId);
      const role = getStringValue(memberInfo, ["role"]);
      const hasRole = role === "admin" || role === "owner";
      if (!hasRole) {
        logger.info("gateway", "@all unavailable: bot is not a group owner or administrator", { groupId, role });
        cachePermission(key, false);
        return false;
      }

      try {
        const remaining = await client.getGroupAtAllRemain(groupId);
        const allowed = isGroupAtAllAvailable(remaining);
        if (!allowed) {
          logger.info("gateway", "@all unavailable: group quota exhausted", { groupId, role, remaining });
        }
        cachePermission(key, allowed);
        return allowed;
      } catch (error) {
        // Older NapCat versions can lack this optional action. The role is
        // still sufficient to preserve the previous @all behavior.
        logger.warn("gateway", "unable to read @all quota; falling back to role check", { groupId, role, error });
        cachePermission(key, true);
        return true;
      }
    } catch (error) {
      // @all is optional: if its permission cannot be verified, keep the live notification ordinary.
      logger.warn("gateway", "@all permission check failed; sending ordinary group message", { groupId, error });
      return false;
    }
  };
};

export const isGroupAtAllAvailable = (value: unknown) => {
  if (typeof value === "number") {
    return value > 0;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const canAtAll = getOptionalBooleanValue(record, ["can_at_all", "canAtAll"]);
  const groupRemaining = getNumberValue(record, [
    "remain_at_all_count_for_group",
    "remainAtAllCountForGroup",
  ]);
  const accountRemaining = getNumberValue(record, [
    "remain_at_all_count_for_uin",
    "remainAtAllCountForUin",
  ]);
  if (canAtAll !== undefined) {
    if (!canAtAll) {
      return false;
    }
    return groupRemaining !== 0 && accountRemaining !== 0;
  }
  if (groupRemaining === undefined && accountRemaining === undefined) {
    return false;
  }
  return (groupRemaining ?? 0) > 0 && (accountRemaining ?? 0) > 0;
};

const getIdValue = (value: unknown, keys: readonly string[]) => {
  const raw = getValue(value, keys);
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
};

const getNumberValue = (value: unknown, keys: readonly string[]) => {
  const raw = getValue(value, keys);
  const number = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};

const getStringValue = (value: unknown, keys: readonly string[]) => {
  const raw = getValue(value, keys);
  return typeof raw === "string" ? raw : undefined;
};

const getOptionalNonZeroBooleanValue = (value: unknown, keys: readonly string[]) => {
  const raw = getValue(value, keys);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw !== 0 : undefined;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    if (normalized) {
      const number = Number(normalized);
      return Number.isFinite(number) ? number !== 0 : undefined;
    }
  }
  return undefined;
};

const getOptionalBooleanValue = (value: unknown, keys: readonly string[]) => {
  const raw = getValue(value, keys);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw === 1 || raw === "1" || raw === "true") {
    return true;
  }
  if (raw === 0 || raw === "0" || raw === "false") {
    return false;
  }
  return undefined;
};

const getValue = (value: unknown, keys: readonly string[], seen = new Set<object>()): unknown => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return getValue(record.data, keys, seen);
};
