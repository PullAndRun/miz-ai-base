import { describe, expect, test } from "bun:test";
import { getUndeliveredVtbLiveEndGroupIds } from "@/tasks";

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
