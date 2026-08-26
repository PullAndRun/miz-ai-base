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

  test("keeps authored line breaks and extracts draw images", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "draw-100",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: {
            desc: { text: "第一行\n\n第二行" },
            major: { draw: { items: [
              { src: "//i0.hdslb.com/first.jpg" },
              { src: "https://i0.hdslb.com/second.jpg" },
            ] } },
          },
        },
      },
    ], "主播", "https://www.bilibili.com");

    expect(feed.items[0]).toMatchObject({
      description: "第一行\n\n第二行",
      imageUrls: [
        "https://i0.hdslb.com/first.jpg",
        "https://i0.hdslb.com/second.jpg",
      ],
    });
  });

  test("extracts video thumbnails so video dynamics replace the avatar image", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "video-100",
        type: "DYNAMIC_TYPE_AV",
        modules: {
          module_author: { name: "主播", face: "//i0.hdslb.com/avatar.jpg", pub_ts: 1_753_000_000 },
          module_dynamic: {
            major: {
              archive: {
                cover: "//i0.hdslb.com/bfs/archive/video-cover.jpg",
                title: "新视频",
                jump_url: "//www.bilibili.com/video/BV1test",
              },
            },
          },
        },
      },
    ], "主播", "https://www.bilibili.com");

    expect(feed.items[0]).toMatchObject({
      isVideo: true,
      imageUrls: ["https://i0.hdslb.com/bfs/archive/video-cover.jpg"],
    });
  });

  test("removes Bilibili emoji nodes and keeps Unicode emoji", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "emoji-100",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: {
            desc: {
              text: "晚上好 [萌妹_你别惹我] 😀",
              rich_text_nodes: [
                { type: "RICH_TEXT_NODE_TYPE_TEXT", text: "晚上好 " },
                { type: "RICH_TEXT_NODE_TYPE_EMOJI", text: "[萌妹_你别惹我]", emoji: { text: "[萌妹_你别惹我]" } },
                { type: "RICH_TEXT_NODE_TYPE_TEXT", text: "😀" },
              ],
            },
          },
        },
      },
    ], "主播", "https://www.bilibili.com");

    expect(feed.items[0].description).toBe("晚上好 😀");
    expect(feed.items[0].description).not.toContain("[萌妹_你别惹我]");
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

  test("treats a draw type without images as a plain text dynamic", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        id_str: "text-100",
        type: "DYNAMIC_TYPE_DRAW",
        modules: {
          module_author: { name: "主播", pub_ts: 1_753_000_000 },
          module_dynamic: {
            desc: { text: "只有文字，没有配图" },
            major: { type: "MAJOR_TYPE_DRAW", draw: { items: [] } },
          },
        },
      },
    ], "主播", "https://www.bilibili.com");

    expect(feed.items[0]).toMatchObject({
      type: "DYNAMIC_TYPE_WORD",
    });
    expect(feed.items[0].imageUrls).toBeUndefined();
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

  test("uses the documented basic comment id and jump URL fallbacks", () => {
    const feed = parseBilibiliDynamicFeed([
      {
        basic: {
          comment_id_str: "300",
          jump_url: "//www.bilibili.com/opus/300",
        },
        modules: {
          module_author: { name: "官方主播", pub_ts: 1_753_000_000 },
          module_dynamic: { desc: { text: "官方动态" } },
        },
      },
    ], "官方主播", "https://www.bilibili.com");

    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      link: "https://www.bilibili.com/opus/300",
      description: "官方动态",
    });
  });
});
