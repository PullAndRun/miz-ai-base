import { describe, expect, test } from "bun:test";
import { formatNewsMessages, formatScheduledNewsItems } from "@/news";
import { formatDynamicMessage, formatLiveMessage, formatOfflineMessage } from "@/vtb";
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
    }, 12_345);

    expect(message).toContain("🔴 示例主播 的直播间开门啦！");
    expect(message).toContain("今天播的是——");
    expect(message).toContain("「今晚一起聊天」");
    expect(message).toContain("来得正好，一起去看看吧！");
    expect(message).not.toMatch(/开播时间：|当前粉丝：|亮灯|营业|TA|传送门|舞台进行中/);
  });

  test("offline and dynamic messages keep a light live atmosphere", () => {
    const offline = formatOfflineMessage(
      "示例主播",
      new Date("2030-08-01T20:00:00+08:00"),
      new Date("2030-08-01T21:00:00+08:00"),
      100,
      110,
      "123",
    );
    const dynamic = formatDynamicMessage({
      author: "示例主播",
      title: "新的安排",
      description: "今晚见。",
      containsDynamicUrl: false,
      publishedAt: new Date("2030-08-01T19:00:00+08:00"),
      link: "https://t.bilibili.com/123",
    });

    expect(offline).toContain("🌙 示例主播 今天收工啦");
    expect(offline).toContain("这次和大家一起度过了 1 小时");
    expect(offline).toContain("充好电，我们下次见");
    expect(dynamic).toContain("📮 示例主播 发来一条新动态");
    expect(dynamic).toContain("「新的安排」");
    expect(`${offline}\n${dynamic}`).not.toMatch(/下播时间：|本场新增粉丝：|发布时间：|查看原文：|小作文|TA/);
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
    const wallpaper = JSON.stringify(createWallpaperMessage({
      id: "wallpaper",
      date: "20300801",
      title: "山间晨雾",
      copyright: "示例版权",
      imageBase64: "AA==",
    }));

    expect(news).toContain("财经快讯送达 · 1 条新消息");
    expect(news).toContain("消息跑得很快，做决定前记得再确认一下。");
    expect(scheduledNews).toContain("#1\n• 市场更新");
    expect(singleScheduledNews).toBe("• 单条市场更新");
    expect(scheduledNews).not.toMatch(/财经快讯送达|条新消息|消息跑得很快|做决定前记得再确认一下/);
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
