import { NapLink, type ConnectionState, type Logger as NapLinkLogger } from "@naplink/naplink";
import { z } from "zod";
import type { MizConfig } from "@/config";
import type { Logger } from "@/logger";
import type { ForwardMessageContent } from "@/plugins";

export type IncomingMessage = {
  text: string;
  messageType?: string;
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

export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

export type Gateway = {
  connect(): Promise<void>;
  dispose(): void;
  reportServerInfo(): Promise<void>;
  getGroupList(): Promise<unknown>;
  sendGroupMessage(groupId: number | string, message: unknown): Promise<unknown>;
  sendPrivateMessage(userId: number | string, message: unknown): Promise<unknown>;
  sendForwardMessage(
    target: IncomingMessage,
    messages: readonly ForwardMessageContent[],
    options?: ForwardMessageOptions,
  ): Promise<unknown>;
  onMessage(handler: MessageHandler): () => void;
};

const idSchema = z.union([z.string(), z.number()]);
const FOLLOWED_GROUP_MEMBER_ID = "361390990";

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
    group_id: idSchema.optional(),
    user_id: idSchema.optional(),
    self_id: idSchema.optional(),
  });

type NapCatEvent = z.infer<typeof napCatEventSchema>;

export const createGateway = (config: MizConfig, logger: Logger): Gateway => {
  const client = createNapLinkClient(config, logger);
  const messageHandlers = new Set<MessageHandler>();

  registerEvents(client, logger, messageHandlers);

  return {
    connect: () => client.connect(),
    dispose: () => client.dispose(),
    reportServerInfo: () => reportServerInfo(client, logger),
    getGroupList: () => client.getGroupList(),
    sendGroupMessage: (groupId, message) => client.sendGroupMessage(groupId, message),
    sendPrivateMessage: (userId, message) => client.sendPrivateMessage(userId, message),
    sendForwardMessage: (target, messages, options) => sendForwardMessage(client, target, messages, options),
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
) => {
  const forwardMessages = messages.map((message) => createForwardNode(message, options));

  if (target.groupId !== undefined) {
    return client.sendForwardMsg({
      group_id: target.groupId,
      messages: forwardMessages,
      source: options.source,
      summary: options.summary,
      prompt: options.title,
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
      maxAttempts: config.naplink.reconnectMaxAttempts,
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

    logger.info("gateway", `event=${formatEventName(parsedEvent.data)}`);
    notifyMessageHandlers(messageHandlers, toIncomingMessage(parsedEvent.data), logger);
  });

  client.on("notice", (event) => {
    const parsedEvent = napCatEventSchema.safeParse(event);
    logger.info("gateway", `event=${parsedEvent.success ? formatEventName(parsedEvent.data) : "unknown"}`);
    if (!parsedEvent.success || !isFollowedMemberLeavingGroup(parsedEvent.data)) {
      if (parsedEvent.success && isNewGroupMember(parsedEvent.data)) {
        void sendNewMemberWelcome(client, parsedEvent.data, logger).catch(
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
  groupId: event.group_id,
  userId: event.user_id,
  raw: event,
});

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

const sendNewMemberWelcome = async (client: NapLink, event: NapCatEvent, logger: Logger) => {
  const groupId = event.group_id!;
  const userId = event.user_id!;
  const [groupInfo, memberInfo] = await Promise.all([
    client.getGroupInfo(groupId).catch(() => undefined),
    client.getGroupMemberInfo(groupId, userId).catch(() => undefined),
  ]);
  const groupName = getDisplayName(groupInfo, ["group_name", "groupName"]) ?? "本群";
  const memberName = getDisplayName(memberInfo, ["card", "nickname", "nick", "user_name"]) ?? `QQ 用户 ${userId}`;

  await client.sendGroupMessage(groupId, createWelcomeMessage(userId, memberName, groupName));
  logger.info("gateway", "new member welcomed", { groupId, userId, groupName, memberName });
};

const createWelcomeMessage = (userId: string | number, memberName: string, groupName: string) => [
  { type: "at", data: { qq: userId } },
  {
    type: "text",
    data: {
      text: ` 欢迎 ${memberName} 加入「${groupName}」！\n很高兴在这里遇见你。先看看群公告和置顶消息，之后就自在聊天吧。`,
    },
  },
];

const getDisplayName = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const name = record[key];
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }
  }

  return getDisplayName(record.data, keys);
};
