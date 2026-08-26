import { loadConfig } from "@/config";
import { getDatabaseUrl } from "@/database";

export const runPrismaMigrations = async () => {
  const config = await loadConfig();
  const databaseUrl = getDatabaseUrl(config);

  const migrationProcess = Bun.spawn(["bunx", "--no-install", "prisma", "migrate", "deploy"], {
    env: {
      ...Bun.env,
      DATABASE_URL: databaseUrl,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  return migrationProcess.exited;
};

if (import.meta.main) {
  process.exit(await runPrismaMigrations());
}
