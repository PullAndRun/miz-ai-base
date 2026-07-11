import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

// Project-owned root directories. Runtime dependency folders such as
// node_modules and agent-specific .agents are intentionally excluded.
const PROJECT_DIRECTORIES = [
  "config",
  "doc",
  "github",
  "logs",
  "plugins",
  "prisma",
  "scripts",
  "src",
  "temp",
  "tools",
] as const;

export const ensureProjectDirectories = async () => {
  const created: string[] = [];
  await Promise.all(PROJECT_DIRECTORIES.map(async (directory) => {
    const target = path.join(process.cwd(), directory);
    let wasCreated: string | undefined;
    try {
      wasCreated = await mkdir(target, { recursive: true });
    } catch (error) {
      if (!isExistingPathError(error)) {
        throw error;
      }
    }
    if (wasCreated) {
      created.push(directory);
    }
    if (!(await stat(target)).isDirectory()) {
      throw new Error(`Project directory path is occupied by a file: ${directory}`);
    }
  }));

  return created.sort();
};

const isExistingPathError = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
