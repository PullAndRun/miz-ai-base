import { describe, expect, test } from "bun:test";
import { enqueueVideoJob, tryAcquireVideoJob } from "@/video-jobs";

describe("video job admission", () => {
  test("blocks duplicate users and enforces the global concurrency limit", () => {
    const first = tryAcquireVideoJob("group-a:user-a", 2);
    const second = tryAcquireVideoJob("group-a:user-b", 2);
    try {
      expect(first.acquired).toBeTrue();
      expect(second.acquired).toBeTrue();
      expect(tryAcquireVideoJob("group-a:user-a", 2)).toEqual({
        acquired: false,
        reason: "duplicate",
      });
      expect(tryAcquireVideoJob("group-a:user-c", 2)).toEqual({
        acquired: false,
        reason: "busy",
      });
    } finally {
      if (first.acquired) {
        first.release();
      }
      if (second.acquired) {
        second.release();
      }
    }
  });

  test("release is idempotent and frees capacity", () => {
    const admission = tryAcquireVideoJob("group-b:user-a", 1);
    expect(admission.acquired).toBeTrue();
    if (!admission.acquired) {
      return;
    }
    admission.release();
    admission.release();

    const next = tryAcquireVideoJob("group-b:user-b", 1);
    expect(next.acquired).toBeTrue();
    if (next.acquired) {
      next.release();
    }
  });

  test("queues jobs in FIFO order when all slots are occupied", async () => {
    const first = enqueueVideoJob(1);
    const second = enqueueVideoJob(1);
    const order: string[] = [];
    const firstHandle = await first.ready;
    order.push("first");
    let secondStarted = false;
    const secondTask = second.ready.then((handle) => {
      secondStarted = true;
      order.push("second");
      handle.release();
    });
    expect(secondStarted).toBeFalse();
    firstHandle.release();
    await secondTask;
    expect(order).toEqual(["first", "second"]);
  });
});
