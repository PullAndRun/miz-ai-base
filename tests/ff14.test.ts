import { afterEach, describe, expect, test } from "bun:test";
import type { Ff14BatchItemResult, Ff14BatchResult } from "@/ff14";
import {
  createFf14PriceAlertMentionMessage,
  formatFf14BatchAlertMessages,
  formatFf14BatchMessages,
  formatFf14MarketMessages,
  getFf14LowPriceListingKeys,
  getFf14ReferencePrice,
  normalizeFf14ItemQueryName,
  queryFf14Batch,
  queryFf14Market,
  selectFf14BatchAlertItems,
  selectFf14BatchListedItems,
  selectFf14BatchSamples,
} from "@/ff14";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("FF14 Universalis lookup", () => {
  test("preserves Chinese colons in canonical item names", () => {
    const itemName = "发型样式：麻花辫丸子头";

    expect(normalizeFf14ItemQueryName(itemName)).toBe(itemName);
    expect(normalizeFf14ItemQueryName("发型样式:麻花辫丸子头")).toBe(itemName);
  });

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

  test("resolves current CN items when the search index has not caught up", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://search.example.test/items")) {
        return new Response(JSON.stringify({ total: 0, items: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("thewakingsands/ffxiv-datamining-cn")) {
        return new Response([
          "key,0,1",
          "#,Singular,Adjective",
          "int32,str,bool",
          "50327,\"发型样式：盖乌斯\",0",
          "52440,\"发型样式：麻花辫丸子头\",0",
        ].join("\n"), { headers: { "content-type": "text/csv" } });
      }
      const itemID = url.includes("/50327?") ? 50327 : 52440;
      return new Response(JSON.stringify({
        itemID,
        listings: [],
        hasData: false,
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await queryFf14Market({
      regionKey: "猫",
      itemName: "发型样式：麻花辫丸子头",
      itemSearchApiUrl: "https://search.example.test/items",
      marketApiUrl: "https://universalis.example.test/api/v2",
      itemStore: {
        findFf14Item: async () => undefined,
        upsertFf14Item: async () => undefined,
      },
    });

    expect(result?.item).toEqual({ ID: 52440, Name: "发型样式：麻花辫丸子头" });
    const gaiusResult = await queryFf14Market({
      regionKey: "猫",
      itemName: "发型样式：盖乌斯",
      itemSearchApiUrl: "https://search.example.test/items",
      marketApiUrl: "https://universalis.example.test/api/v2",
    });

    expect(gaiusResult?.item).toEqual({ ID: 50327, Name: "发型样式：盖乌斯" });
    expect(calls.filter((url) => url.includes("thewakingsands/ffxiv-datamining-cn"))).toHaveLength(1);
    expect(calls).toContainEqual(expect.stringContaining("/52440?"));
    expect(calls).toContainEqual(expect.stringContaining("/50327?"));
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

  test("falls back to a direct request after a proxy transport timeout", async () => {
    const calls: Array<{ url: string; proxy?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const proxy = (init as RequestInit & { proxy?: string } | undefined)?.proxy;
      calls.push({ url: String(input), proxy });
      if (proxy) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return new Response(JSON.stringify({
        itemID: 7,
        listings: [],
        hasData: false,
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await queryFf14Market({
      regionKey: "猫",
      itemName: "水之碎晶",
      itemSearchApiUrl: "https://search.example.test/items",
      marketApiUrl: "https://universalis.example.test/api/v2",
      proxyUrl: "http://127.0.0.1:7890",
      itemStore: {
        findFf14Item: async () => ({ id: 7, name: "水之碎晶" }),
        upsertFf14Item: async () => {},
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].proxy).toBe("http://127.0.0.1:7890");
    expect(calls[1].proxy).toBeUndefined();
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

describe("FF14 low-price listing identity", () => {
  test("uses listing IDs so the same listing is only delivered once", () => {
    const market = {
      listings: [
        { listingID: "listing-a", pricePerUnit: 1, quantity: 1, total: 1, lastReviewTime: 100 },
        { listingID: "listing-b", pricePerUnit: 99, quantity: 2, total: 198 },
        { listingID: "too-expensive", pricePerUnit: 101, quantity: 1, total: 101 },
      ],
    };

    expect(getFf14LowPriceListingKeys(market, 100)).toEqual([
      "listing:listing-a",
      "listing:listing-b",
    ]);
    expect(getFf14LowPriceListingKeys({
      listings: [
        { ...market.listings[1], lastReviewTime: 999 },
        { ...market.listings[0], lastReviewTime: 999 },
      ],
    }, 100)).toEqual([
      "listing:listing-a",
      "listing:listing-b",
    ]);
  });

  test("detects a newly posted low-price listing even at the same price", () => {
    const first = getFf14LowPriceListingKeys({
      listings: [{ listingID: "listing-a", pricePerUnit: 1, quantity: 1, total: 1 }],
    }, 100);
    const next = getFf14LowPriceListingKeys({
      listings: [
        { listingID: "listing-a", pricePerUnit: 1, quantity: 1, total: 1 },
        { listingID: "listing-new", pricePerUnit: 1, quantity: 1, total: 1 },
      ],
    }, 100);

    expect(next.filter((listingKey) => !first.includes(listingKey))).toEqual([
      "listing:listing-new",
    ]);
  });
});

describe("FF14 market message formatting", () => {
  test("omits summary price entries that do not have a quote", () => {
    const messages = formatFf14MarketMessages({
      item: { ID: 7, Name: "水之碎晶" },
      regionName: "猫小胖",
      market: {
        listings: [{
          pricePerUnit: 9,
          quantity: 10,
          total: 90,
          worldName: "紫水栈桥",
          hq: false,
        }],
        minPrice: 9,
        minPriceNQ: 9,
        minPriceHQ: 0,
        averagePrice: 10,
        averagePriceNQ: 10,
        listingsCount: 1,
        unitsForSale: 10,
        recentHistoryCount: 0,
      },
    });

    expect(messages[0]).toContain("最低单价 · 9 gil");
    expect(messages[0]).toContain("NQ 最低 · 9 gil");
    expect(messages[0]).not.toContain("HQ 最低");
    expect(messages[0]).not.toContain("HQ 平均");
    expect(messages[0]).not.toContain("还没有报价");
  });
});

describe("FF14 batch price query", () => {
  test("takes the cheapest listings and uses their median as the reference price", () => {
    const listings = [
      { listingID: "a", pricePerUnit: 2000, quantity: 1, total: 2000 },
      { listingID: "b", pricePerUnit: 5, quantity: 1, total: 5 },
      { listingID: "c", pricePerUnit: 120, quantity: 99, total: 11880, hq: true },
      { listingID: "d", pricePerUnit: 100, quantity: 99, total: 9900 },
      { listingID: "e", pricePerUnit: 110, quantity: 99, total: 10890 },
      { listingID: "f", pricePerUnit: 130, quantity: 99, total: 12870 },
    ];

    const samples = selectFf14BatchSamples(listings, 5);

    // 单件价排序：1 件散卖的低价挂单照样排在最前，HQ 也不会被单独往后排。
    expect(samples.map((sample) => sample.price)).toEqual([5, 100, 110, 120, 130]);
    expect(samples.map((sample) => sample.hq)).toEqual([false, false, false, true, false]);
    expect(getFf14ReferencePrice(samples.map((sample) => sample.price))).toBe(110);
    expect(getFf14ReferencePrice([100, 120])).toBe(110);
    expect(getFf14ReferencePrice([])).toBeUndefined();
  });

  test("queries every listed commodity and keeps a missing one from breaking the batch", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url.pathname);
      if (url.hostname === "raw.githubusercontent.com") {
        return new Response("key,0\n#,Singular\nint32,str\n", {
          headers: { "content-type": "text/csv" },
        });
      }
      if (url.pathname.endsWith("/items/search")) {
        const query = url.searchParams.get("query") ?? "";
        const items = query === "没上架的道具" ? [] : [{ id: query === "火之水晶" ? 7 : 8, name: query }];
        return new Response(JSON.stringify({ total: items.length, items }), {
          headers: { "content-type": "application/json" },
        });
      }

      const itemId = Number(url.pathname.split("/").at(-1));
      return new Response(JSON.stringify({
        itemID: itemId,
        listingsCount: itemId === 7 ? 2 : 0,
        lastUploadTime: 1_700_000_000_000,
        hasData: itemId === 7,
        listings: itemId === 7
          ? [
            { listingID: "cheap", pricePerUnit: 8, quantity: 1, total: 8, worldName: "神意之地" },
            { listingID: "rest", pricePerUnit: 40, quantity: 99, total: 3960, worldName: "神意之地" },
          ]
          : [],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await queryFf14Batch({
      regionKey: "猫",
      itemNames: ["火之水晶", "水之水晶", "没上架的道具"],
      itemSearchApiUrl: "https://search.example.test/items/search",
      marketApiUrl: "https://universalis.example.test/api/v2",
      sellPrice: 30,
      sampleSize: 5,
      maxListingCount: 2,
    });

    expect(result.regionName).toBe("猫小胖");
    expect(result.sampleSize).toBe(5);
    expect(result.items.map((item) => item.status)).toEqual(["ready", "empty", "missing"]);
    expect(result.items[0]).toMatchObject({
      itemName: "火之水晶",
      item: { ID: 7, Name: "火之水晶" },
      lowestPrice: 8,
      referencePrice: 24,
      sellable: false,
    });
    expect(result.items[1]).toMatchObject({ item: { ID: 8, Name: "水之水晶" }, status: "empty", samples: [] });
    expect(result.items[1].referencePrice).toBeUndefined();
    expect(requested.filter((path) => path.endsWith("/items/search"))).toHaveLength(3);
    expect(requested.some((path) => path.endsWith("/7"))).toBeTrue();
  });

  test("formats the sell summary and keeps the sampled listings visible", () => {
    const batch: Ff14BatchResult = {
      regionKey: "猫",
      regionName: "猫小胖",
      sellPrice: 100,
      sampleSize: 5,
      items: [
        {
          itemName: "火之水晶",
          item: { ID: 1, Name: "火之水晶" },
          status: "ready",
          lowestPrice: 90,
          referencePrice: 120,
          samples: [90, 100, 120, 130, 200].map((price) => ({ price, hq: false })),
          sellable: true,
        },
        {
          itemName: "水之水晶",
          item: { ID: 2, Name: "水之水晶" },
          status: "ready",
          lowestPrice: 20,
          referencePrice: 40,
          samples: [{ price: 20, hq: false }],
          sellable: false,
        },
        {
          itemName: "土之水晶",
          item: { ID: 3, Name: "土之水晶" },
          status: "empty",
          samples: [],
        },
      ],
    };

    const messages = formatFf14BatchMessages(batch);

    // 一条消息、一行一个商品，只列值得上线的。
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🪙 猫小胖 批量查价 · 3 个商品 · 售卖线 100");
    expect(messages[0]).toContain("✅ 火之水晶 120｜前5 90/100/120/130/200");
    expect(messages[0]).toContain("🔍 水之水晶 40｜在售1 20");
    expect(messages[0]).toContain("⚠️ 1 个没查到行情");
    expect(messages[0]).not.toContain("土之水晶");
  });
});

describe("FF14 batch sell alerts", () => {
  const readyItem = (
    itemName: string,
    itemId: number,
    referencePrice: number,
    sellable: boolean,
    sampleCount = 1,
  ): Ff14BatchItemResult => ({
    itemName,
    item: { ID: itemId, Name: itemName },
    status: "ready",
    lowestPrice: referencePrice - 1,
    referencePrice,
    samples: Array.from({ length: sampleCount }, (_, index) => ({
      price: referencePrice - 1 + index,
      hq: false,
    })),
    sellable,
  });

  const batch: Ff14BatchResult = {
    regionKey: "猫",
    regionName: "猫小胖",
    sellPrice: 60,
    sampleSize: 5,
    items: [
      readyItem("火之碎晶", 7, 66, true),
      readyItem("冰之碎晶", 8, 58, true),
      readyItem("风之碎晶", 9, 40, false, 5),
      { itemName: "土之碎晶", item: { ID: 10, Name: "土之碎晶" }, status: "empty", samples: [] },
    ],
  };

  const alertedNames = (notifiedPrices: ReadonlyMap<number, number>) =>
    selectFf14BatchAlertItems(batch, notifiedPrices).map((item) => item.itemName);

  test("alerts a price that was never notified before", () => {
    expect(alertedNames(new Map())).toEqual(["火之碎晶", "冰之碎晶"]);
  });

  test("does not repeat the same price level", () => {
    expect(alertedNames(new Map([[7, 66], [8, 58]]))).toEqual([]);
    expect(alertedNames(new Map([[7, 66], [8, 57]]))).toEqual(["冰之碎晶"]);
  });

  test("alerts again once the reference price changes", () => {
    expect(alertedNames(new Map([[7, 65], [8, 58]]))).toEqual(["火之碎晶"]);
    expect(alertedNames(new Map([[7, 70], [8, 58]]))).toEqual(["火之碎晶"]);
  });

  test("only lists items above the sell line", () => {
    expect(selectFf14BatchListedItems(batch).map((item) => item.itemName)).toEqual(["火之碎晶", "冰之碎晶"]);
    expect(selectFf14BatchListedItems({ ...batch, sellPrice: undefined }).map((item) => item.itemName))
      .toEqual(["火之碎晶", "冰之碎晶", "风之碎晶"]);
  });

  test("also lists and alerts a thin market below the sell line", () => {
    const thin = readyItem("雷之碎晶", 11, 30, false);
    const thinBatch: Ff14BatchResult = { ...batch, items: [thin] };

    expect(selectFf14BatchListedItems(thinBatch).map((item) => item.itemName)).toEqual(["雷之碎晶"]);
    expect(selectFf14BatchAlertItems(thinBatch, new Map()).map((item) => item.itemName)).toEqual(["雷之碎晶"]);
    // 价位没变就不再提醒。
    expect(selectFf14BatchAlertItems(thinBatch, new Map([[11, 30]]))).toEqual([]);
    // 在售 5 条以上就不算稀薄行情了。
    const deep = { ...thin, samples: Array.from({ length: 5 }, () => ({ price: 30, hq: false })) };
    expect(selectFf14BatchListedItems({ ...batch, items: [deep] })).toEqual([]);
  });

  test("never alerts items below the sell line or without market data", () => {
    // 风之碎晶没到售卖线、土之碎晶没有行情，即使价位和记录不同也不会提醒。
    expect(alertedNames(new Map([[7, 66], [8, 58], [9, 30], [10, 30]]))).toEqual([]);
  });

  test("formats the sell alert as one compact node", () => {
    const messages = formatFf14BatchAlertMessages({ ...batch, items: [batch.items[0]] });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🪙 售卖提醒 · 猫小胖 · 售卖线 60");
    expect(messages[0]).toContain("✅ 火之碎晶 66｜在售1 65");
  });

  test("mentions configured members with the sell alert wording", () => {
    expect(createFf14PriceAlertMentionMessage([123, 123], "FF14 售卖提醒已触发，请查看上方行情。")).toEqual([
      { type: "at", data: { qq: 123 } },
      { type: "text", data: { text: " FF14 售卖提醒已触发，请查看上方行情。" } },
    ]);
  });
});