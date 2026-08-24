import { describe, expect, test } from "bun:test";
import { changeVtbSubscriptions, renameVtbSubscriptions } from "@/vtb-subscriptions";

describe("VTB subscription updates", () => {
  test("removes stale @all and dynamic entries when unsubscribing", () => {
    expect(changeVtbSubscriptions([
      {
        groupId: 1,
        streamers: ["A", "B"],
        atAllStreamers: ["A", "B"],
        dynamicStreamers: ["A", "B"],
      },
    ], 1, "A", "unsubscribe")).toEqual([
      { groupId: 1, streamers: ["B"], atAllStreamers: ["B"], dynamicStreamers: ["B"] },
    ]);
  });

  test("renames subscriptions, @all and dynamic entries", () => {
    expect(renameVtbSubscriptions([
      {
        groupId: 1,
        streamers: ["old", "same"],
        atAllStreamers: ["old"],
        dynamicStreamers: ["old"],
      },
    ], new Map([["old", "new"]]))).toEqual([
      {
        groupId: 1,
        streamers: ["new", "same"],
        atAllStreamers: ["new"],
        dynamicStreamers: ["new"],
      },
    ]);
  });

  test("can subscribe and cancel dynamic delivery independently", () => {
    const withDynamic = changeVtbSubscriptions([
      { groupId: 1, streamers: ["主播"] },
    ], 1, "主播", "subscribe", "dynamic");
    expect(withDynamic).toEqual([
      { groupId: 1, streamers: ["主播"], dynamicStreamers: ["主播"] },
    ]);
    expect(changeVtbSubscriptions(withDynamic, 1, "主播", "unsubscribe", "dynamic"))
      .toEqual([{ groupId: 1, streamers: ["主播"], dynamicStreamers: [] }]);
  });
});
