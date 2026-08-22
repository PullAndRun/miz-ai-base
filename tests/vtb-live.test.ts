import { afterEach, describe, expect, test } from "bun:test";
import type { VtbConfig } from "@/config";
import {
  createVtbNotificationMessage,
  findVtbNameChanges,
  getVtbCardInfo,
  getVtbImageFile,
  getVtbLiveInfo,
  getVtbLiveInfos,
  prependVtbAtAllMention,
  resolveVtbStreamer,
  resolveVtbStreamerForQuery,
} from "@/vtb";

const originalFetch = globalThis.fetch;
const config = {
  userApiUrl: "https://example.test/users?name=",
  liveApiUrl: "https://example.test/live",
  webUrl: "https://www.example.test",
  liveWebUrl: "https://live.example.test",
} as VtbConfig;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Bilibili live lookup", () => {
  test("uses the MID profile as the authoritative nickname after a change is detected", () => {
    const changes = findVtbNameChanges(
      [{ name: "旧昵称", mid: "123", roomId: "456" }],
      new Map([["123", { name: "  最新昵称  " }]]),
    );

    expect(changes).toEqual([{
      previousName: "旧昵称",
      name: "最新昵称",
      mid: "123",
    }]);
    expect(findVtbNameChanges(
      [{ name: "旧昵称", mid: "123" }],
      new Map([["999", { name: "其他主播" }]]),
    )).toEqual([]);
  });

  test("normalizes search result room_id 0 as no live room", async () => {
    const referers: Array<string | null> = [];
    const cookies: Array<string | null> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      referers.push(new Headers(init?.headers).get("referer"));
      cookies.push(new Headers(init?.headers).get("cookie"));
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
    expect(cookies).toEqual([null]);
  });

  test("preserves search parameters and accepts numeric-string API fields", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const requestUrl = String(input);
      urls.push(requestUrl);
      if (requestUrl.includes("users")) {
        return new Response(JSON.stringify({
          code: "0",
          data: { result: [{ uname: "带 空格", mid: "123", room_id: "456" }] },
        }));
      }
      return new Response(JSON.stringify({
        code: "0",
        data: [{ uid: "123", live_status: "1", live_time: "1893456000" }],
      }));
    }) as unknown as typeof fetch;

    const searchConfig = {
      ...config,
      userApiUrl: "https://search.example.test/users?name=&from=miz#ignored",
      liveApiUrl: "https://numeric-live.example.test/live",
    };
    const streamer = await resolveVtbStreamer("带 空格", searchConfig);
    expect(streamer).toEqual({ name: "带 空格", mid: "123", roomId: "456" });
    expect(new URL(urls[0]).searchParams.get("from")).toBe("miz");
    expect(new URL(urls[0]).searchParams.get("name")).toBe("带 空格");
    await expect(getVtbLiveInfo(streamer!, searchConfig)).resolves.toMatchObject({ isLive: true });
  });

  test("caches successful user searches to avoid repeated anti-risk requests", async () => {
    let calls = 0;
    const originalRandom = Math.random;
    Math.random = () => 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({
        code: 0,
        data: { result: [{ uname: "缓存主播", mid: "456", room_id: 789 }] },
      }));
    }) as unknown as typeof fetch;

    try {
      const searchConfig = {
        ...config,
        userApiUrl: "https://cached-search.example.test/users?name=",
      };
      await expect(resolveVtbStreamer("缓存主播", searchConfig)).resolves.toEqual({
        name: "缓存主播",
        mid: "456",
        roomId: "789",
      });
      await expect(resolveVtbStreamer("缓存主播", searchConfig)).resolves.toEqual({
        name: "缓存主播",
        mid: "456",
        roomId: "789",
      });
      expect(calls).toBe(1);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("resolves an untracked interactive query without persisting it", async () => {
    let upserts = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: { result: [{ uname: "临时查询主播", mid: "789", room_id: 123 }] },
    }))) as unknown as typeof fetch;
    const queryConfig = {
      ...config,
      userApiUrl: "https://read-only-query.example.test/users?name=",
    };
    const repository = {
      findStreamerByName: async () => undefined,
      upsertStreamer: async () => {
        upserts += 1;
        throw new Error("interactive queries must not persist streamers");
      },
    };

    await expect(resolveVtbStreamerForQuery(
      "临时查询主播",
      queryConfig,
      repository,
    )).resolves.toEqual({
      name: "临时查询主播",
      mid: "789",
      roomId: "123",
    });
    expect(upserts).toBe(0);
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

  test("does not treat an ambiguous business rejection as host-wide risk control", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(calls === 1
        ? { code: -352, data: [] }
        : { code: 0, data: [{ uid: "123", live_status: 0 }] }));
    }) as unknown as typeof fetch;
    const rejectedConfig = {
      ...config,
      liveApiUrl: "https://ambiguous-rejection.example.test/live",
    };

    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, rejectedConfig)).rejects.toThrow("code -352");
    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, rejectedConfig)).resolves.toMatchObject({
      isLive: false,
    });
    expect(calls).toBe(2);
  });

  test("opens a cooldown for the explicit too-frequent business code", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: -509, data: [] }));
    }) as unknown as typeof fetch;
    const rateLimitedConfig = {
      ...config,
      liveApiUrl: "https://business-rate-limit.example.test/live",
    };

    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, rateLimitedConfig)).rejects.toMatchObject({
      name: "VtbRateLimitError",
    });
    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, rateLimitedConfig)).rejects.toMatchObject({
      name: "VtbCooldownError",
      cooldownReason: "risk",
    });
    expect(calls).toBe(1);
  });

  test("does not open a circuit breaker for repeated invalid business responses", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(calls <= 3
        ? { code: -400, data: [] }
        : { code: 0, data: [{ uid: "123", live_status: 0 }] }));
    }) as unknown as typeof fetch;
    const invalidConfig = {
      ...config,
      liveApiUrl: "https://invalid-business-response.example.test/live",
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, invalidConfig)).rejects.toThrow("code -400");
    }
    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, invalidConfig)).resolves.toMatchObject({
      isLive: false,
    });
    expect(calls).toBe(4);
  });

  test("isolates user-search protection from card requests on the same host", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/search/")) {
        return new Response("protected", { status: 412 });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: [{ mid: "9988", fans: 42, name: "卡片主播" }],
      }));
    }) as unknown as typeof fetch;
    const isolatedConfig = {
      ...config,
      userApiUrl: "https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=",
      cardApiUrl: "https://api.bilibili.com/x/polymer/pc-electron/v1/user/cards?uids=",
    };

    await expect(resolveVtbStreamer("触发搜索保护", isolatedConfig)).rejects.toMatchObject({ status: 412 });
    await expect(getVtbCardInfo("9988", isolatedConfig)).resolves.toMatchObject({
      name: "卡片主播",
      fans: 42,
    });
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

  test("accepts millisecond and numeric-string live timestamps", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: [{ uid: "123", live_status: 1, live_time: "1893456000000" }],
    }))) as unknown as typeof fetch;
    const timestampConfig = {
      ...config,
      liveApiUrl: "https://timestamp.example.test/live",
    };

    await expect(getVtbLiveInfo({ name: "示例主播", mid: "123" }, timestampConfig)).resolves.toMatchObject({
      liveStartedAt: new Date("2030-01-01T00:00:00.000Z"),
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
