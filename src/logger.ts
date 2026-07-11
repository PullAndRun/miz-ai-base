import dayjs from "dayjs";
import winston from "winston";
import type { LogLevel } from "@/config";

export type LoggerContext = "miz" | "gateway" | "plugin";

export type Logger = {
  debug(context: LoggerContext, message: string, metadata?: unknown): void;
  info(context: LoggerContext, message: string, metadata?: unknown): void;
  warn(context: LoggerContext, message: string, metadata?: unknown): void;
  error(context: LoggerContext, message: string, metadata?: unknown): void;
};

export const createLogger = (level: LogLevel = "info"): Logger => {
  const logFile = `logs/${dayjs().format("YYYY-MM-DD")}.log`;
  const logger = winston.createLogger({
    level: level === "off" ? "info" : level,
    silent: level === "off",
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp({ format: () => dayjs().format("YYYY-MM-DD HH:mm:ss.SSS") }),
      winston.format.printf(formatLogLine),
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: logFile }),
    ],
  });

  return {
    debug: (context, message, metadata) => writeLog(logger, "debug", context, message, metadata),
    info: (context, message, metadata) => writeLog(logger, "info", context, message, metadata),
    warn: (context, message, metadata) => writeLog(logger, "warn", context, message, metadata),
    error: (context, message, metadata) => writeLog(logger, "error", context, message, metadata),
  };
};

const writeLog = (
  logger: winston.Logger,
  level: "debug" | "info" | "warn" | "error",
  context: LoggerContext,
  message: string,
  metadata?: unknown,
) => {
  logger.log({
    level,
    message: redactSecrets(message),
    context,
    ...(metadata === undefined ? {} : { metadata: normalizeMetadata(metadata) }),
  });
};

const formatLogLine = (info: winston.Logform.TransformableInfo) => {
  const base = `${info.timestamp} [${info.context}] ${info.level}: ${info.message}`;
  return info.metadata === undefined ? base : `${base} ${formatMetadata(info.metadata)}`;
};

const normalizeMetadata = (metadata: unknown) => {
  if (metadata instanceof Error) {
    return {
      name: metadata.name,
      message: redactSecrets(metadata.message),
      stack: redactSecrets(metadata.stack),
    };
  }

  return redactSecrets(metadata);
};

const formatMetadata = (metadata: unknown) => {
  if (typeof metadata === "string") {
    return metadata;
  }

  try {
    return JSON.stringify(metadata);
  } catch {
    return String(metadata);
  }
};

const redactSecrets = <T>(value: T): T => redactValue(value, new WeakSet<object>());

const redactValue = <T>(value: T, seen: WeakSet<object>): T => {
  if (typeof value === "string") {
    return value.replace(
      /((?:access_)?token|password|cookie|authorization|secret|api[_-]?key|signature)(\s*[:=]\s*)(?:Bearer\s+)?([^&,;\s]+)/gi,
      "$1$2[redacted]",
    ) as T;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[circular]" as T;
    }
    seen.add(value);
    return value.map((item) => redactValue(item, seen)) as T;
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]" as T;
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|password|cookie|authorization|secret|api[_-]?key|signature/i.test(key)
          ? "[redacted]"
          : redactValue(item, seen),
      ]),
    ) as T;
  }

  return value;
};
