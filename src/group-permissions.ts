export const isWhitelistedUser = (
  userId: string | number | undefined,
  whitelistUserIds: readonly (string | number)[],
) => userId !== undefined && whitelistUserIds.some((id) => String(id) === String(userId));

export const isGroupAdministrator = (raw: Record<string, unknown>) => {
  const sender = raw.sender;
  if (!sender || typeof sender !== "object") {
    return false;
  }

  const role = (sender as Record<string, unknown>).role;
  return role === "admin" || role === "owner";
};

export const canManageGroupFeature = (
  raw: Record<string, unknown>,
  userId: string | number | undefined,
  whitelistUserIds: readonly (string | number)[],
) => isGroupAdministrator(raw) || isWhitelistedUser(userId, whitelistUserIds);
