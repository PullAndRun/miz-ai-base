import { describe, expect, test } from "bun:test";
import {
  notifyVtbSubscriptionChange,
  onVtbSubscriptionChange,
  replaceVtbSubscriptionGroup,
} from "@/vtb-subscription-runtime";

describe("VTB runtime subscription updates", () => {
  test("replaces only the changed group in the active snapshot", () => {
    const current = [
      { groupId: 100, streamers: ["旧主播"] },
      { groupId: 200, streamers: ["保留主播"] },
    ];
    const latest = [
      { groupId: 100, streamers: ["旧主播", "新主播"], atAllStreamers: ["新主播"] },
      { groupId: 300, streamers: ["未启用群主播"] },
    ];

    expect(replaceVtbSubscriptionGroup(current, latest, "100")).toEqual([
      { groupId: 200, streamers: ["保留主播"] },
      { groupId: 100, streamers: ["旧主播", "新主播"], atAllStreamers: ["新主播"] },
    ]);
    expect(replaceVtbSubscriptionGroup([], latest, 100)).toEqual([
      { groupId: 100, streamers: ["旧主播", "新主播"], atAllStreamers: ["新主播"] },
    ]);
  });

  test("notifies and detaches active pollers", () => {
    const changes: number[] = [];
    const detach = onVtbSubscriptionChange((change) => changes.push(Number(change.groupId)));

    notifyVtbSubscriptionChange({ groupId: 100, subscriptions: [] });
    detach();
    notifyVtbSubscriptionChange({ groupId: 200, subscriptions: [] });

    expect(changes).toEqual([100]);
  });
});
