import { z } from "zod";
import { createBoundedCache, readBoundedCache, writeBoundedCache } from "@/cache";
import { fetchWithRetry, readResponseBytes, readResponseJson } from "@/http";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_WALLPAPER_METADATA_BYTES = 1024 * 1024;
const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;
const MAX_WALLPAPER_CACHE_ENTRIES = 4;

const bingImageSchema = z.looseObject({
  url: z.string().min(1),
  hsh: z.string().min(1).optional(),
  startdate: z.string().min(1).optional(),
  start_date: z.string().min(1).optional(),
  copyright: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

const bingWallpaperSchema = z.looseObject({
  url: z.string().min(1).optional(),
  images: z.array(bingImageSchema).min(1).optional(),
});

type BingImage = z.infer<typeof bingImageSchema>;

export type Wallpaper = {
  id: string;
  date?: string;
  title?: string;
  copyright: string;
  imageBase64: string;
};

let cachedWallpapers = createBoundedCache<string, Wallpaper>(MAX_WALLPAPER_CACHE_ENTRIES);
const pendingWallpaperRequests = new Map<string, Promise<Wallpaper>>();

/**
 * Fetches the lightweight daily metadata on every request, but only downloads
 * the image itself when Bing publishes a new wallpaper.
 */
export const getDailyWallpaper = (apiUrl: string, imageBaseUrl: string): Promise<Wallpaper> => {
  const cacheKey = `${apiUrl}\n${imageBaseUrl}`;
  let pendingRequest = pendingWallpaperRequests.get(cacheKey);
  if (!pendingRequest) {
    pendingRequest = refreshDailyWallpaper(cacheKey, apiUrl, imageBaseUrl).finally(() => {
      pendingWallpaperRequests.delete(cacheKey);
    });
    pendingWallpaperRequests.set(cacheKey, pendingRequest);
  }

  return pendingRequest;
};

export const createWallpaperMessage = (wallpaper: Wallpaper) => [
  {
    type: "text",
    data: {
      text: [
        `🌄 今日风景 · ${wallpaper.date ? formatDate(wallpaper.date) : "Bing 今日精选"}`,
        "新的一天，先把这片风景送到你眼前。",
      ].join("\n"),
    },
  },
  {
    type: "image",
    data: {
      file: `base64://${wallpaper.imageBase64}`,
    },
  },
  {
    type: "text",
    data: {
      text: [
        ...(wallpaper.title ? [`「${wallpaper.title}」`] : []),
        `📷 图片版权 · ${wallpaper.copyright}`,
        "愿它给今天添上一点好心情。",
      ].join("\n"),
    },
  },
];

const refreshDailyWallpaper = async (
  cacheKey: string,
  apiUrl: string,
  imageBaseUrl: string,
): Promise<Wallpaper> => {
  const cachedWallpaperRead = readBoundedCache(cachedWallpapers, cacheKey);
  cachedWallpapers = cachedWallpaperRead.cache;
  const cachedWallpaper = cachedWallpaperRead.value;
  try {
    const image = await fetchWallpaperMetadata(apiUrl);
    const id = image.hsh ?? image.url;

    if (cachedWallpaper?.id === id) {
      return cachedWallpaper;
    }

    const imageBase64 = await fetchImageAsBase64(resolveImageUrl(image.url, imageBaseUrl));
    const wallpaper = {
      id,
      date: image.startdate ?? image.start_date,
      title: cleanText(image.title),
      copyright: cleanText(image.copyright) ?? "Bing 每日一图",
      imageBase64,
    };
    cachedWallpapers = writeBoundedCache(cachedWallpapers, cacheKey, wallpaper);
    return wallpaper;
  } catch (error) {
    if (cachedWallpaper) {
      return cachedWallpaper;
    }

    throw error;
  }
};

const fetchWallpaperMetadata = async (apiUrl: string) => {
  const response = await fetchWithRetry(apiUrl, { timeoutMs: FETCH_TIMEOUT_MS });

  const payload = bingWallpaperSchema.parse(
    await readResponseJson(response, MAX_WALLPAPER_METADATA_BYTES),
  );
  if (payload.images?.[0]) {
    return payload.images[0];
  }

  if (payload.url) {
    return bingImageSchema.parse(payload);
  }

  throw new Error("Wallpaper API response has no image");
};

const fetchImageAsBase64 = async (url: string) => {
  const response = await fetchWithRetry(url, { timeoutMs: FETCH_TIMEOUT_MS });

  return (await readResponseBytes(response, MAX_WALLPAPER_BYTES)).toString("base64");
};

const resolveImageUrl = (url: string, imageBaseUrl: string) =>
  /^[a-z][a-z\d+.-]*:/i.test(url) ? url : new URL(url, imageBaseUrl).href;

const cleanText = (value: string | undefined) => value?.trim() || undefined;

const formatDate = (value: string) => {
  const matchedDate = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return matchedDate ? `${matchedDate[1]}年${matchedDate[2]}月${matchedDate[3]}日` : value;
};
