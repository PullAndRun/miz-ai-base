import { brotliDecompressSync, inflateSync } from "node:zlib";
import type { Logger } from "@/logger";
import type { VtbConfig } from "@/config";
import type { VtbContributionEvent, VtbRepository } from "@/vtb";
import { signBilibiliUrl } from "@/vtb";
import { fetchWithRiskControlProxy, fetchWithRetry, readResponseJson } from "@/http";
import { getBilibiliCredential, getBilibiliCredentialHeader } from "@/bilibili-credential";

// One target (and therefore one connection) is maintained per streamer MID.
// Group IDs are only used to fan out real-time notifications; all parsed
// contribution events are persisted before notification filtering.
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
const GUARD_DEDUP_BUCKET_MS = 10_000;
// A live packet is normally a few KB. Keep malformed frames and compressed
// payloads from allocating unbounded memory before they reach the parser.
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_PACKET_NESTING = 4;
const MAX_TOKEN_RESPONSE_BYTES = 1 * 1024 * 1024;

/** A contribution subscription is the sole opt-in for real-time event pushes. */
export const shouldNotifyVtbContribution = (groupIds: readonly (string | number)[]) => groupIds.length > 0;

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
    let authUid = 0;
    let authBuvid3: string | undefined;
    try {
      const WebSocketCtor = (globalThis as any).WebSocket;
      if (!WebSocketCtor) throw new Error("WebSocket is not available in this runtime");
      const connectionInfo = await getConnectionInfo(target.roomId);
      token = connectionInfo.token;
      authUid = connectionInfo.uid;
      authBuvid3 = connectionInfo.buvid3;
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
      try {
        socket.send(createAuthPacket(target.roomId, token, authUid, authBuvid3));
      } catch (error) {
        logger.warn("plugin", "vtb live event authentication failed", {
          streamerMid: target.mid,
          error: normalize(error),
        });
        try { socket.close(); } catch { close(); }
        return;
      }
      connection.heartbeat = setInterval(() => {
        try { socket.send(createHeartbeatPacket()); } catch { /* close handler retries */ }
      }, HEARTBEAT_INTERVAL_MS);
      logger.info("plugin", "vtb live event connection opened", { streamerMid: target.mid, roomId: target.roomId });
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
      const previous = eventChains.get(target.mid) ?? Promise.resolve();
      // Do not start parsing until the previous packet has completed. Creating
      // the promise before chaining it would execute consumeMessage eagerly
      // and only serialize the already-running promise afterward.
      const serialized = previous
        .catch(() => undefined)
        .then(() => consumeMessage(connection, event.data).catch((error) => {
          logger.debug("plugin", "vtb live event packet ignored", { streamerMid: target.mid, error: normalize(error) });
        }));
      eventChains.set(target.mid, serialized);
      const operations = pending ?? new Set<Promise<unknown>>();
      operations.add(serialized);
      pendingWrites.set(target.mid, operations);
      const finish = () => {
        operations.delete(serialized);
        if (eventChains.get(target.mid) === serialized) eventChains.delete(target.mid);
        if (operations.size === 0 && pendingWrites.get(target.mid) === operations) {
          pendingWrites.delete(target.mid);
        }
      };
      void serialized.then(
        finish,
        finish,
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

  const getConnectionInfo = async (roomId: string): Promise<{ endpoint?: string; token: string; uid: number; buvid3?: string }> => {
    const url = new URL(config.liveEventTokenApiUrl || "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo");
    url.searchParams.set("id", roomId);
    if (url.hostname.endsWith("bilibili.com")) {
      const signedUrl = await signBilibiliUrl(url.href, config);
      url.href = signedUrl;
    }
    const credentialHeader = await getBilibiliCredentialHeader().catch(() => undefined);
    const payload: any = await fetchWithRiskControlProxy(
      async (proxy) => {
        const response = await fetchWithRetry(url, {
        ...(proxy ? { proxy } : {}),
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          referer: "https://live.bilibili.com/",
          ...(credentialHeader ? { Cookie: credentialHeader } : {}),
        },
        timeoutMs: 10_000,
        retryCount: 1,
        retryDelayMs: 1_000,
        retryRateLimited: false,
        });
        const value = await readResponseJson(response, MAX_TOKEN_RESPONSE_BYTES) as Record<string, any>;
        if (Number(value?.code) !== 0) {
          throw new Error(`Bilibili live event token API returned code ${String(value?.code ?? "unknown")}`);
        }
        return value;
      },
      config.proxyUrl,
    );
    const data = payload?.data;
    const host = Array.isArray(data?.host_list) ? data.host_list.find((entry: any) => entry?.host) : undefined;
    const hostName = typeof host?.host === "string" && host.host.trim() ? host.host.trim() : undefined;
    const port = Number(host?.wss_port ?? 443);
    const endpoint = hostName && Number.isInteger(port) && port > 0 && port <= 65_535
      ? `wss://${hostName}:${port}/sub`
      : undefined;
    const token = typeof data?.token === "string" ? data.token : "";
    if (!token) throw new Error("Bilibili live event token is missing");
    const credential = await getBilibiliCredential().catch(() => undefined);
    const uid = Number(credential?.dedeUserId);
    return { endpoint, token, uid: Number.isFinite(uid) && uid > 0 ? uid : 0, buvid3: credential?.buvid3 };
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
    logger.info("plugin", "vtb live event listener scheduled", { streamerMid: mid, roomId, groupIds: contributionGroupIds });
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
      const rawData = (payload as any).data ?? {};
      const data = typeof rawData === "string"
        ? (() => { try { return JSON.parse(rawData); } catch { return {}; } })()
        : rawData;
      // Some protocol variants append routing/version suffixes (for example
      // DANMU_MSG:4:0:2). Match the stable command prefix.
      const commandName = command.split(":", 1)[0];
      if (commandName === "SEND_GIFT" || commandName === "SEND_GIFT_V2" || commandName === "COMBO_SEND" || commandName === "USER_TOAST_MSG" || commandName === "USER_TOAST_MSG_V2" || commandName === "GUARD_BUY" || commandName === "SUPER_CHAT_MESSAGE" || commandName === "SUPER_CHAT_MESSAGE_JPN") {
        logger.info("plugin", "vtb live event received", {
          streamerMid: connection.mid,
          command: commandName,
          dataKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 20) : [],
        });
      }
      const decodedGiftPayloads = commandName === "SEND_GIFT_V2" ? decodeSendGiftV2Payload(data) : [];
      // Gateway deployments disagree on whether V2 is protobuf-wrapped or a
      // normal JSON object. Preserve the JSON form when protobuf decoding is
      // unavailable instead of silently dropping the contribution.
      const eventPayloads = commandName === "SEND_GIFT_V2" && decodedGiftPayloads.length > 0
        ? decodedGiftPayloads
        : [data];
      if (commandName === "SEND_GIFT_V2" && decodedGiftPayloads.length === 0 &&
        data && typeof data === "object" && !Array.isArray(data) &&
        typeof (data as any).pb === "string" && (data as any).pb.length > 0) {
        logger.warn("plugin", "vtb SEND_GIFT_V2 payload could not be decoded", { streamerMid: connection.mid });
      }
      for (const eventData of eventPayloads) {
      const data = commandName === "USER_TOAST_MSG_V2" ? normalizeUserToastV2(eventData) : eventData;
      const isRedPacket = commandName === "POPULARITY_RED_POCKET_START" || commandName === "POPULARITY_RED_POCKET_NEW" || commandName === "RED_POCKET_START";
      // GUARD_BUY is the canonical purchase event. USER_TOAST_MSG is a
      // presentation event emitted by some rooms and may be absent.
      const isGuardBuy = commandName === "GUARD_BUY";
      const sender = data.sender_uinfo ?? data.senderUinfo ?? data.user_info ?? data.userInfo ?? data.user ?? {};
      const senderBase = sender && typeof sender === "object" ? (sender.base ?? {}) : {};
      if (!data.uname) {
        data.uname = sender?.uname ?? sender?.username ?? sender?.user_name ?? sender?.name ?? senderBase?.name;
      }
      const uid = text(data.uid ?? data.mid ?? data.sender_uid ?? data.senderUid ??
        sender?.uid ?? sender?.mid ?? (isRedPacket ? "red-packet" : ""));
      const userName = text(data.uname ?? data.username ?? data.user_name ?? data.userName) || uid || "观众";
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
      } else if (commandName === "USER_TOAST_MSG" || commandName === "USER_TOAST_MSG_V2" || isGuardBuy) {
        const operation = Number(data.op_type ?? data.group_op_type);
        const renewalByText = /续费|renew/i.test(text(data.toast_msg ?? data.toastMsg));
        // GUARD_BUY denotes a new purchase. For toast messages op_type=1 is
        // activation and op_type=2 is renewal; unknown values are treated as
        // activation so the contribution is not silently lost.
        kind = isGuardBuy || commandName === "USER_TOAST_MSG_V2"
          ? operation === 2 || data.__vtbRenewal === true || renewalByText ? "guard-renewal" : "guard-activation"
          : operation === 2 || data.__vtbRenewal === true || renewalByText ? "guard-renewal" : operation === 1 ? "guard-activation" : undefined;
        amount = finiteNumber(data.price ?? data.total_coin);
        count = finiteNumber(data.num, 1) || 1;
        roleName = normalizeGuardRoleName(data.role_name ?? data.roleName)
          ?? normalizeGuardRoleName(data.guard_level ?? data.guardLevel)
          ?? normalizeGuardRoleName(data.gift_name ?? data.giftName);
      } else if (commandName === "SEND_GIFT" || commandName === "SEND_GIFT_V2" || commandName === "COMBO_SEND") {
        kind = "gift";
        count = finiteNumber(data.num ?? data.combo_num ?? data.combo_num_total, 1) || 1;
        amount = finiteNumber(data.total_coin ?? data.combo_total_coin) || finiteNumber(data.price) * count;
        itemName = text(data.gift_name ?? data.giftName ?? data.original_gift_name ?? data.originalGiftName) || undefined;
      } else if (commandName === "SUPER_CHAT_MESSAGE" || commandName === "SUPER_CHAT_MESSAGE_JPN") {
        kind = "super-chat";
        amount = finiteNumber(data.price ?? data.rmb) * 1_000;
      }
      if (!kind) continue;
      amount = Math.max(0, finiteNumber(amount));
      count = Math.max(1, Math.round(finiteNumber(count, 1)));
      const explicitEventId = text(data.payflow_id ?? data.tid ?? data.rpid ?? data.id ?? data.lottery_id ?? data.lotteryId ?? data.message_id ?? data.msg_id);
      const guardTimestamp = text(data.start_time ?? data.startTime ?? data.ts ?? data.timestamp ?? data.end_time ?? data.endTime);
      // A few gateway variants omit both transaction and start-time fields.
      // Bucket the arrival time so their paired command frames still share an
      // id without making separate purchases permanent duplicates.
      const guardIdentity = guardTimestamp || explicitEventId || `${amount}:${count}:${Math.floor(Date.now() / GUARD_DEDUP_BUCKET_MS)}`;
      const isGuardEvent = isGuardBuy || commandName === "USER_TOAST_MSG" || commandName === "USER_TOAST_MSG_V2";
      // GUARD_BUY and USER_TOAST_MSG may both represent one purchase. Keep
      // the de-duplication key independent of the inferred activation/renewal kind.
      const eventId = isGuardEvent
        ? `guard:${connection.mid}:${connection.sessionStart.getTime()}:${uid}:${guardIdentity}`
        : explicitEventId || `${commandName}:${uid}:${text(data.start_time ?? data.ts) || Date.now()}:${amount}:${count}`;
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
      // contributionGroupIds is the complete real-time notification opt-in.
      // Keep persisting events for live-end summaries, but never invoke the
      // notification callback when the current subscription has no groups.
      if (recorded && notify && shouldNotifyVtbContribution(connection.contributionGroupIds)) {
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

const createAuthPacket = (roomId: string, token: string, uid = 0, buvid3?: string) => createPacket(7, new TextEncoder().encode(JSON.stringify({ uid, roomid: Number(roomId), protover: 3, platform: "web", type: 2, key: token, ...(buvid3 ? { buvid: buvid3 } : {}) })));
const createHeartbeatPacket = () => createPacket(2, new TextEncoder().encode("[object Object]"));

const unpack = (bytes: Uint8Array, depth = 0): Array<{ operation: number; body?: Uint8Array }> => {
  if (bytes.byteLength > MAX_PACKET_BYTES) throw new Error("VTB live event packet is too large");
  if (depth > MAX_PACKET_NESTING) throw new Error("VTB live event packet nesting is too deep");
  const packets: Array<{ operation: number; body?: Uint8Array }> = [];
  for (let offset = 0; offset + 16 <= bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const length = view.getUint32(0);
    if (length < 16 || offset + length > bytes.length) break;
    if (length > MAX_PACKET_BYTES) throw new Error("VTB live event packet is too large");
    const protocol = view.getUint16(6);
    const operation = view.getUint32(8);
    const body = bytes.slice(offset + 16, offset + length);
    if (protocol === 2) {
      const inflated = new Uint8Array(inflateSync(body));
      if (inflated.byteLength > MAX_PACKET_BYTES) throw new Error("VTB decompressed event packet is too large");
      packets.push(...unpack(inflated, depth + 1));
    } else if (protocol === 3) {
      const decompressed = new Uint8Array(brotliDecompressSync(body));
      if (decompressed.byteLength > MAX_PACKET_BYTES) throw new Error("VTB decompressed event packet is too large");
      packets.push(...unpack(decompressed, depth + 1));
    }
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

export const normalizeGuardRoleName = (value: unknown): string | undefined => {
  const role = text(value).trim();
  if (!role) return undefined;
  const level = Number(role);
  if (level === 1) return "总督";
  if (level === 2) return "提督";
  if (level === 3) return "舰长";
  if (Number.isFinite(level)) return undefined;
  return role;
};

export const normalizeUserToastV2 = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object") return {};
  const data = value as any;
  const sender = data.sender_uinfo ?? {};
  const senderBase = sender.base ?? {};
  const guard = data.guard_info ?? {};
  const pay = data.pay_info ?? {};
  const gift = data.gift_info ?? {};
  const toast = text(data.toast_msg);
  return {
    ...data,
    uid: data.uid ?? sender.uid,
    uname: data.uname ?? sender.uname ?? sender.username ?? senderBase.name,
    price: data.price ?? pay.price,
    num: data.num ?? pay.num,
    start_time: data.start_time ?? guard.start_time,
    end_time: data.end_time ?? guard.end_time,
    role_name: data.role_name ?? gift.gift_name ?? gift.giftName,
    op_type: data.op_type ?? data.group_op_type,
    __vtbRenewal: /续费|renew/i.test(toast),
  };
};

type ProtoField = { wireType: number; value: number | Uint8Array };

/** Decodes the protobuf payload used by the SEND_GIFT_V2 live command. */
export const decodeSendGiftV2Payload = (data: unknown): Array<Record<string, unknown>> => {
  const encoded = data && typeof data === "object" ? (data as any).pb : undefined;
  if (typeof encoded !== "string" || !encoded) return [];
  try {
    const root = readProtoFields(Buffer.from(encoded, "base64"));
    const uid = protoNumber(root, 1);
    const uname = protoText(root, 2);
    const gifts = protoFields(root, 10).map((field) => readProtoFields(field.value as Uint8Array));
    return gifts.map((gift) => {
      const giftInfo = protoFields(gift, 35)[0];
      const giftInfoFields = giftInfo ? readProtoFields(giftInfo.value as Uint8Array) : new Map<number, ProtoField[]>();
      return {
        uid: uid ? String(uid) : "",
        uname,
        giftId: protoNumber(gift, 1),
        giftName: protoText(gift, 2),
        num: protoNumber(gift, 3) || 1,
        giftType: protoNumber(gift, 4),
        price: protoNumber(gift, 5),
        total_coin: protoNumber(gift, 7),
        coin_type: protoText(gift, 8),
        tid: protoText(gift, 9),
        timestamp: protoNumber(gift, 10),
        rnd: protoText(gift, 12),
        action: protoText(gift, 18),
        gift_info: { img_basic: protoText(giftInfoFields, 1) },
      };
    }).filter((gift) => gift.uid && (gift.giftName || gift.total_coin || gift.price));
  } catch {
    return [];
  }
};

const protoFields = (fields: Map<number, ProtoField[]>, number: number) => fields.get(number) ?? [];
const protoNumber = (fields: Map<number, ProtoField[]>, number: number) => {
  const value = protoFields(fields, number).find((field) => field.wireType === 0)?.value;
  return typeof value === "number" ? value : 0;
};
const protoText = (fields: Map<number, ProtoField[]>, number: number) => {
  const value = protoFields(fields, number).find((field) => field.wireType === 2)?.value;
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
};

const readProtoFields = (bytes: Uint8Array): Map<number, ProtoField[]> => {
  const fields = new Map<number, ProtoField[]>();
  let offset = 0;
  while (offset < bytes.length) {
    const key = readProtoVarint(bytes, offset);
    offset = key.offset;
    const number = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (!number) throw new Error("invalid protobuf field");
    let value: number | Uint8Array;
    if (wireType === 0) {
      const parsed = readProtoVarint(bytes, offset);
      value = parsed.value;
      offset = parsed.offset;
    } else if (wireType === 2) {
      const length = readProtoVarint(bytes, offset);
      offset = length.offset;
      if (length.value < 0 || offset + length.value > bytes.length) throw new Error("invalid protobuf length");
      value = bytes.slice(offset, offset + length.value);
      offset += length.value;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new Error("invalid protobuf fixed64");
      value = bytes.slice(offset, offset + 8);
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new Error("invalid protobuf fixed32");
      value = bytes.slice(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error("unsupported protobuf wire type");
    }
    const list = fields.get(number) ?? [];
    list.push({ wireType, value });
    fields.set(number, list);
  }
  return fields;
};

const readProtoVarint = (bytes: Uint8Array, start: number): { value: number; offset: number } => {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift <= 53) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("invalid protobuf varint");
};
