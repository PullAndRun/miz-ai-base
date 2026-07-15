import { describe, expect, test } from "bun:test";
import { settleWithConcurrency, startWithConcurrency } from "@/concurrency";

describe("bounded concurrency", () => {
  test("preserves result order and individual failures", async () => {
    let active = 0;
    let peak = 0;
    const results = await settleWithConcurrency([30, 5, 20, 10], 2, async (delay) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(delay);
      active -= 1;
      if (delay === 20) throw new Error("expected failure");
      return delay * 2;
    });

    expect(peak).toBe(2);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 60 });
  });

  test("normalizes invalid worker counts", async () => {
    const promises = startWithConcurrency([1, 2, 3], Number.NaN, async (value) => value * 2);
    expect(await Promise.all(promises)).toEqual([2, 4, 6]);
  });
});
