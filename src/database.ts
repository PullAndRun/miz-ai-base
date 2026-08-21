import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { MizConfig } from "@/config";

export const getDatabaseUrl = (config: Pick<MizConfig, "postgresql">) => {
  const host = new URL(config.postgresql.url);
  return [
    "postgresql://",
    encodeURIComponent(config.postgresql.username),
    ":",
    encodeURIComponent(config.postgresql.password),
    "@",
    host.host,
    "/",
    encodeURIComponent(config.postgresql.database),
    host.search,
  ].join("");
};

export const createDatabaseClient = (databaseUrl: string) =>
  new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
