import { describe, expect, test } from "bun:test";
import {
  addFf14PriceAlertToSource,
  removeFf14PriceAlertsFromSource,
} from "@/config";

const alert = {
  groupId: 100,
  region: "猫" as const,
  itemName: "水之碎晶",
  minimumPrice: 1000,
  priceAlertAtUserIds: [123],
};

describe("FF14 price alert config updates", () => {
  test("appends a complete alert block and detects a duplicate", () => {
    const added = addFf14PriceAlertToSource("", alert);
    expect(added.changed).toBeTrue();
    expect(Bun.TOML.parse(added.source)).toMatchObject({
      miz: { ff14: { priceAlerts: [alert] } },
    });

    const duplicate = addFf14PriceAlertToSource(added.source, alert);
    expect(duplicate.changed).toBeFalse();
    expect(duplicate.source).toBe(added.source);
  });

  test("removes matching items only from the requested group", () => {
    const first = addFf14PriceAlertToSource("", alert).source;
    const source = addFf14PriceAlertToSource(first, {
      ...alert,
      groupId: 200,
    }).source;

    const removed = removeFf14PriceAlertsFromSource(source, 100, "水之碎晶");
    expect(removed.changed).toBeTrue();
    expect(removed.removed).toHaveLength(1);
    expect(Bun.TOML.parse(removed.source)).toMatchObject({
      miz: { ff14: { priceAlerts: [{ ...alert, groupId: 200 }] } },
    });
  });
});
