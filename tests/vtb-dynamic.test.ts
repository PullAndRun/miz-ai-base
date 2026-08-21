import { describe, expect, test } from "bun:test";
import { parseBilibiliDynamicFeed } from "@/vtb";

describe("Bilibili dynamic response parsing", () => {
  test("converts authenticated API items into the VTB feed shape", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "100",
        modules: {
          module_author: {
            name: "示例主播",
            face: "//i0.hdslb.com/avatar.jpg",
            pub_ts: 1_735_689_600,
          },
          module_dynamic: {
            desc: { text: "晚安" },
            major: { opus: { summary: { text: "今天也要好好休息" }, jump_url: "//www.bilibili.com/opus/100" } },
          },
        },
      },
      {
        id_str: "99",
        modules: {
          module_author: { name: "示例主播", pub_ts: 1_735_603_200 },
          module_dynamic: {
            major: { archive: { title: "新视频", desc: "视频简介" } },
          },
        },
      },
    ], "备用主播", "https://www.bilibili.com");

    expect(feed.avatarUrl).toBe("https://i0.hdslb.com/avatar.jpg");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      title: "今天也要好好休息",
      author: "示例主播",
      link: "https://www.bilibili.com/opus/100",
      description: "晚安 今天也要好好休息",
    });
    expect(feed.items[1]).toMatchObject({
      title: "新视频",
      link: "https://t.bilibili.com/99",
      description: "视频简介",
    });
  });

  test("drops items without a usable publication timestamp", () => {
    expect(parseBilibiliDynamicFeed([
      { id_str: "100", modules: { module_dynamic: {} } },
    ], "备用主播", "https://www.bilibili.com").items).toEqual([]);
  });
});
