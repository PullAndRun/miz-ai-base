/**
 * Pure VTB subscription rules.  Persistence and runtime orchestration belong
 * to their callers; these functions only derive the next value.
 */
export type VtbSubscription = Readonly<{
  groupId: string | number;
  /** Live subscriptions (legacy field name retained for config compatibility). */
  streamers: readonly string[];
  atAllStreamers?: readonly string[];
  dynamicStreamers?: readonly string[];
  dynamicAtAllStreamers?: readonly string[];
}>;

export type UpdatedVtbSubscription = {
  groupId: string | number;
  streamers: string[];
  atAllStreamers?: string[];
  dynamicStreamers?: string[];
  dynamicAtAllStreamers?: string[];
};

export type SubscriptionChange = "subscribe" | "unsubscribe";
export type VtbSubscriptionType = "live" | "dynamic";

const sameGroup = (left: string | number, right: string | number) => String(left) === String(right);

export const findVtbSubscription = (
  subscriptions: readonly VtbSubscription[],
  groupId: string | number,
) => subscriptions.find((subscription) => sameGroup(subscription.groupId, groupId));

export const changeVtbSubscriptions = (
  subscriptions: readonly VtbSubscription[],
  groupId: string | number,
  streamerName: string,
  action: SubscriptionChange,
  type?: VtbSubscriptionType,
): UpdatedVtbSubscription[] => {
  const current = findVtbSubscription(subscriptions, groupId);
  const effectiveType = type ?? "live";
  const key = effectiveType === "live" ? "streamers" : "dynamicStreamers";

  if (action === "subscribe") {
    if (current?.[key]?.includes(streamerName)) {
      return subscriptions.map(copySubscription);
    }

    return current
      ? subscriptions.map((subscription) => sameGroup(subscription.groupId, groupId)
        ? copySubscriptionWithStreamers(subscription, effectiveType === "live"
          ? [...subscription.streamers, streamerName]
          : [...subscription.streamers],
          effectiveType === "dynamic" ? [...(subscription.dynamicStreamers ?? []), streamerName] : undefined)
        : copySubscription(subscription))
      : [...subscriptions.map(copySubscription), effectiveType === "live"
        ? { groupId, streamers: [streamerName] }
        : { groupId, streamers: [], dynamicStreamers: [streamerName] }];
  }

  return subscriptions.flatMap((subscription) => {
    if (!sameGroup(subscription.groupId, groupId)) {
      return [copySubscription(subscription)];
    }

    const streamers = subscription.streamers.filter((name) => name !== streamerName);
    const dynamicStreamers = (subscription.dynamicStreamers ?? []).filter((name) => name !== streamerName);
    const next = effectiveType === "live"
      ? copySubscriptionWithStreamers(subscription, streamers)
      : copySubscriptionWithStreamers(subscription, [...subscription.streamers], dynamicStreamers);
    if (type === undefined) {
      const legacyNext = copySubscriptionWithStreamers(subscription, streamers, dynamicStreamers);
      return legacyNext.streamers.length > 0 || (legacyNext.dynamicStreamers?.length ?? 0) > 0 ? [legacyNext] : [];
    }
    return next.streamers.length > 0 || (next.dynamicStreamers?.length ?? 0) > 0 ? [next] : [];
  });
};

export const renameVtbSubscriptions = (
  subscriptions: readonly VtbSubscription[],
  renames: ReadonlyMap<string, string>,
): UpdatedVtbSubscription[] => subscriptions.map((subscription) => ({
  groupId: subscription.groupId,
  streamers: subscription.streamers.map((name) => renames.get(name) ?? name),
  ...(subscription.atAllStreamers === undefined
    ? {}
    : { atAllStreamers: subscription.atAllStreamers.map((name) => renames.get(name) ?? name) }),
  ...(subscription.dynamicStreamers === undefined
    ? {}
    : { dynamicStreamers: subscription.dynamicStreamers.map((name) => renames.get(name) ?? name) }),
  ...(subscription.dynamicAtAllStreamers === undefined
    ? {}
    : { dynamicAtAllStreamers: subscription.dynamicAtAllStreamers.map((name) => renames.get(name) ?? name) }),
}));

export const partitionVtbSubscriptionsByGroup = (
  subscriptions: readonly VtbSubscription[],
  availableGroupIds: ReadonlySet<string>,
) => subscriptions.reduce<{ enabled: UpdatedVtbSubscription[]; disabled: UpdatedVtbSubscription[] }>(
  (result, subscription) => availableGroupIds.has(String(subscription.groupId))
    ? { ...result, enabled: [...result.enabled, copySubscription(subscription)] }
    : { ...result, disabled: [...result.disabled, copySubscription(subscription)] },
  { enabled: [], disabled: [] },
);

const copySubscription = (subscription: VtbSubscription): UpdatedVtbSubscription =>
  copySubscriptionWithStreamers(subscription, [...subscription.streamers]);

const copySubscriptionWithStreamers = (
  subscription: VtbSubscription,
  streamers: string[],
  dynamicStreamers = subscription.dynamicStreamers === undefined ? undefined : [...subscription.dynamicStreamers],
): UpdatedVtbSubscription => ({
  ...(subscription.atAllStreamers === undefined
    ? {}
    : { atAllStreamers: subscription.atAllStreamers.filter((name) => streamers.includes(name)) }),
  ...(dynamicStreamers === undefined
    ? {}
    : { dynamicStreamers: [...dynamicStreamers] }),
  ...(subscription.dynamicAtAllStreamers === undefined
    ? {}
    : { dynamicAtAllStreamers: subscription.dynamicAtAllStreamers.filter((name) => dynamicStreamers?.includes(name) ?? false) }),
  groupId: subscription.groupId,
  streamers,
});
