import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { writeFileAtomicQueued } from "./atomic-file-write";

/**
 * Finds Git Bash on Windows even when it is installed outside the Program Files
 * paths pi's `getShellConfig` checks, and records it as pi's global `shellPath`
 * (`settings.json`), the escape hatch pi consults first. Only candidates that
 * look like a real Git for Windows install are trusted; a `shellPath` whose
 * file is provably gone is removed again so pi falls back to its own search. A
 * `shellPath` whose existence cannot be decided right now (an offline network
 * volume) is kept: pi re-checks the file before it spawns a shell and falls
 * back on its own, so a path that comes back keeps working.
 *
 * Discovery order:
 * 1. `InstallPath` of `SOFTWARE\GitForWindows` under HKLM then HKCU (`reg query`).
 *    A machine-wide install is the more trusted source, so HKLM wins over HKCU.
 * 2. `bash.exe` next to `git.exe` on PATH, or in `bin` one level above it
 *    (Git for Windows keeps `git.exe` in `cmd` and `bash.exe` in `bin`).
 * 3. The Program Files fallbacks pi already searches on its own.
 */
export interface GitBashFinderDeps {
  /** Raw stdout of `reg query <key> /v InstallPath`, or undefined when absent. */
  readonly regQuery: (key: string) => string | undefined;
  /** First existing match of an executable on PATH, or undefined. */
  readonly findExecutableOnPath: (name: string) => string | undefined;
  readonly fileExists: (path: string) => boolean;
  readonly env: NodeJS.ProcessEnv;
}

// Machine-wide installs are the more trusted source, so HKLM is checked before HKCU.
const GIT_FOR_WINDOWS_KEYS = ["HKLM\\SOFTWARE\\GitForWindows", "HKCU\\SOFTWARE\\GitForWindows"];

export function parseGitForWindowsInstallPath(regStdout: string): string | undefined {
  const match = /InstallPath\s+REG_\w+\s+(.+)$/im.exec(regStdout);
  const value = match?.[1]?.trim();
  const unquoted =
    value && value.startsWith('"') && value.endsWith('"') && value.length >= 2
      ? value.slice(1, -1)
      : value;
  return unquoted ? unquoted : undefined;
}

/**
 * Structural check for a real Git for Windows install: the file name must be
 * `bash.exe`, and a paired `git.exe` must exist next to it or under the install
 * root's `cmd` or `bin` directory. Registry values are user-writable, so a bare
 * `existsSync` on `bash.exe` alone would trust any planted file.
 */
function isPairedGitBash(candidate: string, fileExists: (path: string) => boolean): boolean {
  if (win32.basename(candidate).toLowerCase() !== "bash.exe") {
    return false;
  }
  const dir = win32.dirname(candidate);
  return (
    fileExists(win32.join(dir, "git.exe")) ||
    fileExists(win32.join(dir, "..", "cmd", "git.exe")) ||
    fileExists(win32.join(dir, "..", "bin", "git.exe"))
  );
}

/**
 * A missing file only proves the path is gone when the verdict is decidable. A
 * UNC share or a drive root that does not answer can be offline right now and
 * come back, so those reads are undecidable and the path is kept. A root-less
 * relative path is undecidable too: it resolves against a cwd this check
 * cannot observe, so the path is kept. A root that answers and has no such
 * file is a firm "no".
 */
function isDefinitelyMissing(candidate: string, fileExists: (path: string) => boolean): boolean {
  if (fileExists(candidate)) {
    return false;
  }
  if (candidate.startsWith("\\\\")) {
    return false;
  }
  const root = win32.parse(candidate).root;
  return root === "" ? false : fileExists(root);
}

export function findGitBashPath(deps: GitBashFinderDeps = defaultDeps()): string | undefined {
  for (const key of GIT_FOR_WINDOWS_KEYS) {
    const stdout = deps.regQuery(key);
    const installPath = stdout === undefined ? undefined : parseGitForWindowsInstallPath(stdout);
    const candidate = installPath && win32.join(installPath, "bin", "bash.exe");
    if (
      candidate &&
      deps.fileExists(candidate) &&
      isPairedGitBash(candidate, deps.fileExists)
    ) {
      return candidate;
    }
  }
  const gitExe = deps.findExecutableOnPath("git.exe");
  if (gitExe) {
    const gitDir = win32.dirname(gitExe);
    for (const candidate of [
      win32.join(gitDir, "bash.exe"),
      win32.join(gitDir, "..", "bin", "bash.exe"),
    ]) {
      if (deps.fileExists(candidate) && isPairedGitBash(candidate, deps.fileExists)) {
        return candidate;
      }
    }
  }
  for (const root of [deps.env.ProgramFiles, deps.env["ProgramFiles(x86)"]]) {
    const candidate = root && win32.join(root, "Git", "bin", "bash.exe");
    if (candidate && deps.fileExists(candidate) && isPairedGitBash(candidate, deps.fileExists)) {
      return candidate;
    }
  }
  return undefined;
}

export interface EnsureShellPathResult {
  readonly written: boolean;
  readonly shellPath?: string;
}

/**
 * Writes the detected Git Bash path as pi's global `shellPath` when the user has
 * not set one. A `shellPath` that exists, or whose existence cannot be decided
 * right now (an offline network volume), is never overwritten. A `shellPath`
 * whose file is provably gone is deleted from `settings.json` first, so pi
 * falls back to its own discovery instead of trusting a dead path, and the
 * detection chain runs again. A settings file that does not parse is left
 * untouched.
 */
export async function ensureWindowsShellPath(
  agentDir: string,
  options?: {
    readonly platform?: NodeJS.Platform;
    readonly deps?: GitBashFinderDeps;
  },
): Promise<EnsureShellPathResult> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") {
    return { written: false };
  }
  const settingsPath = join(agentDir, "settings.json");
  const deps = options?.deps ?? defaultDeps();
  const settings = await readSettingsRecord(settingsPath);
  if (!settings) {
    return { written: false };
  }
  const existing = settings.shellPath;
  const userShellPath =
    typeof existing === "string" && existing.trim() !== "" ? existing : undefined;
  if (userShellPath && !isDefinitelyMissing(userShellPath, deps.fileExists)) {
    return { written: false, shellPath: userShellPath };
  }
  const shellPath = findGitBashPath(deps);
  if (!userShellPath && !shellPath) {
    return { written: false };
  }
  const next: Record<string, unknown> = { ...settings };
  delete next.shellPath;
  if (shellPath) {
    next.shellPath = shellPath;
  }
  await writeFileAtomicQueued(settingsPath, `${JSON.stringify(next, null, 2)}\n`, (value) => value);
  return { written: true, ...(shellPath ? { shellPath } : {}) };
}

function defaultDeps(): GitBashFinderDeps {
  return {
    regQuery,
    findExecutableOnPath,
    fileExists: existsSync,
    env: process.env,
  };
}

function regQuery(key: string): string | undefined {
  try {
    const result = spawnSync("reg", ["query", key, "/v", "InstallPath"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    return result.status === 0 && result.stdout ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

function findExecutableOnPath(name: string): string | undefined {
  try {
    const result = spawnSync("where", [name], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) {
      return undefined;
    }
    const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
    return firstMatch && existsSync(firstMatch) ? firstMatch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The settings record. A missing file (`ENOENT`) reads as `{}` so the first run
 * can write one. Any other read error aborts without writing, because the file
 * must not be replaced with a partial record.
 */
async function readSettingsRecord(
  settingsPath: string,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    console.error(`[shell-path] cannot read ${settingsPath}:`, error);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
