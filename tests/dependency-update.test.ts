import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createBunUpdateArgs,
  findDependencyVersionChanges,
  updatePackageDependencies,
} from "@/dependency-update";

describe("package dependency updates", () => {
  test("keeps package checks in startup while media tools are display-only", async () => {
    const [packageJson, updateScript] = await Promise.all([
      Bun.file("package.json").json() as Promise<{ scripts: Record<string, string> }>,
      Bun.file("scripts/update-dependencies.ts").text(),
    ]);

    expect(packageJson.scripts.start).toStartWith(
      "bun run dependencies:update -- normal --display-tool-versions",
    );
    expect(packageJson.scripts.start).toContain("--startup");
    expect(updateScript).toContain("updatePackageDependencies");
    expect(updateScript).toContain("if (displayToolVersionsOnly)");
    expect(updateScript).toContain("readMediaToolVersions");
    expect(updateScript).toContain("lookupLatestMediaToolVersions");
    expect(updateScript).toContain("formatMediaToolVersion");
    expect(updateScript).toContain("STARTUP_UPDATE_TIMEOUT_MS = 30_000");
    expect(updateScript).toContain("continuing startup");
    expect(updateScript).toContain("installFfmpegForWindowsAndLinux");
    expect(updateScript).toContain("updateYtDlpBinaries");
    expect(updateScript).toContain('linux: "yt-dlp_linux"');
    expect(updateScript).toContain('targetNames = { win: "yt-dlp.exe", linux: "yt-dlp" }');
  });

  test("uses the default package registry during startup updates", () => {
    expect(createBunUpdateArgs()).toEqual([
      "bun",
      "update",
      "--latest",
      "--ignore-scripts",
      "--no-progress",
    ]);
  });

  test("reports changed runtime and development dependency versions", () => {
    expect(findDependencyVersionChanges(
      {
        dependencies: { alpha: "^1.0.0", unchanged: "^2.0.0" },
        devDependencies: { beta: "^3.0.0" },
      },
      {
        dependencies: { alpha: "^2.0.0", unchanged: "^2.0.0" },
        devDependencies: { beta: "^4.0.0" },
      },
    )).toEqual([
      { name: "alpha", section: "dependencies", from: "^1.0.0", to: "^2.0.0" },
      { name: "beta", section: "devDependencies", from: "^3.0.0", to: "^4.0.0" },
    ]);
  });

  test("runs the updater between reading the old and new manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-dependency-update-"));
    const packageJsonPath = path.join(directory, "package.json");
    try {
      await Bun.write(packageJsonPath, JSON.stringify({ dependencies: { alpha: "1.0.0" } }));

      const result = await updatePackageDependencies({
        packageJsonPath,
        runUpdate: async () => {
          await Bun.write(packageJsonPath, JSON.stringify({ dependencies: { alpha: "2.0.0" } }));
        },
      });

      expect(result.changes).toEqual([
        { name: "alpha", section: "dependencies", from: "1.0.0", to: "2.0.0" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("aborts a startup dependency update without reading a partial result", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "miz-dependency-update-timeout-"));
    const packageJsonPath = path.join(directory, "package.json");
    const controller = new AbortController();
    try {
      await Bun.write(packageJsonPath, JSON.stringify({ dependencies: { alpha: "1.0.0" } }));

      await expect(updatePackageDependencies({
        packageJsonPath,
        signal: controller.signal,
        runUpdate: async () => {
          controller.abort(new DOMException("startup update timed out", "TimeoutError"));
        },
      })).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
