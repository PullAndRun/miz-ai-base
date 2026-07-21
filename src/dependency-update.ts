const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type DependencySection = typeof DEPENDENCY_SECTIONS[number];

type PackageManifest = Partial<Record<DependencySection, Record<string, string>>>;

export type DependencyVersionChange = Readonly<{
  name: string;
  section: DependencySection;
  from: string;
  to: string;
}>;

export type DependencyUpdateResult = Readonly<{
  changes: readonly DependencyVersionChange[];
}>;

type DependencyUpdateOptions = Readonly<{
  packageJsonPath?: string;
  runUpdate?: () => Promise<void>;
}>;

export const updatePackageDependencies = async (
  options: DependencyUpdateOptions = {},
): Promise<DependencyUpdateResult> => {
  const packageJsonPath = options.packageJsonPath ?? "package.json";
  const before = await readPackageManifest(packageJsonPath);
  await (options.runUpdate ?? runBunUpdate)();
  const after = await readPackageManifest(packageJsonPath);
  return { changes: findDependencyVersionChanges(before, after) };
};

export const findDependencyVersionChanges = (
  before: PackageManifest,
  after: PackageManifest,
): DependencyVersionChange[] => DEPENDENCY_SECTIONS.flatMap((section) => {
  const previousDependencies = before[section] ?? {};
  const currentDependencies = after[section] ?? {};
  return Object.entries(currentDependencies)
    .filter(([name, version]) => previousDependencies[name] !== undefined && previousDependencies[name] !== version)
    .map(([name, version]) => ({
      name,
      section,
      from: previousDependencies[name]!,
      to: version,
    }));
});

const readPackageManifest = async (path: string): Promise<PackageManifest> => {
  const file = Bun.file(path);
  if (!await file.exists()) {
    throw new Error(`Package manifest not found: ${path}`);
  }
  return file.json() as Promise<PackageManifest>;
};

const runBunUpdate = async () => {
  const child = Bun.spawn([
    "bun",
    "update",
    "--latest",
    "--ignore-scripts",
    "--no-progress",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`bun update exited with code ${exitCode}: ${formatProcessOutput(stderr || stdout)}`);
  }
};

const formatProcessOutput = (output: string) =>
  output.replace(/\s+/g, " ").trim().slice(-2_000) || "no process output";
