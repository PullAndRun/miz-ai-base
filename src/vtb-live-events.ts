import { brotliDecompressSync, inflateSync } from "node:zlib";
import type { Logger } from "@/logger";
import type { VtbConfig } from "@/config";
import type { VtbContributionEvent, VtbRepository } from "@/vtb";
import { fetchWithRiskControlProxy, fetchWithRetry } from "@/http";

type Target = { mid: string; streamerName: string; roomId: string; sessionStart: Date; contributionGroupIds: Array<string | number> };
type Connection = Target & { socket: any; heartbeat?: ReturnType<typeof setInterval>; reconnectAttempt: number };
export type VtbLiveEventNotification = VtbContributionEvent & {
  itemName?: string;
  roleName?: string;
  groupIds: Array<string | number>;
  streamerName: string;
  roomId: string;
};

const DEFAULT_ENDPOINT = "wss://broadcastlv.chat.bilibili.com:443/sub";
const HEARTBEAT_INTERVAL_MS = 25_000;
const SOCKET_OPEN_TIMEOUT_MS = 15_000;
const MAX_PENDING_EVENT_HANDLERS = 128;
const BACKLOG_WARNING_INTERVAL_MS = 60_000;

/** Maintains a small, rate-limited set of live-room event connections. */
export const createVtbLiveEventManager = (
  config: VtbConfig,
  repository: VtbRepository,
  logger: Logger,
  notify?: (event: VtbLiveEventNotification) => Promise<void>,
) => {
  const targets = new Map<string, Target>();
  const connections = new Map<string, Connection>();
  const opening = new Set<string>();
  const queued = new Set<string>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const pendingWrites = new Map<string, Set<Promise<unknown>>>();
  const eventChains = new Map<string, Promise<void>>();
  const backlogWarningAt = new Map<string, number>();
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const pump = () => {
    if (stopped || connectTimer || connections.size + opening.size >= config.liveEventMaxConnections) return;
    for (const mid of queued) {
      if (!targets.has(mid)) queued.delete(mid);
    }
    const next = [...queued].map((mid) => targets.get(mid)).find(Boolean);
    if (!next) return;
    queued.delete(next.mid);
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      void open(next);
    }, config.liveEventConnectIntervalMs + Math.floor(Math.random() * 500));
  };

  const open = async (target: Target) => {
    if (stopped || targets.get(target.mid) !== target || connections.has(target.mid) || opening.has(target.mid)) {
      pump();
      return;
    }
    opening.add(target.mid);
    let socket: any;
    let token = "";
    try {
      const WebSocketCtor = (globalThis as any).WebSocket;
      if (!WebSocketCtor) throw new Error("WebSocket is not available in this runtime");
      const connectionInfo = await getConnectionInfo(target.roomId);
      token = connectionInfo.token;
      if (stopped || targets.get(target.mid) !== target) {
        opening.delete(target.mid);
        pump();
        return;
      }
      socket = new WebSocketCtor(config.liveEventApiUrl || connectionInfo.endpoint || DEFAULT_ENDPOINT);
    } catch (error) {
      opening.delete(target.mid);
      logger.warn("plugin", "vtb live event connection unavailable", { streamerMid: target.mid, error: normalize(error) });
      scheduleReconnect(target.mid);
      pump();
      return;
    }
    if (stopped || !targets.has(target.mid)) {
      opening.delete(target.mid);
      pump();
      try { socket.close(); } catch { /* already closed */ }
      return;
    }
    opening.delete(target.mid);
    const connection: Connection = { ...target, socket, reconnectAttempt: 0 };
    connections.set(target.mid, connection);
    socket.binaryType = "arraybuffer";
    let socketOpened = false;
    const openTimer = setTimeout(() => {
      if (!socketOpened) {
        try { socket.close(); } catch { /* close handler schedules retry */ }
      }
    }, SOCKET_OPEN_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      socketOpened = true;
      clearTimeout(openTimer);
      connection.reconnectAttempt = 0;
      reconnectAttempts.delete(target.mid);
      socket.send(createAuthPacket(target.roomId, token));
      connection.heartbeat = setInterval(() => {
        try { socket.send(createHeartbeatPacket()); } catch { /* close handler retries */ }
      }, HEARTBEAT_INTERVAL_MS);
      logger.debug("plugin", "vtb live event connection opened", { streamerMid: target.mid });
    });
    socket.addEventListener("message", (event: any) => {
      const pending = pendingWrites.get(target.mid);
      if (pending && pending.size >= MAX_PENDING_EVENT_HANDLERS) {
        const now = Date.now();
        const lastWarning = backlogWarningAt.get(target.mid) ?? 0;
        if (now - lastWarning >= BACKLOG_WARNING_INTERVAL_MS) {
          backlogWarningAt.set(target.mid, now);
          logger.warn("plugin", "vtb live event backlog is full; packet skipped", {
            streamerMid: target.mid,
            pending: pending.size,
          });
        }
        return;
      }
      const operation = consumeMessage(connection, event.data).catch((error) => {
        logger.debug("plugin", "vtb live event packet ignored", { streamerMid: target.mid, error: normalize(error) });
      });
      const previous = eventChains.get(target.mid) ?? Promise.resolve();
      const serialized = previous
        .catch(() => undefined)
        .then(() => operation);
      eventChains.set(target.mid, serialized);
      const operations = pending ?? new Set<Promise<unknown>>();
      operations.add(serialized);
      pendingWrites.set(target.mid, operations);
      void serialized.then(
        () => {
          operations.delete(serialized);
          if (eventChains.get(target.mid) === serialized) eventChains.delete(target.mid);
        },
        () => {
          operations.delete(serialized);
          if (eventChains.get(target.mid) === serialized) eventChains.delete(target.mid);
        },
      );
    });
    const close = () => {
      clearTimeout(openTimer);
      if (connection.heartbeat) clearInterval(connection.heartbeat);
      if (connections.get(target.mid) === connection) connections.delete(target.mid);
      if (targets.has(target.mid) && !stopped) scheduleReconnect(target.mid);
      pump();
    };
    socket.addEventListener("close", close);
    socket.addEventListener("error", () => { try { socket.close(); } catch { close(); } });
    pump();
  };

  const getConnectionInfo = async (roomId: string): Promise<{ endpoint?: string; token: string }> => {
    const url = new URL(config.liveEventTokenApiUrl || "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo");
    url.searchParams.set("id", roomId);
    const response = await fetchWithRiskControlProxy(
      (proxy) => fetchWithRetry(url, {
        ...(proxy ? { proxy } : {}),
        timeoutMs: 10_000,
        retryCount: 1,
        retryDelayMs: 1_000,
        retryRateLimited: false,
      }),
      config.proxyUrl,
    );
    const payload: any = await response.json();
    const data = payload?.data;
    const host = Array.isArray(data?.host_list) ? data.host_list.find((entry: any) => entry?.host) : undefined;
    const endpoint = host?.host ? `wss://${host.host}:${Number(host.wss_port || 443)}/sub` : undefined;
    const token = typeof data?.token === "string" ? data.token : "";
    if (!token) throw new Error("Bilibili live event token is missing");
    return { endpoint, token };
  };

  const scheduleReconnect = (mid: string) => {
    const target = targets.get(mid);
    if (!target || stopped || queued.has(mid) || reconnectTimers.has(mid)) return;
    const attempt = (reconnectAttempts.get(mid) ?? 0) + 1;
    reconnectAttempts.set(mid, attempt);
    const delay = Math.min(config.liveEventReconnectMaxMs,
      config.liveEventReconnectBaseMs * 2 ** Math.min(8, Math.max(0, attempt - 1)) + Math.floor(Math.random() * 2_000));
    const timer = setTimeout(() => {
      reconnectTimers.delete(mid);
      if (targets.has(mid)) {
        queued.add(mid);
        pump();
      }
    }, delay);
    reconnectTimers.set(mid, timer);
  };

  const start = (mid: string, streamerName: string, roomId: string | undefined, sessionStart: Date, contributionGroupIds: readonly (string | number)[] = []) => {
    if (!config.liveEventEnabled || !roomId || stopped) return;
    const nextTarget = { mid, streamerName, roomId, sessionStart, contributionGroupIds: [...contributionGroupIds] };
    targets.set(mid, nextTarget);
    const connection = connections.get(mid);
    if (connection) {
      connection.roomId = roomId;
      connection.streamerName = streamerName;
      connection.sessionStart = sessionStart;
      connection.contributionGroupIds = [...contributionGroupIds];
    }
    if (!connections.has(mid)) {
      queued.add(mid);
      pump();
    }
  };

  const stop = (mid: string) => {
    targets.delete(mid);
    queued.delete(mid);
    const reconnectTimer = reconnectTimers.get(mid);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimers.delete(mid);
    }
    reconnectAttempts.delete(mid);
    backlogWarningAt.delete(mid);
    const connection = connections.get(mid);
    if (connection) {
      connections.delete(mid);
      if (connection.heartbeat) clearInterval(connection.heartbeat);
      try { connection.socket.close(); } catch { /* already closed */ }
    }
    pump();
  };

  const flush = async (mid: string) => {
    await eventChains.get(mid);
    const pending = pendingWrites.get(mid);
    if (pending && pending.size > 0) await Promise.allSettled([...pending]);
    pendingWrites.delete(mid);
  };

  const stopAll = async () => {
    stopped = true;
    if (connectTimer) clearTimeout(connectTimer);
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    for (const mid of [...targets.keys()]) stop(mid);
    await Promise.all([...pendingWrites.keys()].map((mid) => flush(mid)));
    targets.clear();
  };

  return { start, stop, flush, stopAll };

  async function consumeMessage(connection: Connection, value: unknown) {
    const bytes = await toBytes(value);
    for (const packet of unpack(bytes)) {
      if (packet.operation !== 5 || !packet.body) continue;
      const payload = parseJson(packet.body);
      if (!payload || typeof payload !== "object") continue;
      const command = String((payload as any).cmd ?? "");
      const data = (payload as any).data ?? {};
      const isRedPacket = command === "POPULARITY_RED_POCKET_START" || command === "POPULARITY_RED_POCKET_NEW" || command === "RED_POCKET_START";
      const uid = text(data.uid ?? data.mid ?? data.sender_uid ?? data.senderUid ?? (isRedPacket ? "red-packet" : ""));
      const userName = text(data.uname ?? data.username) || uid || "观众";
      if (!uid) continue;
      let kind: VtbContributionEvent["kind"] | undefined;
      let amount = 0;
      let count = 1;
      let itemName: string | undefined;
      let roleName: string | undefined;
      if (isRedPacket) {
        kind = "red-packet";
        itemName = text(data.award_text ?? data.awardText ?? data.danmu ?? data.title) || "直播间红包";
        amount = finiteNumber(data.total_money ?? data.totalMoney ?? data.amount);
        count = finiteNumber(data.total_num ?? data.totalNum ?? data.num, 1) || 1;
      } else if (command === "USER_TOAST_MSG") {
        const operation = Number(data.op_type);
        kind = operation === 2 ? "guard-renewal" : operation === 1 ? "guard-activation" : undefined;
        amount = finiteNumber(data.price);
        count = finiteNumber(data.num, 1) || 1;
        roleName = text(data.role_name ?? data.roleName) || undefined;
      } else if (command === "SEND_GIFT" || command === "COMBO_SEND") {
        kind = "gift";
        count = finiteNumber(data.num ?? data.combo_num, 1) || 1;
        amount = finiteNumber(data.total_coin) || finiteNumber(data.price) * count;
        itemName = text(data.gift_name ?? data.giftName) || undefined;
      } else if (command === "SUPER_CHAT_MESSAGE") {
        kind = "super-chat";
        amount = finiteNumber(data.price) * 1_000;
      }
      if (!kind) continue;
      amount = Math.max(0, finiteNumber(amount));
      count = Math.max(1, Math.round(finiteNumber(count, 1)));
      const eventId = text(data.payflow_id ?? data.tid ?? data.rpid ?? data.lottery_id ?? data.lotteryId ?? data.message_id ?? data.msg_id) ||
        `${command}:${uid}:${text(data.start_time ?? data.ts) || Date.now()}:${amount}:${count}`;
      const recorded = await repository.recordLiveContributionEvent({
        eventId,
        streamerMid: connection.mid,
        sessionStart: connection.sessionStart,
        userId: uid,
        userName,
        kind,
        amount,
        count,
        itemName,
        roleName,
        occurredAt: new Date(),
      });
      // Gifts and Super Chats are queued so the task layer can aggregate them
      // across the quiet window before applying the RMB threshold.
      if (recorded && notify) {
        await notify({
          eventId,
          streamerMid: connection.mid,
          sessionStart: connection.sessionStart,
          userId: uid,
          userName,
          kind,
          amount,
          count,
          itemName,
          roleName,
          occurredAt: new Date(),
          groupIds: connection.contributionGroupIds,
          streamerName: connection.streamerName,
          roomId: connection.roomId,
        });
      }
    }
  }
};

const createPacket = (operation: number, body: Uint8Array) => {
  const packet = new ArrayBuffer(body.length + 16);
  const view = new DataView(packet);
  view.setUint32(0, packet.byteLength);
  view.setUint16(4, 16);
  view.setUint16(6, 1);
  view.setUint32(8, operation);
  view.setUint32(12, 1);
  new Uint8Array(packet, 16).set(body);
  return packet;
};

const createAuthPacket = (roomId: string, token: string) => createPacket(7, new TextEncoder().encode(JSON.stringify({ uid: 0, roomid: Number(roomId), protover: 3, platform: "web", type: 2, key: token })));
const createHeartbeatPacket = () => createPacket(2, new TextEncoder().encode("[object Object]"));

const unpack = (bytes: Uint8Array): Array<{ operation: number; body?: Uint8Array }> => {
  const packets: Array<{ operation: number; body?: Uint8Array }> = [];
  for (let offset = 0; offset + 16 <= bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const length = view.getUint32(0);
    if (length < 16 || offset + length > bytes.length) break;
    const protocol = view.getUint16(6);
    const operation = view.getUint32(8);
    const body = bytes.slice(offset + 16, offset + length);
    if (protocol === 2) packets.push(...unpack(new Uint8Array(inflateSync(body))));
    else if (protocol === 3) packets.push(...unpack(new Uint8Array(brotliDecompressSync(body))));
    else packets.push({ operation, body });
    offset += length;
  }
  return packets;
};

const parseJson = (body: Uint8Array) => {
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { return undefined; }
};

const toBytes = async (value: unknown): Promise<Uint8Array> => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error("unsupported websocket message payload");
};

const text = (value: unknown) => value === undefined || value === null ? "" : String(value);
const finiteNumber = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const normalize = (error: unknown) => error instanceof Error ? error.message : String(error);
