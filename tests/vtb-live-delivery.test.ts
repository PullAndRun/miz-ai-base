import { describe, expect, test } from "bun:test";
import {
  getUndeliveredVtbLiveEndGroupIds,
  isVtbLivePromotion,
  isVtbLiveStartRecent,
  selectVtbDynamicPollBatch,
} from "@/tasks";

describe("VTB live-end delivery", () => {
  test("does not send a past live-end notification to a newly subscribed group", () => {
    expect(getUndeliveredVtbLiveEndGroupIds(
      [100, 200],
      ["100"],
      ["100"],
    )).toEqual([]);
  });

  test("sends live-end only to current groups that received the live-start notification", () => {
    expect(getUndeliveredVtbLiveEndGroupIds(
      [100, 200, 300],
      ["100", "200"],
      ["100"],
    )).toEqual([200]);
  });

  test("keeps legacy completed sessions suppressed", () => {
    expect(getUndeliveredVtbLiveEndGroupIds(
      [100],
      ["100"],
      ["*"],
    )).toEqual([]);
  });
});

describe("VTB live-start recovery", () => {
  test("rejects implausibly future live timestamps", () => {
    const now = new Date("2030-01-01T10:00:00Z").getTime();
    expect(isVtbLiveStartRecent(
      new Date("2030-01-01T11:00:00Z"),
      "*/3 * * * *",
      now,
    )).toBeFalse();
  });

  test("delivers a stream that started while live polling was interrupted", () => {
    const interruptedAt = new Date("2030-01-01T10:00:00Z").getTime();
    const recoveredAt = new Date("2030-01-01T10:30:00Z").getTime();

    expect(isVtbLiveStartRecent(
      new Date("2030-01-01T10:10:00Z"),
      "*/3 * * * *",
      recoveredAt,
      interruptedAt,
    )).toBeTrue();
  });

  test("does not replay a stream older than the last successful polling window", () => {
    const interruptedAt = new Date("2030-01-01T10:00:00Z").getTime();
    const recoveredAt = new Date("2030-01-01T10:30:00Z").getTime();

    expect(isVtbLiveStartRecent(
      new Date("2030-01-01T09:55:59Z"),
      "*/3 * * * *",
      recoveredAt,
      interruptedAt,
    )).toBeFalse();
  });
});

describe("VTB dynamic filtering", () => {
  test("normalizes the configured live URL when filtering promotions", () => {
    expect(isVtbLivePromotion({
      title: "直播预告",
      description: "今晚 https://live.bilibili.com/123 开播",
      link: "https://t.bilibili.com/1",
    }, "HTTPS://LIVE.BILIBILI.COM/")).toBeTrue();
    expect(isVtbLivePromotion({
      title: "普通动态",
      description: "没有直播链接",
      link: "https://t.bilibili.com/2",
    }, "https://live.bilibili.com")).toBeFalse();
  });

  test("prioritizes streamers whose dynamic request failed", () => {
    const subscriptions = ["1", "2", "3", "4"].map((mid) => ({
      streamerName: mid,
      groups: new Map(),
      streamer: { mid, name: mid },
    }));
    const pollState = { dynamicCursor: 0, dynamicRetryMids: new Set<string>(), cardInfos: new Map() };

    expect(selectVtbDynamicPollBatch(
      subscriptions,
      pollState,
      3 * 60_000,
      15 * 60_000,
      new Set(["3"]),
    ).map((subscription) => subscription.streamer.mid)).toEqual(["3"]);
  });
});
