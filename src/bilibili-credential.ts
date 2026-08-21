import { createQrCode } from "@/qrcode";
import { fetchWithRetry, readResponseJson } from "@/http";
import { createDatabaseClient } from "@/database";
import type { PrismaClient } from "@/generated/prisma/client";

const CREDENTIAL_ID = 1;
const BILIBILI_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
  referer: "https://www.bilibili.com/",
};
const BILIBILI_TIMEOUT_MS = 15_000;
const BILIBILI_RESPONSE_BYTES = 512 * 1024;
const QR_LOGIN_TIMEOUT_MS = 5 * 60_000;
const QR_LOGIN_POLL_INTERVAL_MS = 2_000;

export type BilibiliCredential = {
  sessdata: string;
  biliJct?: string;
  buvid3?: string;
  buvid4?: string;
  dedeUserId?: string;
  acTimeValue?: string;
  extraCookies?: Record<string, string>;
};

export type BilibiliQrLoginResult =
  | { status: "scan" }
  | { status: "confirm" }
  | { status: "timeout" }
  | { status: "done"; credential: BilibiliCredential };

let loadedCredential: BilibiliCredential | undefined;
let loadedFromDatabase = false;
let credentialDatabase: PrismaClient | undefined;

export const configureBilibiliCredentialStore = (databaseUrl: string) => {
  if (credentialDatabase && credentialDatabase !== undefined) return;
  credentialDatabase = createDatabaseClient(databaseUrl);
  loadedFromDatabase = false;
  loadedCredential = undefined;
};

/** Returns the credential obtained by QR login; configured cookies are not used. */
export const getBilibiliCredentialHeader = async () => {
  const credential = await getBilibiliCredential();
  return credential ? serializeBilibiliCredential(credential) : undefined;
};

export const generateBilibiliQrLogin = async (proxyUrl = "") => {
  const response = await bilibiliFetch(
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header",
    proxyUrl,
  );
  const payload = await readResponseJson(response, BILIBILI_RESPONSE_BYTES);
  const data = asRecord(payload)?.data;
  const url = asRecord(data)?.url;
  const qrcodeKey = asRecord(data)?.qrcode_key;
  if (typeof url !== "string" || typeof qrcodeKey !== "string" || !url || !qrcodeKey) {
    throw new Error("Bilibili QR login did not return a usable QR code");
  }

  return { qrcodeKey, image: await createQrCode(url) };
};

export const pollBilibiliQrLogin = async (qrcodeKey: string, proxyUrl = ""): Promise<BilibiliQrLoginResult> => {
  const url = new URL("https://passport.bilibili.com/x/passport-login/web/qrcode/poll");
  url.search = new URLSearchParams({ qrcode_key: qrcodeKey, source: "main-fe-header" }).toString();
  const response = await bilibiliFetch(url, proxyUrl);
  const payload = await readResponseJson(response, BILIBILI_RESPONSE_BYTES);
  const record = asRecord(payload);
  const code = asRecord(record?.data)?.code ?? record?.code;
  const numericCode = typeof code === "number" ? code : Number(code);
  if (numericCode === 86101) return { status: "scan" };
  if (numericCode === 86090) return { status: "confirm" };
  if (numericCode === 86038) return { status: "timeout" };

  const data = asRecord(record?.data) ?? record;
  const loginUrl = data?.url;
  const refreshToken = data?.refresh_token;
  if (numericCode !== 0 || typeof loginUrl !== "string" || typeof refreshToken !== "string") {
    throw new Error(`Bilibili QR login failed: code ${String(code ?? "unknown")}`);
  }

  const credential = await resolveQrLoginCredential(loginUrl, refreshToken, proxyUrl);
  await saveBilibiliCredential(credential);
  return { status: "done", credential };
};

export const waitForBilibiliQrLogin = async (qrcodeKey: string, proxyUrl = "", signal?: AbortSignal) => {
  const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
  let lastStatus: BilibiliQrLoginResult["status"] = "scan";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    const result = await pollBilibiliQrLogin(qrcodeKey, proxyUrl);
    lastStatus = result.status;
    if (result.status === "done") return result.credential;
    if (result.status === "timeout") throw new Error("Bilibili QR code expired");
    await wait(QR_LOGIN_POLL_INTERVAL_MS, signal);
  }
  throw new Error(`Bilibili QR login timed out while waiting for ${lastStatus}`);
};

export const getBilibiliCredential = async () => {
  if (!loadedFromDatabase) {
    loadedFromDatabase = true;
    if (credentialDatabase) {
      const stored = await credentialDatabase.bilibiliCredential.findUnique({ where: { id: CREDENTIAL_ID } });
      loadedCredential = stored ? normalizeCredential(JSON.parse(stored.credentialJson)) : undefined;
    }
  }
  return loadedCredential;
};

export const saveBilibiliCredential = async (credential: BilibiliCredential) => {
  if (!credentialDatabase) throw new Error("Bilibili credential database is not configured");
  loadedCredential = normalizeCredential(credential);
  loadedFromDatabase = true;
  await credentialDatabase.bilibiliCredential.upsert({
    where: { id: CREDENTIAL_ID },
    create: { id: CREDENTIAL_ID, credentialJson: JSON.stringify(loadedCredential) },
    update: { credentialJson: JSON.stringify(loadedCredential) },
  });
};

export const clearBilibiliCredential = async () => {
  loadedCredential = undefined;
  loadedFromDatabase = true;
  if (credentialDatabase) {
    await credentialDatabase.bilibiliCredential.deleteMany({ where: { id: CREDENTIAL_ID } });
  }
};

export const serializeBilibiliCredential = (credential: BilibiliCredential) => {
  const values: Record<string, string> = {
    ...(credential.extraCookies ?? {}),
    SESSDATA: credential.sessdata,
  };
  if (credential.biliJct) values.bili_jct = credential.biliJct;
  if (credential.buvid3) values.buvid3 = credential.buvid3;
  if (credential.buvid4) values.buvid4 = credential.buvid4;
  if (credential.dedeUserId) values.DedeUserID = credential.dedeUserId;
  if (credential.acTimeValue) values.ac_time_value = credential.acTimeValue;
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("; ");
};

const bilibiliFetch = async (url: string | URL, proxyUrl: string, init: RequestInit = {}) => fetchWithRetry(url, {
  ...init,
  headers: { ...BILIBILI_HEADERS, ...Object.fromEntries(new Headers(init.headers).entries()) },
  ...(proxyUrl ? { proxy: proxyUrl } : {}),
  timeoutMs: BILIBILI_TIMEOUT_MS,
  retryCount: 1,
  retryRateLimited: false,
});

const resolveQrLoginCredential = async (loginUrl: string, refreshToken: string, proxyUrl: string) => {
  const values = new URL(loginUrl).searchParams;
  const direct = normalizeCredentialFromValues(values, refreshToken);
  if (direct) {
    return direct;
  }

  const cookies = await exchangeQrLoginTicket(loginUrl, proxyUrl);
  const sessdata = cookies.SESSDATA;
  if (!sessdata) throw new Error("Bilibili QR login did not return SESSDATA");
  return normalizeCredential({
    sessdata,
    biliJct: cookies.bili_jct,
    buvid3: cookies.buvid3,
    buvid4: cookies.buvid4,
    dedeUserId: cookies.DedeUserID,
    acTimeValue: refreshToken,
    extraCookies: Object.fromEntries(
      Object.entries(cookies).filter(([key]) => !["SESSDATA", "bili_jct", "buvid3", "buvid4", "DedeUserID"].includes(key)),
    ),
  });
};

const normalizeCredentialFromValues = (values: URLSearchParams, refreshToken: string) => {
  const sessdata = values.get("SESSDATA");
  if (!sessdata) {
    return undefined;
  }
  return normalizeCredential({
    sessdata,
    biliJct: values.get("bili_jct") ?? undefined,
    dedeUserId: values.get("DedeUserID") ?? undefined,
    acTimeValue: refreshToken,
  });
};

const exchangeQrLoginTicket = async (loginUrl: string, proxyUrl: string) => {
  const cookies: Record<string, string> = {};
  let currentUrl = loginUrl;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await bilibiliFetchManualRedirect(currentUrl, proxyUrl);
    for (const header of getSetCookieHeaders(response.headers)) {
      const separator = header.indexOf(";");
      const pair = separator < 0 ? header : header.slice(0, separator);
      const equals = pair.indexOf("=");
      if (equals <= 0) continue;
      const name = pair.slice(0, equals).trim();
      const rawValue = pair.slice(equals + 1).trim();
      if (!name || !rawValue) continue;
      try {
        cookies[name] = decodeURIComponent(rawValue);
      } catch {
        cookies[name] = rawValue;
      }
    }

    const location = response.headers.get("location");
    if (!location) break;
    const nextUrl = new URL(location, currentUrl);
    if (!/^https?:$/.test(nextUrl.protocol)) break;
    if (!/^(?:passport\.)?bilibili(?:\.com|\.cn)$|^passport\.biligame\.com$/.test(nextUrl.hostname)) break;
    currentUrl = nextUrl.href;
  }
  return cookies;
};

const bilibiliFetchManualRedirect = async (url: string, proxyUrl: string) => fetch(url, {
  redirect: "manual",
  headers: BILIBILI_HEADERS,
  ...(proxyUrl ? { proxy: proxyUrl } : {}),
  signal: AbortSignal.timeout(BILIBILI_TIMEOUT_MS),
});

const getSetCookieHeaders = (headers: Headers) => {
  const extendedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const values = extendedHeaders.getSetCookie?.();
  if (values && values.length > 0) {
    return values;
  }
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,\s*(?=[^;,=\s]+\s*=)/g);
};

const normalizeCredential = (value: unknown): BilibiliCredential => {
  const record = asRecord(value);
  const sessdata = record?.sessdata;
  if (typeof sessdata !== "string" || !sessdata) throw new Error("Invalid Bilibili credential");
  return {
    sessdata,
    biliJct: asString(record?.biliJct),
    buvid3: asString(record?.buvid3),
    buvid4: asString(record?.buvid4),
    dedeUserId: asString(record?.dedeUserId),
    acTimeValue: asString(record?.acTimeValue),
    extraCookies: isRecord(record?.extraCookies) ? Object.fromEntries(
      Object.entries(record.extraCookies).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ) : {},
  };
};

const asRecord = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" ? value as Record<string, any> : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const asString = (value: unknown) => typeof value === "string" && value ? value : undefined;

const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});
