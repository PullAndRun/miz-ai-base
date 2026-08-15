import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import { requiresGatewayRestart, requiresRuntimeReload } from "@/runtime-config";

const createConfig = () => ({
  gateway: {
    url: "ws://gateway:3000",
    accessToken: "token",
    followedGroupMemberId: 123,
  },
  naplink: {
    logLevel: "warn",
    connectTimeoutMs: 30_000,
    pingIntervalMs: 30_000,
    apiTimeoutMs: 30_000,
    apiRetries: 3,
  },
  ff14: { priceAlerts: [] },
} as unknown as MizConfig);

describe("runtime configuration boundaries", () => {
  test("restarts the gateway for every captured gateway and NapLink setting", () => {
    const current = createConfig();
    expect(requiresGatewayRestart(current, {
      ...current,
      gateway: { ...current.gateway, url: "ws://next:3000" },
    })).toBeTrue();
    expect(requiresGatewayRestart(current, {
      ...current,
      gateway: { ...current.gateway, followedGroupMemberId: 456 },
    })).toBeTrue();
    expect(requiresGatewayRestart(current, {
      ...current,
      naplink: { ...current.naplink, logLevel: "info" },
    })).toBeTrue();
    expect(requiresGatewayRestart(current, {
      ...current,
      naplink: { ...current.naplink, apiTimeoutMs: 5_000 },
    })).toBeTrue();
  });

  test("does not reconnect the gateway for feature-only changes", () => {
    const current = createConfig();
    const next: MizConfig = {
      ...current,
      ff14: { ...current.ff14, priceAlerts: [{
        groupId: 100,
        region: "猫",
        itemName: "水之碎晶",
        minimumPrice: 1000,
        priceAlertAtUserIds: [],
      }] },
    };
    expect(requiresGatewayRestart(current, next)).toBeFalse();
    expect(requiresRuntimeReload(current, next)).toBeTrue();
    expect(requiresRuntimeReload(current, { ...current })).toBeFalse();
  });
});
