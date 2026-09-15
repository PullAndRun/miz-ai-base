import { chmod, rm } from "node:fs/promises";

// Keep this match narrow so transient registry or network failures never delete a valid lockfile.
const FROZEN_LOCKFILE_ERROR_MARKERS = [
  "lockfile had changes, but lockfile is frozen",
  "try re-running without --frozen-lockfile",
] as const;

const DOCKER_MEDIA_TOOL_PATHS = ["tools/yt-dlp", "tools/ffmpeg"] as const;
const INSTALL_COMMAND = ["bun", "install", "--production"] as const;

export type DockerCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type DockerCommandRunner = (
  command: readonly string[],
) => DockerCommandResult | Promise<DockerCommandResult>;

type InstallProductionDependenciesOptions = Readonly<{
  runCommand?: DockerCommandRunner;
  removeLockfile?: () => Promise<unknown>;
  writeOutput?: (result: DockerCommandResult) => void;
  warn?: (message: string) => void;
}>;

export const isFrozenLockfileError = (output: string) =>
  FROZEN_LOCKFILE_ERROR_MARKERS.some((marker) => output.includes(marker));

const runCommand = (command: readonly string[]): DockerCommandResult => {
  const result = Bun.spawnSync([...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const writeCommandOutput = ({ stdout, stderr }: DockerCommandResult) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
};

export const installProductionDependencies = async (
  options: InstallProductionDependenciesOptions = {},
) => {
  const execute = options.runCommand ?? runCommand;
  const emit = options.writeOutput ?? writeCommandOutput;
  const removeLockfile = options.removeLockfile ?? (() => rm("bun.lock", { force: true }));
  const warn = options.warn ?? console.warn;

  let result = await execute(INSTALL_COMMAND);
  emit(result);
  if (result.exitCode === 0) return;

  const output = `${result.stdout}\n${result.stderr}`;
  if (!isFrozenLockfileError(output)) {
    throw new Error(`bun install failed with exit code ${result.exitCode}`);
  }

  warn("Detected stale bun.lock; removing it and retrying dependency installation...");
  await removeLockfile();
  result = await execute(INSTALL_COMMAND);
  emit(result);
  if (result.exitCode !== 0) {
    throw new Error(`bun install retry failed with exit code ${result.exitCode}`);
  }
};

const makeDockerMediaToolsExecutable = async () => {
  await Promise.all(DOCKER_MEDIA_TOOL_PATHS.map(async (toolPath) => {
    try {
      if (await Bun.file(toolPath).exists()) {
        await chmod(toolPath, 0o755);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Could not make ${toolPath} executable; continuing startup (${reason}).`);
    }
  }));
};

const runApplication = async () => {
  const child = Bun.spawn(["bun", "run", "start:docker"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal));
  }
  return child.exited;
};

if (import.meta.main) {
  try {
    await makeDockerMediaToolsExecutable();
    await installProductionDependencies();
    process.exit(await runApplication());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {};