import type { MizConfig } from "@/config";

export type VtbSubscriptionSnapshot = MizConfig["vtb"]["subscriptions"];

export type VtbSubscriptionChange = Readonly<{
  groupId: string | number;
  subscriptions: VtbSubscriptionSnapshot;
}>;

type VtbSubscriptionChangeListener = (change: VtbSubscriptionChange) => void;

const listeners = new Set<VtbSubscriptionChangeListener>();

/**
 * Notifies the active VTB poller after a command has persisted a subscription
 * change. The TOML watcher remains responsible for general configuration hot
 * reloads; this signal makes command-driven subscription updates immediate and
 * independent of filesystem watcher delivery.
 */
export const notifyVtbSubscriptionChange = (change: VtbSubscriptionChange) => {
  for (const listener of listeners) {
    listener(change);
  }
};

export const onVtbSubscriptionChange = (listener: VtbSubscriptionChangeListener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const replaceVtbSubscriptionGroup = (
  current: VtbSubscriptionSnapshot,
  latest: VtbSubscriptionSnapshot,
  groupId: string | number,
): VtbSubscriptionSnapshot => {
  const sameGroup = (candidate: string | number) => String(candidate) === String(groupId);
  const nextGroup = latest.find((subscription) => sameGroup(subscription.groupId));
  const remaining = current.filter((subscription) => !sameGroup(subscription.groupId));
  return nextGroup ? [...remaining, nextGroup] : remaining;
};
