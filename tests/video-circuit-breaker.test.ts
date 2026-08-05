import { beforeEach, describe, expect, test } from "bun:test";
import {
  formatVideoCircuitBreakerMessage,
  getVideoCircuitBreakerStatus,
  recordVideoDeliverySuccess,
  recordVideoRichMediaTransferFailure,
  resetVideoCircuitBreaker,
  VIDEO_RICH_MEDIA_COOLDOWN_MS,
} from "@/video-circuit-breaker";

describe("video rich-media circuit breaker", () => {
  beforeEach(() => {
    resetVideoCircuitBreaker();
  });

  test("disables video for 24 hours after two consecutive failures", () => {
    const now = 1_000_000;
    const first = recordVideoRichMediaTransferFailure(now);
    expect(first).toEqual({ disabled: false, consecutiveFailures: 1 });
    expect(formatVideoCircuitBreakerMessage(first, now)).toContain("如果再次出现");

    const secondAt = now + 1_000;
    const second = recordVideoRichMediaTransferFailure(secondAt);
    expect(second).toEqual({
      disabled: true,
      consecutiveFailures: 2,
      disabledUntil: secondAt + VIDEO_RICH_MEDIA_COOLDOWN_MS,
    });
    expect(formatVideoCircuitBreakerMessage(second, secondAt)).toContain("暂停使用 24 小时");
  });

  test("keeps the circuit open until the exact cooldown expiry", () => {
    const now = 2_000_000;
    recordVideoRichMediaTransferFailure(now);
    const disabled = recordVideoRichMediaTransferFailure(now + 1);
    const disabledUntil = disabled.disabledUntil!;

    expect(getVideoCircuitBreakerStatus(disabledUntil - 1).disabled).toBe(true);
    expect(getVideoCircuitBreakerStatus(disabledUntil)).toEqual({
      disabled: false,
      consecutiveFailures: 0,
    });
  });

  test("a clean video delivery resets the consecutive failure count", () => {
    const now = 3_000_000;
    recordVideoRichMediaTransferFailure(now);
    recordVideoDeliverySuccess(now + 1);
    expect(getVideoCircuitBreakerStatus(now + 1)).toEqual({
      disabled: false,
      consecutiveFailures: 0,
    });
  });

  test("failures separated by 24 hours are not consecutive", () => {
    const now = 4_000_000;
    recordVideoRichMediaTransferFailure(now);
    expect(recordVideoRichMediaTransferFailure(now + VIDEO_RICH_MEDIA_COOLDOWN_MS)).toEqual({
      disabled: false,
      consecutiveFailures: 1,
    });
  });
});
