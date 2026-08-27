import { describe, expect, test } from "bun:test";
import { formatNewsMessages, formatScheduledNewsItems } from "@/news";
import { formatDynamicMessage, formatLiveMessage, formatLiveQueryMessage, formatOfflineMessage, getVtbNewGuardNames } from "@/vtb";
import { createWallpaperMessage } from "@/wallpaper";
import divinationPlugin from "../plugins/divination";

describe("user-facing copy", () => {
  test("live notifications are clear and avoid canned AI wording", () => {
    const message = formatLiveMessage({
      name: "示例主播",
      title: "今晚一起聊天",
      isLive: true,
      roomId: "123",
      liveStartedAt: new Date("2030-08-01T20:00:00+08:00"),
    }, 12_345, "https://live.example.test");

    expect(message).toContain("🔴 示例主播 的直播间开门啦！");
    expect(message).toContain("今天播的是——");
    expect(message).toContain("「今晚一起聊天」");
    expect(message).toContain("来得正好，一起去看看吧！");
    expect(message).not.toContain("位粉丝");
    expect(message).not.toMatch(/开播时间：|当前粉丝：|亮灯|营业|TA|传送门|舞台进行中/);

    const query = formatLiveQueryMessage({
      name: "示例主播",
      title: "今晚一起聊天",
      isLive: true,
      roomId: "123",
      liveStartedAt: new Date("2030-08-01T20:00:00+08:00"),
    }, 12_345, "https://live.example.test");
    expect(query).not.toContain("位粉丝");
  });

  test("offline and dynamic messages keep a light live atmosphere", () => {
    const offline = formatOfflineMessage(
      "示例主播",
      new Date("2030-08-01T20:00:00+08:00"),
      new Date("2030-08-01T21:00:00+08:00"),
      100,
      110,
      "123",
      "https://live.example.test",
    );
    const dynamic = formatDynamicMessage({
      author: "示例主播",
      title: "新的安排",
      description: "今晚见。",
      containsDynamicUrl: false,
      publishedAt: new Date("2030-08-01T19:00:00+08:00"),
      link: "https://t.bilibili.com/123",
    }, "https://www.example.test");

    expect(offline).toContain("🌙 示例主播 今天收工啦");
    expect(offline).toContain("这次和大家一起度过了 1 小时");
    expect(offline).toContain("充好电，我们下次见");
    expect(offline).not.toContain("🔗");
    expect(dynamic).toContain("📮 示例主播 发动态啦");
    expect(dynamic).toContain("「新的安排」");
    expect(dynamic).toContain("🔗 https://www.example.test/opus/123");
    expect(`${offline}\n${dynamic}`).not.toMatch(/下播时间：|本场新增粉丝：|发布时间：|查看原文：|小作文|TA/);
  });

  test("video dynamics use specialized copy while keeping the ordinary layout", () => {
    const message = formatDynamicMessage({
      author: "示例主播",
      title: "新视频",
      description: "视频简介",
      containsDynamicUrl: false,
      publishedAt: new Date("2030-08-01T19:00:00+08:00"),
      link: "https://www.bilibili.com/video/BV1test",
      isVideo: true,
    }, "https://www.example.test");

    expect(message).toContain("🎬 示例主播 投稿新视频啦");
    expect(message).toContain("「新视频」");
    expect(message).toContain("视频简介");
    expect(message).toContain("⏰ 08月01日 11:00 发布");
    expect(message).toContain("🔗 https://www.bilibili.com/video/BV1test");
    expect(message).not.toContain("发动态啦");
  });

  test("dynamic links show the URL directly for every dynamic type", () => {
    const dynamicTypes = [
      "DYNAMIC_TYPE_FORWARD",
      "DYNAMIC_TYPE_PGC",
      "DYNAMIC_TYPE_COURSES",
      "DYNAMIC_TYPE_WORD",
      "DYNAMIC_TYPE_DRAW",
      "DYNAMIC_TYPE_ARTICLE",
      "DYNAMIC_TYPE_MUSIC",
      "DYNAMIC_TYPE_COMMON_SQUARE",
      "DYNAMIC_TYPE_COMMON_VERTICAL",
      "DYNAMIC_TYPE_LIVE",
      "DYNAMIC_TYPE_MEDIALIST",
      "DYNAMIC_TYPE_COURSES_SEASON",
      "DYNAMIC_TYPE_COURSES_BATCH",
      "DYNAMIC_TYPE_AD",
      "DYNAMIC_TYPE_APPLET",
      "DYNAMIC_TYPE_SUBSCRIPTION",
      "DYNAMIC_TYPE_BANNER",
      "DYNAMIC_TYPE_UGC_SEASON",
      "DYNAMIC_TYPE_SUBSCRIPTION_NEW",
      "DYNAMIC_TYPE_UPOWER_COMMON",
    ];

    for (const type of dynamicTypes) {
      const message = formatDynamicMessage({
        author: "示例主播",
        title: "标题",
        description: "正文",
        containsDynamicUrl: false,
        publishedAt: new Date("2030-08-01T19:00:00Z"),
        link: "https://t.bilibili.com/123",
        type,
      }, "https://www.example.test");
      expect(message).toContain("🔗 https://www.example.test/opus/123");
      expect(message).not.toContain(" · https://www.example.test/opus/123");
    }
  });

  test("documented dynamic types use specialized headings", () => {
    const expectedHeadings: Record<string, string> = {
      DYNAMIC_TYPE_FORWARD: "🔁 示例主播 转发动态啦",
      DYNAMIC_TYPE_PGC: "📺 示例主播 番剧更新啦",
      DYNAMIC_TYPE_COURSES: "📚 示例主播 课程动态更新啦",
      DYNAMIC_TYPE_WORD: "📮 示例主播 发动态啦",
      DYNAMIC_TYPE_DRAW: "🖼️ 示例主播 晒了一组图片",
      DYNAMIC_TYPE_ARTICLE: "📖 示例主播 专栏更新啦",
      DYNAMIC_TYPE_MUSIC: "🎵 示例主播 发了一首歌",
      DYNAMIC_TYPE_COMMON_SQUARE: "📌 示例主播 发了一条动态",
      DYNAMIC_TYPE_COMMON_VERTICAL: "📌 示例主播 发了一条动态",
      DYNAMIC_TYPE_LIVE: "🔴 示例主播 分享了直播间",
      DYNAMIC_TYPE_MEDIALIST: "📚 示例主播 分享了一个收藏夹",
      DYNAMIC_TYPE_COURSES_SEASON: "📚 示例主播 课程上新啦",
      DYNAMIC_TYPE_COURSES_BATCH: "📚 示例主播 一批课程上新啦",
      DYNAMIC_TYPE_AD: "📣 示例主播 推广内容来啦",
      DYNAMIC_TYPE_APPLET: "🧩 示例主播 安利了个小程序",
      DYNAMIC_TYPE_SUBSCRIPTION: "🔔 示例主播 预约提醒来啦",
      DYNAMIC_TYPE_BANNER: "📰 示例主播 发了条公告",
      DYNAMIC_TYPE_UGC_SEASON: "🎞️ 示例主播 视频合集更新啦",
      DYNAMIC_TYPE_SUBSCRIPTION_NEW: "🔔 示例主播 预约提醒来啦",
      DYNAMIC_TYPE_UPOWER_COMMON: "⚡ 示例主播 充电动态来啦",
    };

    for (const [type, heading] of Object.entries(expectedHeadings)) {
      const message = formatDynamicMessage({
        author: "示例主播",
        title: "标题",
        description: "正文",
        containsDynamicUrl: false,
        publishedAt: new Date("2030-08-01T19:00:00Z"),
        link: "https://t.bilibili.com/123",
        type,
      }, "https://www.example.test");
      expect(message).toContain(heading);
    }
  });

  test("offline notifications show only positive live statistic changes", () => {
    const increased = formatOfflineMessage(
      "主播",
      new Date("2030-08-01T20:00:00+08:00"),
      new Date("2030-08-01T21:00:00+08:00"),
      100,
      110,
      "123",
      "https://live.example.test",
      { fanClub: 20, guards: 4 },
      { fanClub: 23, guards: 4 },
    );
    expect(increased).toContain("本场新关注 +10");
    expect(increased).toContain("本场粉丝团 +3");
    expect(increased).not.toContain("大航海");

    const noBaseline = formatOfflineMessage(
      "主播",
      new Date("2030-08-01T20:00:00+08:00"),
      new Date("2030-08-01T21:00:00+08:00"),
      undefined,
      110,
      undefined,
      "",
      {},
      { fanClub: 23, guards: 4 },
    );
    expect(noBaseline).not.toContain("本场新关注");
    expect(noBaseline).not.toContain("粉丝团");
    expect(noBaseline).not.toContain("大航海");
  });

  test("thanks only for one to five guards newly present at the end", () => {
    const start = { ids: ["1"], names: ["续舰"], captured: true };
    const end = { ids: ["1", "2", "3"], names: ["续舰", "甲", "乙"], captured: true };
    expect(getVtbNewGuardNames(start, end)).toEqual(["甲", "乙"]);
    const offline = formatOfflineMessage(
      "主播", new Date("2030-08-01T20:00:00+08:00"), new Date("2030-08-01T21:00:00+08:00"),
      undefined, undefined, undefined, "", {}, {}, ["甲", "乙"],
    );
    expect(offline).toContain("特别感谢新加入大航海的观众：\n- 甲\n- 乙");
    expect(offline).not.toContain("感谢本场上舰的观众：");
    expect(offline.indexOf("特别感谢新加入大航海的观众：")).toBeGreaterThan(offline.indexOf("⏰ 08月01日 21:00 结束"));
    expect(offline.indexOf("特别感谢新加入大航海的观众：")).toBeLessThan(offline.indexOf("辛苦啦，也谢谢大家一路陪到下播。"));
    expect(getVtbNewGuardNames(start, {
      ids: ["1", "2", "3", "4", "5", "6", "7"],
      names: ["续舰", "甲", "乙", "丙", "丁", "戊", "己"], captured: true,
    })).toEqual([]);
    expect(getVtbNewGuardNames(start, { ids: ["1"], names: ["续舰"], captured: true })).toEqual([]);
    expect(getVtbNewGuardNames(start, { ids: ["2"], names: ["甲"], captured: false })).toEqual([]);
  });

  test("offline notifications include a positive captain-count change", () => {
    const message = formatOfflineMessage(
      "主播",
      new Date("2030-08-01T20:00:00+08:00"),
      new Date("2030-08-01T21:00:00+08:00"),
      undefined,
      undefined,
      undefined,
      "",
      { guards: 4 },
      { guards: 7 },
    );
    expect(message).toContain("+3");
  });

  test("dynamic messages omit duplicated title or description text", () => {
    const shared = {
      author: "主播",
      containsDynamicUrl: false,
      publishedAt: new Date("2030-08-01T19:00:00+08:00"),
      link: "https://t.bilibili.com/123",
    };
    const titleContainsDescription = formatDynamicMessage({
      ...shared,
      title: "安排：今晚视频全文内容",
      description: "今晚视频全文内容",
    }, "https://www.example.test");
    expect(titleContainsDescription).toContain("「安排：今晚视频全文内容」");
    expect(titleContainsDescription.match(/今晚视频全文内容/g)).toHaveLength(1);

    const descriptionContainsTitle = formatDynamicMessage({
      ...shared,
      title: "短标题",
      description: "短标题以及更完整的正文内容",
    }, "https://www.example.test");
    expect(descriptionContainsTitle).toContain("短标题以及更完整的正文内容");
    expect(descriptionContainsTitle).not.toContain("「短标题」");

    const partiallyOverlapping = formatDynamicMessage({
      ...shared,
      title: "今晚直播预告",
      description: "直播预告与新的安排",
    }, "https://www.example.test");
    expect(partiallyOverlapping).toContain("「今晚直播预告」");
    expect(partiallyOverlapping).toContain("直播预告与新的安排");
  });

  test("VTB messages omit Bilibili emote placeholders but keep Unicode emoji", () => {
    const live = formatLiveMessage({
      name: "主播",
      title: "今晚见 [萌妹_你别惹我] 😀",
      isLive: true,
      roomId: "123",
    }, undefined, "https://live.example.test");
    const dynamic = formatDynamicMessage({
      author: "主播",
      title: "新动态 [萌妹_你别惹我] 😀",
      description: "正文 [萌妹_你别惹我] 😀",
      containsDynamicUrl: false,
      publishedAt: new Date("2030-08-01T19:00:00+08:00"),
      link: "https://t.bilibili.com/123",
    }, "https://www.example.test");

    expect(`${live}\n${dynamic}`).not.toContain("[萌妹_你别惹我]");
    expect(`${live}\n${dynamic}`).toContain("😀");

    const inlineEmote = formatDynamicMessage({
      author: "主播",
      title: "ABC[表情包]DEF",
      description: "ABC[表情包]DEF",
      containsDynamicUrl: false,
      publishedAt: new Date("2030-08-01T19:00:00+08:00"),
      link: "https://t.bilibili.com/124",
    }, "https://www.example.test");
    expect(inlineEmote).toContain("ABC DEF");
    expect(inlineEmote).not.toContain("ABCDEF");
  });

  test("general content stays natural without forcing live terminology", () => {
    const news = formatNewsMessages([{ id: "1", title: "市场更新", detail: "详情内容" }]).join("\n");
    const scheduledNews = formatScheduledNewsItems([
      { id: "1", title: "市场更新", detail: "详情内容" },
      { id: "2", title: "市场更新二" },
    ]).join("\n\n");
    const singleScheduledNews = formatScheduledNewsItems([
      { id: "1", title: "单条市场更新" },
    ]).join("\n\n");
    const wallpaper = JSON.stringify(createWallpaperMessage(
      {
        id: "wallpaper",
        date: "20300731",
        title: "山间晨雾",
        copyright: "示例版权",
        imageBase64: "AA==",
      },
      new Date(2030, 7, 1, 12),
    ));

    expect(news).toContain("新闻快讯送达 · 1 条新消息");
    expect(news).toContain("新消息已送达，感兴趣的话可以继续了解详情。");
    expect(news).not.toContain("财经");
    expect(scheduledNews).toContain("#1\n• 市场更新");
    expect(singleScheduledNews).toBe("• 单条市场更新");
    expect(scheduledNews).not.toMatch(/新闻快讯送达|条新消息|新消息已送达|继续了解详情/);
    expect(wallpaper).toContain("🌄 今日风景 · 2030年08月01日");
    expect(wallpaper).toContain("新的一天，先把这片风景送到你眼前");
    expect(wallpaper).toContain("「山间晨雾」");
    expect(wallpaper).toContain("愿它给今天添上一点好心情");
    expect(wallpaper).not.toMatch(/壁纸|保存|换上/);
    expect(`${news}\n${wallpaper}`).not.toMatch(/舞台|应援|主播/);
  });

  test("divination uses complete curated copy instead of generated-looking scores", async () => {
    let replyText = "";
    await divinationPlugin.handle!({
      command: { name: "占卜", args: "明天的安排", raw: "占卜 明天的安排" },
      reply: async (message: unknown) => {
        replyText = String(message);
      },
    } as never);

    expect(replyText).toContain("主题小签");
    expect(replyText).toContain("关于「明天的安排」：");
    expect(replyText).toContain("重要的事还是听自己的");
    expect(replyText).not.toMatch(/\d+%|仅供娱乐|心想事成/);
  });
});
