import { describe, expect, test } from "bun:test";
import {
  createBoundedCache,
  createExpiringCache,
  readBoundedCache,
  readExpiringCache,
  writeBoundedCache,
  writeExpiringCache,
} from "@/cache";

describe("bounded caches", () => {
  test("evicts the least recently used entry", () => {
    const initial = createBoundedCache<string, number>(2);
    const withFirst = writeBoundedCache(initial, "first", 1);
    const withSecond = writeBoundedCache(withFirst, "second", 2);
    const readFirst = readBoundedCache(withSecond, "first");
    const withThird = writeBoundedCache(readFirst.cache, "third", 3);

    expect(readBoundedCache(withThird, "second").value).toBeUndefined();
    expect(readBoundedCache(withThird, "first").value).toBe(1);
    expect(readBoundedCache(withThird, "third").value).toBe(3);
    expect(initial.entries).toEqual([]);
  });

  test("drops expired entries", () => {
    const initial = createExpiringCache<string, number>(2);
    const withShort = writeExpiringCache(initial, "short", 1, 0, 1_000);
    const withLong = writeExpiringCache(withShort, "long", 2, 60_000, 1_000);

    expect(readExpiringCache(withLong, "short", 1_000).value).toBeUndefined();
    expect(readExpiringCache(withLong, "long", 1_000).value).toBe(2);
  });
});
