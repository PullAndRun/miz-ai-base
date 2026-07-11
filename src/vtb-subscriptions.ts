/**
 * Pure VTB subscription rules.  Persistence and runtime orchestration belong
 * to their callers; these functions only derive the next value.
 */
export type VtbSubscription = Readonly<{
  groupId: string | number;
  streamers: readonly string[];
}>;

export type UpdatedVtbSubscription = {
  groupId: string | number;
  streamers: string[];
};

export type SubscriptionChange = "subscribe" | "unsubscribe";

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
): UpdatedVtbSubscription[] => {
  const current = findVtbSubscription(subscriptions, groupId);

  if (action === "subscribe") {
    if (current?.streamers.includes(streamerName)) {
      return subscriptions.map(copySubscription);
    }

    return current
      ? subscriptions.map((subscription) => sameGroup(subscription.groupId, groupId)
        ? { ...subscription, streamers: [...subscription.streamers, streamerName] }
        : copySubscription(subscription))
      : [...subscriptions.map(copySubscription), { groupId, streamers: [streamerName] }];
  }

  return subscriptions.flatMap((subscription) => {
    if (!sameGroup(subscription.groupId, groupId)) {
      return [copySubscription(subscription)];
    }

    const streamers = subscription.streamers.filter((name) => name !== streamerName);
    return streamers.length > 0 ? [{ ...subscription, streamers }] : [];
  });
};

export const renameVtbSubscriptions = (
  subscriptions: readonly VtbSubscription[],
  renames: ReadonlyMap<string, string>,
): UpdatedVtbSubscription[] => subscriptions.map((subscription) => ({
  ...subscription,
  streamers: subscription.streamers.map((name) => renames.get(name) ?? name),
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

const copySubscription = (subscription: VtbSubscription): UpdatedVtbSubscription => ({
  ...subscription,
  streamers: [...subscription.streamers],
});
