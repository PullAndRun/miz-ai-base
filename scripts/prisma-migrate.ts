import { loadConfig } from "@/config";

const config = await loadConfig();
const source = new URL(config.postgresql.url);
const port = source.port ? `:${source.port}` : "";
const databaseUrl = `postgresql://${encodeURIComponent(config.postgresql.username)}:${encodeURIComponent(config.postgresql.password)}@${source.hostname}${port}/${encodeURIComponent(config.postgresql.database)}`;

const migrationProcess = Bun.spawn(["bunx", "prisma", "migrate", "deploy"], {
  env: {
    ...Bun.env,
    DATABASE_URL: databaseUrl,
  },
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await migrationProcess.exited);
