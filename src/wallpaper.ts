import { z } from "zod";

const FETCH_TIMEOUT_MS = 20_000;

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
        "╭─「 数字艺术日报 」",
        "│ 今日的自然画卷，已为你展开",
        wallpaper.date ? `│ ${formatDate(wallpaper.date)}` : "│ 今日精选壁纸",
        "╰────────────",
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
        "「作品信息」",
        ...(wallpaper.title ? [`主题：${wallpaper.title}`] : []),
        `版权：${wallpaper.copyright}`,
        "愿这一刻的风景，为你留一处安静。",
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
      copyright: cleanText(image.copyright) ?? "Bing 每日壁纸",
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
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Wallpaper API request failed: HTTP ${response.status}`);
  }

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
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Wallpaper image download failed: HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
};

const resolveImageUrl = (url: string, imageBaseUrl: string) =>
  /^[a-z][a-z\d+.-]*:/i.test(url) ? url : new URL(url, imageBaseUrl).href;

const cleanText = (value: string | undefined) => value?.trim() || undefined;

const formatDate = (value: string) => {
  const matchedDate = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return matchedDate ? `${matchedDate[1]} 年 ${matchedDate[2]} 月 ${matchedDate[3]} 日` : value;
};
