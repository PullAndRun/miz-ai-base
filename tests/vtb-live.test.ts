import { afterEach, describe, expect, test } from "bun:test";
import type { VtbConfig } from "@/config";
import { getVtbLiveInfo, getVtbLiveInfos, resolveVtbStreamer } from "@/vtb";

const originalFetch = globalThis.fetch;
const config = {
  userApiUrl: "https://example.test/users?name=",
  liveApiUrl: "https://example.test/live",
  bilibiliCookie: "",
} as VtbConfig;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Bilibili live lookup", () => {
  test("normalizes search result room_id 0 as no live room", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 0,
      data: { result: [{ uname: "示例主播", mid: "123", room_id: 0 }] },
    }))) as unknown as typeof fetch;

    await expect(resolveVtbStreamer("示例主播", config)).resolves.toEqual({
      name: "示例主播",
      mid: "123",
      roomId: undefined,
    });
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
});
