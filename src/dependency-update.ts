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
  proxyUrl?: string;
  signal?: AbortSignal;
}>;

export const updatePackageDependencies = async (
  options: DependencyUpdateOptions = {},
): Promise<DependencyUpdateResult> => {
  const packageJsonPath = options.packageJsonPath ?? "package.json";
  const before = await readPackageManifest(packageJsonPath);
  throwIfAborted(options.signal);
  await (options.runUpdate ?? (() => runBunUpdate(options.proxyUrl, options.signal)))();
  throwIfAborted(options.signal);
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

const runBunUpdate = async (proxyUrl = "", signal?: AbortSignal) => {
  throwIfAborted(signal);
  const child = Bun.spawn(createBunUpdateArgs(), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...(proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill();
    forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
  };
  signal?.addEventListener("abort", abort, { once: true });
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
  }
  throwIfAborted(signal);
  if (exitCode !== 0) {
    throw new Error(`bun update exited with code ${exitCode}: ${formatProcessOutput(stderr || stdout)}`);
  }
};

export const createBunUpdateArgs = () => [
  "bun",
  "update",
  "--latest",
  "--ignore-scripts",
  "--no-progress",
];

const formatProcessOutput = (output: string) =>
  output.replace(/\s+/g, " ").trim().slice(-2_000) || "no process output";

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Dependency update aborted");
  }
};
