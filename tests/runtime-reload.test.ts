import { describe, expect, test } from "bun:test";
import { replaceRuntimeWithFallback } from "@/runtime-reload";

describe("runtime configuration replacement", () => {
  test("continues rebuilding after the previous runtime fails to stop", async () => {
    const stopErrors: unknown[] = [];
    const result = await replaceRuntimeWithFallback({
      stopPrevious: async () => { throw new Error("stop failed"); },
      createNext: async () => "next",
      restorePrevious: async () => "previous",
      onStopError: (error) => stopErrors.push(error),
    });
    expect(result).toEqual({ applied: true, runtime: "next" });
    expect(stopErrors).toHaveLength(1);
  });

  test("restores the last good runtime when the next revision fails", async () => {
    const failure = new Error("next failed");
    const result = await replaceRuntimeWithFallback({
      stopPrevious: async () => undefined,
      createNext: async () => { throw failure; },
      restorePrevious: async () => "previous",
    });
    expect(result).toEqual({ applied: false, runtime: "previous", error: failure });
  });

  test("surfaces both failures when neither revision can start", async () => {
    await expect(replaceRuntimeWithFallback({
      stopPrevious: async () => undefined,
      createNext: async () => { throw new Error("next failed"); },
      restorePrevious: async () => { throw new Error("restore failed"); },
    })).rejects.toBeInstanceOf(AggregateError);
  });
});
