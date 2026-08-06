import { afterEach, describe, expect, test } from "bun:test";
import { createFf14PriceAlertMentionMessage, queryFf14Market } from "@/ff14";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("FF14 Universalis lookup", () => {
  test("uses the item search service integrated by Universalis and its market API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const storedItems: Array<{ queryName: string; item: { id: number; name: string } }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://tc-ffxiv-item-search-service.onrender.com/items/search?")) {
        return new Response(JSON.stringify({
          total: 1,
          items: [{ id: 7, name: "水之碎晶" }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        itemID: 7,
        listings: [],
        hasData: false,
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await queryFf14Market({
      regionKey: "猫",
      itemName: "水之碎晶",
      itemSearchApiUrl: "https://tc-ffxiv-item-search-service.onrender.com/items/search",
      marketApiUrl: "https://universalis.app/api/v2",
      proxyUrl: "http://127.0.0.1:7890",
      itemStore: {
        findFf14Item: async () => undefined,
        upsertFf14Item: async (queryName, item) => {
          storedItems.push({ queryName, item });
        },
      },
    });

    expect(result).toMatchObject({
      item: { ID: 7, Name: "水之碎晶" },
      regionName: "猫小胖",
    });
    const searchUrl = new URL(calls[0].url);
    expect(searchUrl.searchParams.get("query")).toBe("水之碎晶");
    expect(searchUrl.searchParams.get("language")).toBe("chs");
    expect(new Headers(calls[0].init?.headers).get("origin")).toBe("https://universalis.app");
    expect((calls[0].init as RequestInit & { proxy?: string }).proxy).toBe("http://127.0.0.1:7890");
    const marketUrl = new URL(calls[1].url);
    expect(`${marketUrl.origin}${marketUrl.pathname}`).toBe(
      "https://universalis.app/api/v2/%E7%8C%AB%E5%B0%8F%E8%83%96/7",
    );
    expect(marketUrl.searchParams.get("listings")).toBe("10");
    expect(marketUrl.searchParams.get("entries")).toBe("0");
    expect(storedItems).toEqual([
      { queryName: "水之碎晶", item: { id: 7, name: "水之碎晶" } },
    ]);
  });

  test("uses the database item mapping without repeating the item search request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        itemID: 7,
        listings: [],
        hasData: false,
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await queryFf14Market({
      regionKey: "猫",
      itemName: " 水之碎晶 ",
      itemSearchApiUrl: "https://tc-ffxiv-item-search-service.onrender.com/items/search",
      marketApiUrl: "https://universalis.app/api/v2",
      maxListingCount: 3,
      itemStore: {
        findFf14Item: async (queryName) => {
          expect(queryName).toBe("水之碎晶");
          return { id: 7, name: "水之碎晶" };
        },
        upsertFf14Item: async () => {
          throw new Error("cached item should not be written again");
        },
      },
    });

    expect(result?.item).toEqual({ ID: 7, Name: "水之碎晶" });
    expect(calls).toHaveLength(1);
    const marketUrl = new URL(calls[0]);
    expect(marketUrl.pathname).toBe("/api/v2/%E7%8C%AB%E5%B0%8F%E8%83%96/7");
    expect(marketUrl.searchParams.get("listings")).toBe("3");
    expect(marketUrl.searchParams.get("entries")).toBe("0");
  });
});

describe("FF14 price alert mentions", () => {
  test("creates real at segments for every configured member", () => {
    expect(createFf14PriceAlertMentionMessage([123456789, "987654321"])).toEqual([
      { type: "at", data: { qq: 123456789 } },
      { type: "text", data: { text: " " } },
      { type: "at", data: { qq: "987654321" } },
      { type: "text", data: { text: " FF14 低价提醒已触发，请查看上方行情。" } },
    ]);
  });

  test("does not mention the same member twice", () => {
    const message = createFf14PriceAlertMentionMessage([123456789, "123456789"]);
    expect(message.filter((segment) => segment.type === "at")).toHaveLength(1);
  });
});
