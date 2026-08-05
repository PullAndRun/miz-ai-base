import { describe, expect, test } from "bun:test";
import { hasRichMediaTransferFailure } from "@/rich-media-error";

describe("rich media transfer failure detection", () => {
  test("matches the NapCat error case-insensitively", () => {
    expect(hasRichMediaTransferFailure(new Error("Rich Media Transfer Failed"))).toBe(true);
  });

  test("finds the failure in nested error details and causes", () => {
    const error = new Error("send failed", {
      cause: { response: { wording: "rich media transfer failed" } },
    });
    expect(hasRichMediaTransferFailure({ error })).toBe(true);
  });

  test("finds the failure in an aggregate error", () => {
    const error = new AggregateError([
      new Error("ordinary failure"),
      new Error("rich media transfer failed: upload rejected"),
    ]);
    expect(hasRichMediaTransferFailure(error)).toBe(true);
  });

  test("handles cyclic values and ignores unrelated failures", () => {
    const value: Record<string, unknown> = { message: "ordinary send failure" };
    value.self = value;
    expect(hasRichMediaTransferFailure(value)).toBe(false);
  });
});
