import type { MizConfig } from "@/config";

export type Ff14AlertSnapshot = MizConfig["ff14"]["priceAlerts"];
type Ff14AlertChangeListener = (alerts: Ff14AlertSnapshot) => void;

const listeners = new Set<Ff14AlertChangeListener>();

export const notifyFf14AlertChange = (alerts: Ff14AlertSnapshot) => {
  for (const listener of listeners) listener(alerts);
};

export const onFf14AlertChange = (listener: Ff14AlertChangeListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
