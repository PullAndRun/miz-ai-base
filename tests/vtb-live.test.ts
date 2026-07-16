import { afterEach, describe, expect, test } from "bun:test";
import type { VtbConfig } from "@/config";
import {
  createVtbNotificationMessage,
  getVtbCardInfo,
  getVtbImageFile,
  getVtbLiveInfo,
  getVtbLiveInfos,
  prependVtbAtAllMention,
  resolveVtbStreamer,
} from "@/vtb";

const originalFetch = globalThis.fetch;
const config = {
  userApiUrl: "https://example.test/users?name=",
  liveApiUrl: "https://example.test/live",
  webUrl: "https://www.example.test",
  liveWebUrl: "https://live.example.test",
  bilibiliCookie: "",
} as VtbConfig;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Bilibili live lookup", () => {
  test("normalizes search result room_id 0 as no live room", async () => {
    const referers: Array<string | null> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      referers.push(new Headers(init?.headers).get("referer"));
      return new Response(JSON.stringify({
        code: 0,
        data: { result: [{ uname: "示例主播", mid: "123", room_id: 0 }] },
      }));
    }) as unknown as typeof fetch;

    await expect(resolveVtbStreamer("示例主播", config)).resolves.toEqual({
      name: "示例主播",
      mid: "123",
      roomId: undefined,
    });
    expect(referers).toEqual(["https://www.example.test/"]);
  });

  test("treats an omitted user without a live room as offline", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, data: [] }))) as unknown as typeof fetch;

    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, config)).resolves.toEqual({
      title: "还没有直播标题",
      roomId: undefined,
      liveStartedAt: undefined,
      isLive: false,
      name: "示例主播",
      coverUrl: undefined,
    });
  });

  test("keeps omission detectable for a user with a known live room", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, data: [] }))) as unknown as typeof fetch;

    const lives = await getVtbLiveInfos([{ name: "示例主播", mid: "123", roomId: "456" }], config);
    expect(lives.has("123")).toBeFalse();
  });

  test("reuses an in-flight live request for the same streamer", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        code: 0,
        data: [{ uid: "123", live_status: 0 }],
      }));
    }) as unknown as typeof fetch;
    const singleFlightConfig = {
      ...config,
      liveApiUrl: "https://single-flight.example.test/live",
    };

    await Promise.all([
      getVtbLiveInfo({ name: "示例主播", mid: "123" }, singleFlightConfig),
      getVtbLiveInfo({ name: "示例主播", mid: "123" }, singleFlightConfig),
    ]);
    await getVtbLiveInfo({ name: "示例主播", mid: "123" }, singleFlightConfig);
    expect(calls).toBe(1);
  });

  test("does not share authenticated requests or caches across cookies", async () => {
    let calls = 0;
    globalThis.fetch = (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1;
      const cookie = new Headers(init?.headers).get("cookie") ?? "missing";
      return new Response(JSON.stringify({
        code: 0,
        data: [{ uid: "cookie-mid", live_status: 0, uname: cookie }],
      }));
    }) as unknown as typeof fetch;
    const authenticatedConfig = {
      ...config,
      liveApiUrl: "https://cookie-cache.example.test/live",
    };

    const [first, second] = await Promise.all([
      getVtbLiveInfo(
        { name: "first", mid: "cookie-mid" },
        { ...authenticatedConfig, bilibiliCookie: "session=first" },
      ),
      getVtbLiveInfo(
        { name: "second", mid: "cookie-mid" },
        { ...authenticatedConfig, bilibiliCookie: "session=second" },
      ),
    ]);

    expect(first.name).toBe("session=first");
    expect(second.name).toBe("session=second");
    expect(calls).toBe(2);
  });

  test("opens a cooldown after a rate-limit response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("busy", { status: 429 });
    }) as unknown as typeof fetch;
    const rateLimitedConfig = {
      ...config,
      liveApiUrl: "https://rate-limit.example.test/live",
    };

    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, rateLimitedConfig)).rejects.toMatchObject({
      status: 429,
    });
    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, rateLimitedConfig)).rejects.toMatchObject({
      name: "VtbCooldownError",
    });
    expect(calls).toBe(1);
  });

  test("uses alternative live cover fields when the primary cover is absent", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: [{
        uid: "123",
        live_status: 1,
        cover_from_user: "",
        keyframe: "//i0.hdslb.com/live-cover.jpg",
      }],
    }))) as unknown as typeof fetch;
    const coverConfig = {
      ...config,
      liveApiUrl: "https://cover.example.test/live",
    };

    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, coverConfig)).resolves.toMatchObject({
      coverUrl: "https://i0.hdslb.com/live-cover.jpg",
    });
  });

  test("keeps the streamer avatar as an image fallback", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: { "123": { fans: 10, name: "示例主播", face: "//i0.hdslb.com/avatar.jpg" } },
    }))) as unknown as typeof fetch;
    const cardConfig = {
      ...config,
      cardApiUrl: "https://card-avatar.example.test/cards?uids=",
      cardCacheMinutes: 30,
    };

    await expect(getVtbCardInfo("123", cardConfig)).resolves.toMatchObject({
      avatarUrl: "https://i0.hdslb.com/avatar.jpg",
    });
  });

  test("downloads notification images once and sends them as base64", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    const imageUrl = "https://notification-image.example.test/cover.png";

    const first = await getVtbImageFile(imageUrl, config);
    const second = await getVtbImageFile(imageUrl, config);
    expect(first).toBe("base64://AQID");
    expect(second).toBe(first);
    expect(calls).toBe(1);

    const message = createVtbNotificationMessage("开播消息", first);
    const mentioned = prependVtbAtAllMention(message) as Array<{ type: string; data: Record<string, unknown> }>;
    expect(mentioned[0]).toEqual({ type: "at", data: { qq: "all" } });
    expect(mentioned.some((segment) => segment.type === "image" && segment.data.file === first)).toBeTrue();
  });
});
