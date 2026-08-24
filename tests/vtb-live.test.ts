import { afterEach, describe, expect, test } from "bun:test";
import type { VtbConfig } from "@/config";
import {
  createVtbNotificationMessage,
  findVtbNameChanges,
  getVtbCardInfo,
  getVtbImageFile,
  getVtbLiveStats,
  getVtbLiveInfo,
  getVtbLiveInfos,
  getVtbGuardSnapshot,
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

  test("accepts the documented name-to-uid lookup response", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        data: { uid_list: [{ name: "官方查询主播", uid: "987654" }] },
      }));
    }) as unknown as typeof fetch;

    const modernConfig = {
      ...config,
      userApiUrl: "https://modern-lookup.example.test/x/polymer/web-dynamic/v1/name-to-uid?names=",
    };
    await expect(resolveVtbStreamer("官方查询主播", modernConfig)).resolves.toEqual({
      name: "官方查询主播",
      mid: "987654",
    });
    expect(new URL(urls[0]).searchParams.get("names")).toBe("官方查询主播");
  });

  test("does not attach login cookies to documented anonymous live APIs", async () => {
    const requests: Array<{ url: string; cookie: string | null }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), cookie: new Headers(init?.headers).get("cookie") });
      if (String(input).includes("live-status.example.test")) {
        return new Response(JSON.stringify({ code: 0, data: { "123": { uid: 123, live_status: 0 } } }));
      }
      if (String(input).includes("live_user/v1/Master/info")) {
        return new Response(JSON.stringify({ code: 0, data: { follower_num: 10, info: { uname: "示例主播" } } }));
      }
      return new Response(JSON.stringify({ code: 0, data: [] }));
    }) as unknown as typeof fetch;
    const anonymousConfig = { ...config, liveApiUrl: "https://live-status.example.test/live" };
    await getVtbLiveInfos([{ name: "示例主播", mid: "123" }], anonymousConfig);
    await getVtbCardInfo("123", anonymousConfig);
    expect(requests.filter((request) => request.url.includes("live-status.example.test")).every((request) => request.cookie === null)).toBe(true);
    expect(requests.filter((request) => request.url.includes("api.live.bilibili.com")).every((request) => request.cookie === null)).toBe(true);
  });

  test("does not subscribe to an approximate search result", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: { result: [{ uname: "相似主播", mid: "987" }] },
    }))) as unknown as typeof fetch;
    await expect(resolveVtbStreamer("不存在的主播", {
      ...config,
      userApiUrl: "https://approximate-search.example.test/users?name=",
    })).resolves.toBeUndefined();
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

  test("uses the proxy only after direct VTB access is rate-limited", async () => {
    const proxies: Array<string | undefined> = [];
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      proxies.push((init as RequestInit & { proxy?: string } | undefined)?.proxy);
      if (!proxies.at(-1)) {
        return new Response("protected", { status: 412 });
      }
      return new Response(JSON.stringify({ code: 0, data: [{ uid: "123", live_status: 0 }] }));
    }) as unknown as typeof fetch;

    const fallbackConfig = {
      ...config,
      liveApiUrl: "https://direct-first.example.test/live",
      proxyUrl: "http://proxy.example.test:7890",
    };
    await expect(getVtbLiveInfo({ name: "绀轰緥涓绘挱", mid: "123" }, fallbackConfig))
      .resolves.toMatchObject({ isLive: false });
    expect(proxies).toEqual([undefined, "http://proxy.example.test:7890"]);
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

  test("does not treat live status 2 as an active stream", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: [{ uid: "123", live_status: 2, live_time: 0, online: 0 }],
    }))) as unknown as typeof fetch;

    await expect(getVtbLiveInfo({ name: "绀轰緥涓绘挱", mid: "123" }, {
      ...config,
      liveApiUrl: "https://status-two.example.test/live",
    })).resolves.toMatchObject({
      isLive: false,
      liveStartedAt: undefined,
    });
  });

  test("parses guard top-three and paged list entries", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        data: {
          info: { num: 2 },
          top3: [{ uinfo: { uid: 1, base: { name: "甲" } } }],
          list: [{ uinfo: { uid: 2, base: { name: "乙" } } }],
        },
      }));
    }) as unknown as typeof fetch;
    await expect(getVtbGuardSnapshot("456", "123", config)).resolves.toEqual({
      ids: ["1", "2"], names: ["甲", "乙"], captured: true,
    });
    expect(new URL(urls[0]).searchParams.get("roomid")).toBe("456");
    expect(new URL(urls[0]).searchParams.get("ruid")).toBe("123");
  });

  test("accepts the documented single-mid web card response", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        code: 0,
        data: {
          card: {
            mid: "123",
            name: "官方卡片主播",
            fans: 6007386,
            face: "https://i1.hdslb.com/bfs/face/avatar.webp",
          },
        },
      }));
    }) as unknown as typeof fetch;
    const cardConfig = {
      ...config,
      cardApiUrl: "https://api.bilibili.com/x/web-interface/card?mid=",
    };

    await expect(getVtbCardInfo("123", cardConfig)).resolves.toEqual({
      fans: 6007386,
      name: "官方卡片主播",
      avatarUrl: "https://i1.hdslb.com/bfs/face/avatar.webp",
    });
    expect(new URL(urls[0]).searchParams.get("mid")).toBe("123");
  });

  test("falls back to documented live endpoints for followers and fan-club totals", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("documented-card.example.test")) {
        return new Response(JSON.stringify({ code: -101, data: null }));
      }
      if (url.includes("live_user/v1/Master/info")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { uid: "99123", follower_num: 1234, room_id: 456, info: { uname: "鏂囨。涓绘挱", face: "//i0.hdslb.com/avatar.jpg" } },
        }));
       }
       if (url.includes("getFansMembersRank")) {
         return new Response(JSON.stringify({ code: 0, data: { num: 89, list: [] } }));
       }
       return new Response(JSON.stringify({ code: 0, data: [] }));
     }) as unknown as typeof fetch;
     const documentedConfig = {
      ...config,
      cardApiUrl: "https://documented-card.example.test/cards?mid=",
    };

    await expect(getVtbCardInfo("99123", documentedConfig)).resolves.toMatchObject({
      fans: 1234,
      name: "鏂囨。涓绘挱",
      avatarUrl: "https://i0.hdslb.com/avatar.jpg",
      roomId: "456",
      fanClub: 89,
    });
    expect(urls.some((url) => url.includes("live_user/v1/Master/info"))).toBe(true);
    expect(urls.some((url) => url.includes("getFansMembersRank"))).toBe(true);
  });

  test("parses the documented master profile response", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: { follower_num: 321, room_id: 654, info: { uname: "主播", face: "//i0.hdslb.com/avatar.jpg" } },
    }))) as unknown as typeof fetch;

    await expect(getVtbLiveStats("partial-991", {
      ...config,
      liveWebUrl: "https://partial-stats.example.test",
    })).resolves.toEqual({ fans: 321, name: "主播", avatarUrl: "https://i0.hdslb.com/avatar.jpg", roomId: "654" });
  });

  test("keeps fan-club and guard fields when the master profile includes them", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: {
        follower_num: 321,
        fan_club_count: 23,
        guard_num: 4,
      },
    }))) as unknown as typeof fetch;

    await expect(getVtbLiveStats("master-fields-991", {
      ...config,
      liveWebUrl: "https://master-fields.example.test",
    })).resolves.toMatchObject({ fans: 321, fanClub: 23, guards: 4 });
  });

  test("deduplicates concurrent live-stats requests and reuses the short cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 0, data: { follower_num: 12, room_id: 3 } }));
    }) as unknown as typeof fetch;
    const statsConfig = { ...config, liveWebUrl: "https://single-flight-stats.example.test" };

    const [first, second] = await Promise.all([
      getVtbLiveStats("single-flight-992", statsConfig),
      getVtbLiveStats("single-flight-992", statsConfig),
    ]);
    expect(first).toEqual({ fans: 12, roomId: "3" });
    expect(second).toEqual(first);
    await expect(getVtbLiveStats("single-flight-992", statsConfig)).resolves.toEqual(first);
    expect(calls).toBe(2);
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

    const withMultipleImages = createVtbNotificationMessage("动态文案", [first!, "base64://BAUG"]);
    expect(withMultipleImages).toEqual([
      { type: "text", data: { text: "动态文案" } },
      { type: "image", data: { file: first } },
      { type: "image", data: { file: "base64://BAUG" } },
    ]);
  });

  test("accepts a notification image larger than the old 5MB limit", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    bytes[0] = 1;
    globalThis.fetch = (async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;

    const file = await getVtbImageFile("https://notification-image.example.test/large.jpg", config);
    expect(file?.startsWith("base64://")).toBeTrue();
  });
});
