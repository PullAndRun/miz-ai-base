const mode = process.argv[2];

if (mode !== "normal" && mode !== "docker") {
  throw new Error("Usage: bun run scripts/start.ts <normal|docker>");
}

process.env.MIZ_RUNTIME_MODE = mode;
if (mode === "docker") {
  await createDockerConfigIfMissing();
}
const { runPrismaMigrations } = await import("./prisma-migrate");
const migrationExitCode = await runPrismaMigrations();
if (migrationExitCode !== 0) {
  throw new Error(`Database migration failed with exit code ${migrationExitCode}`);
}
await import("../src/index");

export {};

async function createDockerConfigIfMissing() {
  const dockerConfigPath = "config/app.docker.toml";
  if (await Bun.file(dockerConfigPath).exists()) {
    return;
  }

  await Bun.write(dockerConfigPath, `[miz.gateway]
url = "ws://napcat-miz:3000"

[miz.postgresql]
url = "http://postgresql:5432"

[miz.network]
proxyUrl = "http://clash:7890"

[miz.vtb]
dynamicApiUrl = "http://rsshub:1200/bilibili/user/dynamic/"
`);
}
