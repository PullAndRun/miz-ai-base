import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createBunUpdateArgs,
  DEPENDENCY_UPDATE_REGISTRY,
  findDependencyVersionChanges,
  updatePackageDependencies,
} from "@/dependency-update";

describe("package dependency updates", () => {
  test("uses the npmmirror registry during startup updates", () => {
    expect(DEPENDENCY_UPDATE_REGISTRY).toBe("https://registry.npmmirror.com");
    expect(createBunUpdateArgs()).toEqual([
      "bun",
      "update",
      "--latest",
      "--ignore-scripts",
      "--no-progress",
      "--registry",
      "https://registry.npmmirror.com",
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
});
