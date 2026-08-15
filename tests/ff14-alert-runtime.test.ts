import { describe, expect, test } from "bun:test";
import { notifyFf14AlertChange, onFf14AlertChange } from "@/ff14-alert-runtime";

describe("FF14 runtime alert updates", () => {
  test("notifies and detaches the active price task", () => {
    const revisions: number[] = [];
    const detach = onFf14AlertChange((alerts) => revisions.push(alerts.length));
    notifyFf14AlertChange([]);
    notifyFf14AlertChange([{
      groupId: 100,
      region: "猫",
      itemName: "水之碎晶",
      minimumPrice: 1000,
      priceAlertAtUserIds: [],
    }]);
    detach();
    notifyFf14AlertChange([]);
    expect(revisions).toEqual([0, 1]);
  });
});
