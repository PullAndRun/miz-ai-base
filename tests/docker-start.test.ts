import { describe, expect, test } from "bun:test";
import {
  installProductionDependencies,
  isFrozenLockfileError,
  type DockerCommandResult,
} from "../scripts/start-docker";

const successfulInstall = (): DockerCommandResult => ({
  exitCode: 0,
  stdout: "installed\n",
  stderr: "",
});

describe("docker startup dependency installation", () => {
  test("detects Bun's frozen lockfile error", () => {
    expect(isFrozenLockfileError(
      "error: lockfile had changes, but lockfile is frozen\nnote: try re-running without --frozen-lockfile",
    )).toBe(true);
    expect(isFrozenLockfileError("error: connection timed out")).toBe(false);
  });

  test("does not remove the lockfile for unrelated install failures", async () => {
    let removed = false;
    const failure: DockerCommandResult = {
      exitCode: 1,
      stdout: "",
      stderr: "error: connection timed out",
    };

    await expect(installProductionDependencies({
      runCommand: () => failure,
      removeLockfile: async () => {
        removed = true;
      },
      writeOutput: () => {},
      warn: () => {},
    })).rejects.toThrow("bun install failed with exit code 1");

    expect(removed).toBe(false);
  });

  test("removes a stale lockfile and retries after the frozen lockfile error", async () => {
    const results: DockerCommandResult[] = [
      {
        exitCode: 1,
        stdout: "",
        stderr: "error: lockfile had changes, but lockfile is frozen",
      },
      successfulInstall(),
    ];
    const commands: string[][] = [];
    let removed = false;

    await installProductionDependencies({
      runCommand: (command) => {
        commands.push([...command]);
        return results.shift()!;
      },
      removeLockfile: async () => {
        removed = true;
      },
      writeOutput: () => {},
      warn: () => {},
    });

    expect(removed).toBe(true);
    expect(commands).toEqual([
      ["bun", "install", "--production"],
      ["bun", "install", "--production"],
    ]);
  });

  test("starts without touching the lockfile when installation succeeds", async () => {
    let removed = false;

    await installProductionDependencies({
      runCommand: successfulInstall,
      removeLockfile: async () => {
        removed = true;
      },
      writeOutput: () => {},
      warn: () => {},
    });

    expect(removed).toBe(false);
  });
});