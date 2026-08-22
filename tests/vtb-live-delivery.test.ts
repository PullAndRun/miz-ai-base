import { describe, expect, test } from "bun:test";
import { getUndeliveredVtbLiveEndGroupIds, isVtbLiveStartRecent } from "@/tasks";

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
