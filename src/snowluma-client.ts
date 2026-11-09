import {
  SnowLumaWebSocketClient,
  type OneBotMessageEvent,
  type OneBotNoticeEvent,
  type OneBotRequestEvent,
  type OutgoingMessage,
  type RequestOptions,
  type SnowLumaEvent,
  type WebSocketConstructor,
} from "@snowluma/sdk";
import type { Logger } from "@/logger";

export type SnowLumaGatewayClientEvents = {
  state_change: string;
  "connection:lost": unknown;
  "connection:restored": unknown;
  message: unknown;
  message_sent: unknown;
  notice: unknown;
  request: unknown;
  error: unknown;
};

type EventKey = keyof SnowLumaGatewayClientEvents;
type EventListenerMap = Map<EventKey, Set<(payload: unknown) => void>>;

export type SnowLumaGatewayClientOptions = Readonly<{
  url: string;
  accessToken: string;
  requestTimeoutMs: number;
  logger: Logger;
}>;

const toNumericId = (value: number | string) => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`SnowLuma does not support non-numeric target ID: ${value}`);
  }
  return numeric;
};

const requestOptions = (timeoutMs?: number): RequestOptions | undefined =>
  timeoutMs === undefined ? undefined : { timeoutMs };

/**
 * Thin adapter around the official SnowLuma SDK.
 *
 * The rest of miz deliberately keeps a small OneBot-facing client surface so
 * gateway policy (permission checks, media fallback) does not depend on the
 * transport implementation. This adapter is the only place that knows about
 * SnowLuma's SDK event names and typed API.
 */
export const createSnowLumaGatewayClient = (options: SnowLumaGatewayClientOptions) => {
  const listeners: EventListenerMap = new Map();
  let connectedOnce = false;

  const webSocket = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
  if (!webSocket) {
    throw new Error("SnowLuma SDK requires a WebSocket implementation");
  }

  const client = new SnowLumaWebSocketClient({
    url: options.url,
    accessToken: options.accessToken,
    requestTimeoutMs: options.requestTimeoutMs,
    reconnect: {
      minDelayMs: 1_000,
      maxDelayMs: 30_000,
    },
    webSocket,
  });

  const emit = <K extends EventKey>(event: K, payload: SnowLumaGatewayClientEvents[K]) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        options.logger.error("gateway", `SnowLuma ${event} listener failed`, error);
      }
    }
  };

  const handleOpen = () => {
    const restored = connectedOnce;
    connectedOnce = true;
    emit("state_change", "connected");
    if (restored) {
      emit("connection:restored", undefined);
    }
  };

  const handleClose = (info: unknown) => {
    emit("state_change", "disconnected");
    emit("connection:lost", info);
  };

  const dispatchEvent = (event: SnowLumaEvent) => {
    switch (event.post_type) {
      case "message":
      case "message_sent":
        emit(event.post_type, event as OneBotMessageEvent);
        return;
      case "notice":
        emit("notice", event as OneBotNoticeEvent);
        return;
      case "request":
        emit("request", event as OneBotRequestEvent);
        return;
      default:
        return;
    }
  };

  client.on("open", handleOpen);
  client.on("close", handleClose);
  client.on("error", (error) => emit("error", error));
  client.onEvent(dispatchEvent);

  const callApi = <T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    client.raw(
      action as never,
      params as never,
      requestOptions(timeoutMs ?? options.requestTimeoutMs) as never,
    ) as Promise<T>;

  const getLoginInfo = () => client.getLoginInfo(requestOptions(options.requestTimeoutMs));

  const getStatus = () => client.getStatus(requestOptions(options.requestTimeoutMs));

  const getGroupList = () => client.getGroupList(requestOptions(options.requestTimeoutMs));

  const getGroupInfo = (groupId: number | string, noCache = false) =>
    client.getGroupInfo(toNumericId(groupId), noCache ? { noCache: true } : requestOptions(options.requestTimeoutMs));

  const getGroupMemberInfo = (groupId: number | string, userId: number | string, noCache = false) =>
    client.getGroupMemberInfo(
      toNumericId(groupId),
      toNumericId(userId),
      noCache ? { noCache: true } : requestOptions(options.requestTimeoutMs),
    );

  return {
    connect: () => client.connect(),
    close: () => client.close(),
    on: <K extends EventKey>(event: K, listener: (payload: SnowLumaGatewayClientEvents[K]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      eventListeners.add(listener as (payload: unknown) => void);
      listeners.set(event, eventListeners);

      return () => {
        eventListeners.delete(listener as (payload: unknown) => void);
        if (eventListeners.size === 0) {
          listeners.delete(event);
        }
      };
    },
    callApi,
    getLoginInfo,
    getStatus,
    getGroupList,
    getGroupInfo,
    getGroupMemberInfo,
    getGroupAtAllRemain: (groupId: number | string) =>
      callApi<unknown>("get_group_at_all_remain", {
        group_id: toNumericId(groupId),
      }),
    sendGroupMessage: (groupId: number | string, message: unknown, timeoutMs?: number) =>
      client.sendGroupMessage(toNumericId(groupId), message as OutgoingMessage, requestOptions(timeoutMs)),
    sendPrivateMessage: (userId: number | string, message: unknown, timeoutMs?: number) =>
      client.sendPrivateMessage(toNumericId(userId), message as OutgoingMessage, requestOptions(timeoutMs)),
    sendForwardMsg: (params: Record<string, unknown>, timeoutMs?: number) =>
      callApi<unknown>("send_forward_msg", params, timeoutMs),
    setGroupLeave: (groupId: number | string) =>
      callApi<unknown>("set_group_leave", { group_id: toNumericId(groupId) }),
  };
};

export type SnowLumaGatewayClient = ReturnType<typeof createSnowLumaGatewayClient>;
