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
  test("drops automatic live-start recommendation dynamics", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "1238968975401943104",
        type: "DYNAMIC_TYPE_LIVE_RCMD",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: { major: { live_rcmd: { content: "live" } } },
        },
      },
      {
        id_str: "100",
        type: "DYNAMIC_TYPE_WORD",
        modules: {
          module_author: { name: "主播", pub_ts: 1_752_999_000 },
          module_dynamic: { desc: { text: "普通动态" } },
        },
      },
    ], "主播", "https://www.bilibili.com");

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].link).toBe("https://t.bilibili.com/100");
  });

  test("keeps ordinary dynamics when unused major fields are null", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "100",
        type: "DYNAMIC_TYPE_DRAW",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: {
            desc: { text: "普通图文动态" },
            major: { live_rcmd: null },
          },
        },
      },
    ], "主播", "https://www.bilibili.com");

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      title: "普通图文动态",
      link: "https://t.bilibili.com/100",
    });
  });

  test("uses the live recommendation card shape when type is omitted", () => {
    expect(parseBilibiliDynamicFeed([
      {
        id_str: "123",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: { major: { live_rcmd: {} } },
        },
      },
    ], "主播", "https://www.bilibili.com").items).toEqual([]);
  });

  test("deduplicates feed variants and falls back to dynamic_id", () => {
    const items = [
      {
        dynamic_id: "200",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_100 },
          module_dynamic: { desc: { text: "同一条动态" } },
        },
      },
      {
        id_str: "200",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: { desc: { text: "同一条动态" } },
        },
      },
    ];

    const feed = parseBilibiliDynamicFeed(items, "主播", "https://www.bilibili.com");
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].link).toBe("https://t.bilibili.com/200");
  });
});
