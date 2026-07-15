import { describe, expect, test } from "bun:test";
import { createHelpMessages } from "../plugins/help";

describe("help menu coverage", () => {
  test("includes command plugins and excludes message-only features", () => {
    const messages = createHelpMessages("miz", [
      { name: "video", commands: ["video", "视频"], description: "发送视频" },
      { name: "repeat", commands: [], description: "复读" },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("【视频】");
    expect(messages[0]).toContain("miz video");
    expect(messages[0]).toContain("miz 视频");
    expect(messages.join("\n")).not.toContain("复读");
  });
});
