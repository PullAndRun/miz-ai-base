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

  const exampleDockerConfig = Bun.file("config/example/app.docker.toml");
  if (!(await exampleDockerConfig.exists())) {
    throw new Error("Docker configuration template not found: config/example/app.docker.toml");
  }
  await Bun.write(dockerConfigPath, await exampleDockerConfig.text());
}
