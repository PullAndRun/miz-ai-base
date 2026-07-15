type CacheEntry<K, V> = Readonly<{
  key: K;
  value: V;
}>;

export type BoundedCache<K, V> = Readonly<{
  maximumEntries: number;
  entries: readonly CacheEntry<K, V>[];
}>;

export type ExpiringCache<K, V> = BoundedCache<K, Readonly<{
  value: V;
  expiresAt: number;
}>>;

export type CacheRead<K, V> = Readonly<{
  cache: BoundedCache<K, V>;
  value: V | undefined;
}>;

export type ExpiringCacheRead<K, V> = Readonly<{
  cache: ExpiringCache<K, V>;
  value: V | undefined;
}>;

export const createBoundedCache = <K, V>(maximumEntries: number): BoundedCache<K, V> => {
  assertMaximumEntries(maximumEntries);
  return { maximumEntries, entries: [] };
};

export const readBoundedCache = <K, V>(cache: BoundedCache<K, V>, key: K): CacheRead<K, V> => {
  const index = cache.entries.findIndex((entry) => Object.is(entry.key, key));
  if (index < 0) {
    return { cache, value: undefined };
  }

  const entry = cache.entries[index];
  if (index === cache.entries.length - 1) {
    return { cache, value: entry.value };
  }
  return {
    cache: {
      ...cache,
      entries: [
        ...cache.entries.slice(0, index),
        ...cache.entries.slice(index + 1),
        entry,
      ],
    },
    value: entry.value,
  };
};

export const writeBoundedCache = <K, V>(
  cache: BoundedCache<K, V>,
  key: K,
  value: V,
): BoundedCache<K, V> => {
  const entries = [
    ...cache.entries.filter((entry) => !Object.is(entry.key, key)),
    { key, value },
  ];
  return {
    ...cache,
    entries: entries.slice(-cache.maximumEntries),
  };
};

export const deleteBoundedCacheEntry = <K, V>(
  cache: BoundedCache<K, V>,
  key: K,
): BoundedCache<K, V> => {
  const entries = cache.entries.filter((entry) => !Object.is(entry.key, key));
  return entries.length === cache.entries.length ? cache : { ...cache, entries };
};

export const createExpiringCache = <K, V>(maximumEntries: number): ExpiringCache<K, V> =>
  createBoundedCache<K, Readonly<{ value: V; expiresAt: number }>>(maximumEntries);

export const readExpiringCache = <K, V>(
  cache: ExpiringCache<K, V>,
  key: K,
  now: number,
): ExpiringCacheRead<K, V> => {
  const result = readBoundedCache(cache, key);
  if (!result.value) {
    return { cache: result.cache, value: undefined };
  }
  if (result.value.expiresAt <= now) {
    return {
      cache: deleteBoundedCacheEntry(result.cache, key),
      value: undefined,
    };
  }
  return { cache: result.cache, value: result.value.value };
};

export const writeExpiringCache = <K, V>(
  cache: ExpiringCache<K, V>,
  key: K,
  value: V,
  timeToLiveMs: number,
  now: number,
): ExpiringCache<K, V> => {
  if (!Number.isFinite(timeToLiveMs) || timeToLiveMs < 0) {
    throw new RangeError("timeToLiveMs must be a finite non-negative number");
  }
  return writeBoundedCache(cache, key, { value, expiresAt: now + timeToLiveMs });
};

const assertMaximumEntries = (maximumEntries: number) => {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
    throw new RangeError("maximumEntries must be a positive safe integer");
  }
};
