import { readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { writeFileAtomicQueued } from "./atomic-file-write";

/**
 * Seeds the bundled pi plugins and safety extensions into the user's pi agent
 * directory on startup, so the app works with zero `pi install` steps.
 *
 * Package resolution follows pi's own package manager (`package-manager.ts`):
 * a `settings.json` `packages` entry in local-path form points at a package
 * directory, and pi loads that directory's `package.json` `pi` manifest. The
 * packages are copied to `~/.pi/agent/npm/node_modules/<name>` — the same place
 * pi installs `npm:` packages (`getManagedNpmInstallPath`) — and each entry is
 * stored as a path relative to the agent directory, the form pi's
 * `normalizePackageSourceForSettings` writes for local packages.
 */

export interface PluginSeedingOptions {
  /** Bundled payload directory containing `plugins/` and `extensions/`. */
  readonly vendorDir: string;
  /** pi agent config directory, for example `~/.pi/agent`. */
  readonly agentDir: string;
}

export interface PluginSeedingResult {
  /** Package directories copied under `~/.pi/agent/npm/node_modules`. */
  readonly seededPackageDirs: readonly string[];
  /** Files copied into `~/.pi/agent/extensions`. */
  readonly seededExtensionFiles: readonly string[];
  /** `packages` entries appended to the global settings. */
  readonly addedPackagesEntries: readonly string[];
  /** True when the global settings file was rewritten. */
  readonly settingsWritten: boolean;
  /** Set when entries were missing but the settings file could not be updated. */
  readonly settingsError?: string;
}

/**
 * Bundled packages pi loads as plugins: each one gets a `settings.json`
 * `packages` entry. The other vendored packages (such as
 * `@juicesharp/rpiv-i18n`, an SDK the rpiv plugins import) are seeded as
 * libraries only: their code is resolved through node module resolution from
 * the plugin packages, not loaded as extensions.
 */
const BUNDLED_PLUGIN_ENTRIES: readonly string[] = [
  "pi-web-access",
  "pi-subagents",
  "@juicesharp/rpiv-todo",
  "@juicesharp/rpiv-ask-user-question",
  "pi-powerline-footer",
  "@narumitw/pi-usage",
];

/** Mirrors pi's `getAgentDir()` and the app store's global settings resolution. */
export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override) {
    return override.startsWith("~") ? join(homeDir, override.slice(1)) : override;
  }
  return join(homeDir, ".pi", "agent");
}

export async function seedBundledPlugins(
  options: PluginSeedingOptions,
): Promise<PluginSeedingResult> {
  const empty: PluginSeedingResult = {
    seededPackageDirs: [],
    seededExtensionFiles: [],
    addedPackagesEntries: [],
    settingsWritten: false,
  };
  // Test fixtures that launch the app with a throwaway agent dir set this to keep
  // every launch from re-copying the bundled payload; the seeding specs opt in.
  if (process.env.PI_APP_SKIP_PLUGIN_SEEDING === "1") {
    return empty;
  }
  const pluginsRoot = join(options.vendorDir, "plugins");
  if (!(await isDirectory(pluginsRoot))) {
    console.warn(`[plugin-seeding] bundled plugins missing at ${pluginsRoot}; skipping seeding`);
    return empty;
  }

  const seededPackageDirs: string[] = [];
  const addedPackagesEntries: string[] = [];

  const settings = await readGlobalSettings(options.agentDir);
  const hasPackagesList = settings.packages === undefined || Array.isArray(settings.packages);
  const packages: unknown[] = Array.isArray(settings.packages)
    ? [...(settings.packages as unknown[])]
    : [];

  for (const name of await listPackageNames(pluginsRoot)) {
    if (name === "deps") continue;
    const wantsEntry = BUNDLED_PLUGIN_ENTRIES.includes(name);
    const match = wantsEntry ? findConfiguredPackage(packages, name, options.agentDir) : undefined;
    const targetDir = match?.localTarget ?? npmNodeModulesDir(options.agentDir, name);
    if (await copyPackageIfMissing(join(pluginsRoot, name), targetDir)) {
      seededPackageDirs.push(targetDir);
    }
    if (wantsEntry && !match) {
      const entry = toSettingsEntry(options.agentDir, targetDir);
      packages.push(entry);
      addedPackagesEntries.push(entry);
    }
  }

  const depsRoot = join(pluginsRoot, "deps");
  for (const name of await listPackageNames(depsRoot)) {
    const targetDir = npmNodeModulesDir(options.agentDir, name);
    if (await copyPackageIfMissing(join(depsRoot, name), targetDir)) {
      seededPackageDirs.push(targetDir);
    }
  }

  const seededExtensionFiles = await seedExtensionFiles(
    join(options.vendorDir, "extensions"),
    join(options.agentDir, "extensions"),
  );

  let settingsWritten = false;
  let settingsError: string | undefined;
  if (addedPackagesEntries.length > 0) {
    const mergeError =
      settings.parseError ?? (hasPackagesList ? undefined : "packages is not a JSON array");
    if (mergeError) {
      settingsError = mergeError;
      console.warn(
        `[plugin-seeding] not updating ${settingsPath(options.agentDir)}: ${mergeError}`,
      );
    } else {
      const merged: Record<string, unknown> = { ...settings.value, packages };
      await writeFileAtomicQueued(
        settingsPath(options.agentDir),
        `${JSON.stringify(merged, null, 2)}\n`,
        (value) => value,
      );
      settingsWritten = true;
    }
  }

  return {
    seededPackageDirs,
    seededExtensionFiles,
    addedPackagesEntries,
    settingsWritten,
    ...(settingsError ? { settingsError } : {}),
  };
}

function settingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

function npmNodeModulesDir(agentDir: string, packageName: string): string {
  return join(agentDir, "npm", "node_modules", ...packageName.split("/"));
}

/** The `packages` entry pi stores for a local package: a path relative to the agent dir. */
function toSettingsEntry(agentDir: string, targetDir: string): string {
  return relative(agentDir, targetDir);
}

interface GlobalSettingsRead {
  readonly value: Record<string, unknown>;
  readonly packages: unknown;
  /** Set when the file exists but cannot be merged safely; its content is left untouched. */
  readonly parseError?: string;
}

async function readGlobalSettings(agentDir: string): Promise<GlobalSettingsRead> {
  let raw: string;
  try {
    raw = await readFile(settingsPath(agentDir), "utf8");
  } catch {
    return { value: {}, packages: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { value: {}, packages: [], parseError: "settings root is not a JSON object" };
    }
    const value = parsed as Record<string, unknown>;
    return { value, packages: value.packages ?? [] };
  } catch {
    return { value: {}, packages: [], parseError: "settings file does not parse as JSON" };
  }
}

interface ConfiguredPackage {
  /** For a local-path entry: the directory the entry points at. */
  readonly localTarget?: string;
}

/**
 * Finds a `packages` entry that already covers this package: an `npm:` entry
 * naming it, or a local-path entry resolving to this package's directory or
 * package name. Such an entry must not be duplicated, or pi would load the
 * package twice.
 */
function findConfiguredPackage(
  packages: readonly unknown[],
  packageName: string,
  agentDir: string,
): ConfiguredPackage | undefined {
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : packageSourceOf(entry);
    if (!source) continue;
    if (npmPackageNameOf(source) === packageName) return {};
    const localTarget = localPathOf(source);
    if (!localTarget) continue;
    const resolved = resolve(agentDir, localTarget);
    if (samePath(resolved, npmNodeModulesDir(agentDir, packageName))) {
      return { localTarget: resolved };
    }
    const installedName = readPackageNameIfExists(resolved);
    if (installedName === packageName) return { localTarget: resolved };
  }
  return undefined;
}

function packageSourceOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const source = (entry as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

/** `npm:pi-web-access@1.0.0` and `npm:@scope/name@1.0.0` both yield the bare package name. */
function npmPackageNameOf(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("npm:")) return undefined;
  const spec = trimmed.slice("npm:".length).trim();
  const versionAt = spec.startsWith("@")
    ? spec.indexOf("@", spec.indexOf("/") + 1)
    : spec.indexOf("@");
  return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

/** Local packages are the entries pi does not parse as npm:, git:, or URLs. */
function localPathOf(source: string): string | undefined {
  const trimmed = source.trim();
  if (trimmed === "") return undefined;
  for (const prefix of ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"]) {
    if (trimmed.startsWith(prefix)) return undefined;
  }
  return trimmed;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => resolve(value).replaceAll("\\", "/").toLowerCase();
  return process.platform === "win32"
    ? normalize(left) === normalize(right)
    : resolve(left) === resolve(right);
}

function readPackageNameIfExists(dir: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const name = (parsed as { name?: unknown }).name;
      return typeof name === "string" ? name : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Copies one vendored package into place. Returns true when files were written. */
async function copyPackageIfMissing(vendorPackageDir: string, targetDir: string): Promise<boolean> {
  if (await isFile(join(targetDir, "package.json"))) return false;
  await mkdir(targetDir, { recursive: true });
  await cp(vendorPackageDir, targetDir, { recursive: true, force: true });
  return true;
}

/** Copies the bundled safety extensions into the user extensions folder, skipping existing files. */
async function seedExtensionFiles(
  vendorExtensionsDir: string,
  agentExtensionsDir: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(vendorExtensionsDir);
  } catch {
    return [];
  }
  const seeded: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".ts") && !name.endsWith(".js")) continue;
    const target = join(agentExtensionsDir, name);
    if (await isFile(target)) continue;
    await mkdir(agentExtensionsDir, { recursive: true });
    await cp(join(vendorExtensionsDir, name), target);
    seeded.push(target);
  }
  return seeded;
}

/**
 * Lists npm package names in a directory tree, expanding scope directories to
 * `@scope/name`. `plugins/` holds the bundled packages (plus a `deps/` folder of
 * shared runtime dependencies); `plugins/deps/` holds only dependency packages.
 */
async function listPackageNames(root: string): Promise<string[]> {
  const names: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of await listPackageNames(join(root, entry.name))) {
        names.push(`${entry.name}/${scoped}`);
      }
      continue;
    }
    names.push(entry.name);
  }
  // Stable order so a seeded settings.json does not churn between machines.
  return names.sort();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
