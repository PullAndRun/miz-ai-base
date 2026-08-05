const RICH_MEDIA_TRANSFER_FAILURE_PATTERN = /rich media transfer failed/i;

const containsRichMediaTransferFailure = (
  value: unknown,
  seen: WeakSet<object>,
): boolean => {
  if (typeof value === "string") {
    return RICH_MEDIA_TRANSFER_FAILURE_PATTERN.test(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);
  if (value instanceof Error) {
    if (RICH_MEDIA_TRANSFER_FAILURE_PATTERN.test(value.message)) {
      return true;
    }
    if (value instanceof AggregateError && value.errors.some((error) =>
      containsRichMediaTransferFailure(error, seen))) {
      return true;
    }
    if (containsRichMediaTransferFailure(value.cause, seen)) {
      return true;
    }
  }

  return Object.values(value).some((item) => containsRichMediaTransferFailure(item, seen));
};

export const hasRichMediaTransferFailure = (value: unknown): boolean =>
  containsRichMediaTransferFailure(value, new WeakSet<object>());
