import type { MizConfig } from "@/config";

/** Gateway and NapLink options are captured when the websocket client is built. */
export const requiresGatewayRestart = (previous: MizConfig, next: MizConfig) =>
  getGatewayRuntimeKey(previous) !== getGatewayRuntimeKey(next);

export const requiresRuntimeReload = (previous: MizConfig, next: MizConfig) =>
  JSON.stringify(previous) !== JSON.stringify(next);

const getGatewayRuntimeKey = (config: MizConfig) => JSON.stringify({
  gateway: config.gateway,
  naplink: config.naplink,
});
