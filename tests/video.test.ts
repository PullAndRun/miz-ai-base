import { describe, expect, test } from "bun:test";
import { isVideoDurationAllowed, MAX_VIDEO_DURATION_SECONDS } from "@/video";

describe("video duration limit", () => {
  test("allows exactly ten minutes and rejects anything longer", () => {
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS)).toBeTrue();
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS + 0.01)).toBeFalse();
  });
});
