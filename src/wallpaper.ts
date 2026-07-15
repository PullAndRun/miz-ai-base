import { z } from "zod";
import { fetchWithRetry, readResponseBytes } from "@/http";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;

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

let cachedWallpaper: Wallpaper | undefined;
let pendingWallpaperRequest: Promise<Wallpaper> | undefined;

/**
 * Fetches the lightweight daily metadata on every request, but only downloads
 * the image itself when Bing publishes a new wallpaper.
 */
export const getDailyWallpaper = (apiUrl: string, imageBaseUrl: string): Promise<Wallpaper> => {
  if (!pendingWallpaperRequest) {
    pendingWallpaperRequest = refreshDailyWallpaper(apiUrl, imageBaseUrl).finally(() => {
      pendingWallpaperRequest = undefined;
    });
  }

  return pendingWallpaperRequest;
};

export const createWallpaperMessage = (wallpaper: Wallpaper) => [
  {
    type: "text",
    data: {
      text: [
        `每日一图 · ${wallpaper.date ? formatDate(wallpaper.date) : "Bing 今日精选"}`,
        "早上好，今天想和大家分享这片风景。",
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
        `图片版权：${wallpaper.copyright}`,
        "希望它能给你带来一点好心情。",
      ].join("\n"),
    },
  },
];

const refreshDailyWallpaper = async (apiUrl: string, imageBaseUrl: string): Promise<Wallpaper> => {
  try {
    const image = await fetchWallpaperMetadata(apiUrl);
    const id = image.hsh ?? image.url;

    if (cachedWallpaper?.id === id) {
      return cachedWallpaper;
    }

    const imageBase64 = await fetchImageAsBase64(resolveImageUrl(image.url, imageBaseUrl));
    cachedWallpaper = {
      id,
      date: image.startdate ?? image.start_date,
      title: cleanText(image.title),
      copyright: cleanText(image.copyright) ?? "Bing 每日一图",
      imageBase64,
    };
    return cachedWallpaper;
  } catch (error) {
    if (cachedWallpaper) {
      return cachedWallpaper;
    }

    throw error;
  }
};

const fetchWallpaperMetadata = async (apiUrl: string) => {
  const response = await fetchWithRetry(apiUrl, { timeoutMs: FETCH_TIMEOUT_MS });

  const payload = bingWallpaperSchema.parse(await response.json());
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
