import { describe, expect, test } from "bun:test";
import { changeVtbSubscriptions, renameVtbSubscriptions } from "@/vtb-subscriptions";

describe("VTB subscription updates", () => {
  test("removes stale @all entries when unsubscribing", () => {
    expect(changeVtbSubscriptions([
      { groupId: 1, streamers: ["A", "B"], atAllStreamers: ["A", "B"] },
    ], 1, "A", "unsubscribe")).toEqual([
      { groupId: 1, streamers: ["B"], atAllStreamers: ["B"] },
    ]);
  });

  test("renames both subscriptions and @all entries", () => {
    expect(renameVtbSubscriptions([
      { groupId: 1, streamers: ["old", "same"], atAllStreamers: ["old"] },
    ], new Map([["old", "new"]]))).toEqual([
      { groupId: 1, streamers: ["new", "same"], atAllStreamers: ["new"] },
    ]);
  });
});
