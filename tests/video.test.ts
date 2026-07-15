import { describe, expect, test } from "bun:test";
import { isVideoDurationAllowed, MAX_VIDEO_DURATION_SECONDS } from "@/video";
import { isVideoSendTimeoutError } from "../plugins/video";

describe("video duration limit", () => {
  test("allows exactly ten minutes and rejects anything longer", () => {
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS)).toBeTrue();
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS + 0.01)).toBeFalse();
  });
});

describe("video delivery timeout", () => {
  test("treats an API timeout as an unknown send result", () => {
    expect(isVideoSendTimeoutError({ code: "E_API_TIMEOUT" })).toBeTrue();
    expect(isVideoSendTimeoutError(new Error("download failed"))).toBeFalse();
  });
});
