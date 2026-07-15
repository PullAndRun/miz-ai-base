import { describe, expect, test } from "bun:test";
import { formatNewsMessages } from "@/news";
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

    expect(message).toContain("开播提醒");
    expect(message).toContain("示例主播 开播啦");
    expect(message).toContain("想看的可以去直播间");
    expect(message).not.toMatch(/亮灯|营业|TA|传送门|舞台进行中/);
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

    expect(offline).toContain("这场直播结束了，下次见");
    expect(dynamic).toContain("发布了新动态");
    expect(dynamic).not.toMatch(/小作文|TA/);
  });

  test("general content stays natural without forcing live terminology", () => {
    const news = formatNewsMessages([{ id: "1", title: "市场更新", detail: "详情内容" }]).join("\n");
    const wallpaper = JSON.stringify(createWallpaperMessage({
      id: "wallpaper",
      date: "20300801",
      title: "山间晨雾",
      copyright: "示例版权",
      imageBase64: "AA==",
    }));

    expect(news).toContain("财经快讯");
    expect(news).toContain("别只凭这些消息做决定");
    expect(wallpaper).toContain("每日一图 · 2030年08月01日");
    expect(wallpaper).toContain("早上好，今天想和大家分享这片风景");
    expect(wallpaper).toContain("「山间晨雾」");
    expect(wallpaper).toContain("希望它能给你带来一点好心情");
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
