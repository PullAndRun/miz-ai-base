export type GroupId = string | number;

/** Extracts valid group IDs and de-duplicates equivalent numeric/string IDs. */
export const getGroupIds = (value: unknown): GroupId[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries = value
    .map((group): readonly [string, GroupId] | undefined => {
      if (!group || typeof group !== "object") {
        return undefined;
      }

      const groupId = (group as Record<string, unknown>).group_id;
      const normalizedGroupId = typeof groupId === "string" ? groupId.trim() : groupId;
      return (typeof normalizedGroupId === "number" && Number.isFinite(normalizedGroupId)) ||
        (typeof normalizedGroupId === "string" && normalizedGroupId)
        ? [String(normalizedGroupId), normalizedGroupId]
        : undefined;
    })
    .filter((entry): entry is readonly [string, GroupId] => entry !== undefined);

  const uniqueIds = new Map<string, GroupId>();
  for (const [key, groupId] of entries) {
    if (!uniqueIds.has(key)) {
      uniqueIds.set(key, groupId);
    }
  }

  return Array.from(uniqueIds.values());
};
