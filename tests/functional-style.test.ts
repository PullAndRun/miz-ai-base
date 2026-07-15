import { describe, expect, test } from "bun:test";
import path from "node:path";

const SOURCE_ROOTS = ["src", "plugins", "scripts"] as const;
const CLASS_DECLARATION_PATTERN = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+[A-Za-z_$]/;
const INSTANCE_STATE_PATTERN = /\bthis\./;

describe("functional architecture", () => {
  test("project-owned source does not define classes or instance state", async () => {
    const violations: string[] = [];
    for (const root of SOURCE_ROOTS) {
      const glob = new Bun.Glob("**/*.ts");
      for await (const relativePath of glob.scan({ cwd: root })) {
        if (root === "src" && relativePath.replaceAll("\\", "/").startsWith("generated/")) {
          continue;
        }
        const filePath = path.join(root, relativePath);
        const source = await Bun.file(filePath).text();
        if (CLASS_DECLARATION_PATTERN.test(source) || INSTANCE_STATE_PATTERN.test(source)) {
          violations.push(filePath);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
