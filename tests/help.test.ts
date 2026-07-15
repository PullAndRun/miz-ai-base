import { describe, expect, test } from "bun:test";
import { createHelpMessages } from "../plugins/help";

describe("help menu coverage", () => {
  test("includes command plugins and excludes message-only features", () => {
    const messages = createHelpMessages("miz", [
      { name: "video", commands: ["video", "视频"], description: "发送视频" },
      { name: "repeat", commands: [], description: "复读" },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("✦ 视频");
    expect(messages[0]).toContain("指令入口：");
    expect(messages[0]).toContain("miz video");
    expect(messages[0]).toContain("miz 视频");
    expect(messages.join("\n")).not.toContain("复读");
  });

  test("covers the group collaboration commands", () => {
    const messages = createHelpMessages("miz", [
      { name: "activity", commands: ["activity", "活动"], description: "发起活动报名" },
      { name: "faq", commands: ["faq", "问答"], description: "查询群问答" },
      { name: "todo", commands: ["todo", "待办"], description: "记录群待办" },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages.join("\n")).toContain("✦ 活动报名");
    expect(messages.join("\n")).toContain("✦ 群问答");
    expect(messages.join("\n")).toContain("✦ 群待办");
  });
});
