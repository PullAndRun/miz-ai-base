import { describe, expect, test } from "bun:test";
import type { MizConfig } from "@/config";
import { deliverUnsentNews, type News } from "@/news";

describe("news delivery", () => {
  test("deduplicates repeated upstream IDs before delivery", async () => {
    const delivered: Array<readonly News[]> = [];
    const availableNews = [
      { id: "same", title: "first" },
      { id: "same", title: "duplicate" },
      { id: "other", title: "second" },
    ];
    const targetKey = `test:${crypto.randomUUID()}`;

    const fresh = await deliverUnsentNews(
      {} as MizConfig,
      "unused",
      targetKey,
      async (items) => {
        delivered.push(items);
      },
      availableNews,
    );

    expect(fresh.map((item) => item.id)).toEqual(["same", "other"]);
    expect(delivered).toHaveLength(1);
    await expect(deliverUnsentNews(
      {} as MizConfig,
      "unused",
      targetKey,
      async () => {
        throw new Error("already delivered news should not be sent again");
      },
      availableNews,
    )).resolves.toEqual([]);
  });
});
