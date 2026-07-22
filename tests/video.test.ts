import { describe, expect, test } from "bun:test";
import {
  createYtDlpUpdateArgs,
  isBilibiliUrl,
  isVideoDurationAllowed,
  MAX_VIDEO_DURATION_SECONDS,
} from "@/video";
import { isVideoSendTimeoutError } from "../plugins/video";

describe("video duration limit", () => {
  test("allows exactly ten minutes and rejects anything longer", () => {
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS)).toBeTrue();
    expect(isVideoDurationAllowed(MAX_VIDEO_DURATION_SECONDS + 0.01)).toBeFalse();
  });
});

describe("video host configuration", () => {
  test("matches configured hosts and their subdomains", () => {
    const hosts = ["video.example.test", "short.example.test"];
    expect(isBilibiliUrl("https://www.video.example.test/video/1", hosts)).toBeTrue();
    expect(isBilibiliUrl("https://short.example.test/abc", hosts)).toBeTrue();
    expect(isBilibiliUrl("https://bilibili.com/video/1", hosts)).toBeFalse();
  });
});

describe("yt-dlp updates", () => {
  test("uses the proxy configured in miz.network", () => {
    expect(createYtDlpUpdateArgs({ proxyUrl: "http://proxy.example.test:7890" })).toEqual([
      "-U",
      "--proxy",
      "http://proxy.example.test:7890",
    ]);
  });

  test("does not pass a proxy option when miz.network has no proxy", () => {
    expect(createYtDlpUpdateArgs({ proxyUrl: "" })).toEqual(["-U"]);
  });
});

describe("video delivery timeout", () => {
  test("treats an API timeout as an unknown send result", () => {
    expect(isVideoSendTimeoutError({ code: "E_API_TIMEOUT" })).toBeTrue();
    expect(isVideoSendTimeoutError(new Error("download failed"))).toBeFalse();
  });
});
