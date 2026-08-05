export const VIDEO_RICH_MEDIA_FAILURE_THRESHOLD = 2;
export const VIDEO_RICH_MEDIA_COOLDOWN_MS = 24 * 60 * 60_000;

export type VideoCircuitBreakerStatus = Readonly<{
  disabled: boolean;
  consecutiveFailures: number;
  disabledUntil?: number;
}>;

let consecutiveFailures = 0;
let lastFailureAt = 0;
let disabledUntil = 0;

export const getVideoCircuitBreakerStatus = (
  now = Date.now(),
): VideoCircuitBreakerStatus => {
  expireVideoCircuitBreakerState(now);
  return {
    disabled: disabledUntil > now,
    consecutiveFailures,
    ...(disabledUntil > now ? { disabledUntil } : {}),
  };
};

export const recordVideoRichMediaTransferFailure = (
  now = Date.now(),
): VideoCircuitBreakerStatus => {
  expireVideoCircuitBreakerState(now);
  if (lastFailureAt > 0 && now - lastFailureAt >= VIDEO_RICH_MEDIA_COOLDOWN_MS) {
    consecutiveFailures = 0;
  }

  consecutiveFailures += 1;
  lastFailureAt = now;
  if (consecutiveFailures >= VIDEO_RICH_MEDIA_FAILURE_THRESHOLD) {
    disabledUntil = Math.max(disabledUntil, now + VIDEO_RICH_MEDIA_COOLDOWN_MS);
  }
  return getVideoCircuitBreakerStatus(now);
};

export const recordVideoDeliverySuccess = (now = Date.now()) => {
  expireVideoCircuitBreakerState(now);
  if (disabledUntil > now) {
    return;
  }
  resetVideoCircuitBreaker();
};

export const resetVideoCircuitBreaker = () => {
  consecutiveFailures = 0;
  lastFailureAt = 0;
  disabledUntil = 0;
};

export const formatVideoCircuitBreakerMessage = (
  status: VideoCircuitBreakerStatus,
  now = Date.now(),
) => {
  if (!status.disabled || status.disabledUntil === undefined) {
    return "检测到 QQ 富媒体发送失败；如果再次出现，miz video 将暂停使用 24 小时，避免继续触发风控。";
  }

  const remainingMinutes = Math.max(1, Math.ceil((status.disabledUntil - now) / 60_000));
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  const remaining = hours === 0
    ? `${minutes} 分钟`
    : minutes === 0
    ? `${hours} 小时`
    : `${hours} 小时 ${minutes} 分钟`;
  return `连续多次检测到 QQ 富媒体上传失败，为避免继续触发风控，miz video 已暂停使用 24 小时。请在约 ${remaining} 后再试。`;
};

const expireVideoCircuitBreakerState = (now: number) => {
  if (disabledUntil > 0 && disabledUntil <= now) {
    resetVideoCircuitBreaker();
  }
};
