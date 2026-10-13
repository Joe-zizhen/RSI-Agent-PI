import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ensureWindowsShellPath,
  findGitBashPath,
  parseGitForWindowsInstallPath,
  type GitBashFinderDeps,
} from "../../electron/persistence/windows-git-bash";

const REG_OUTPUT = `\r\nHKEY_CURRENT_USER\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    D:\\gitbash\\Git\r\n`;

function fakeDeps(overrides: {
  readonly reg?: Record<string, string | undefined>;
  readonly git?: string | undefined;
  readonly existing?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}): GitBashFinderDeps {
  const existing = new Set(overrides.existing ?? []);
  return {
    regQuery: (key) => overrides.reg?.[key],
    findExecutableOnPath: (name) => (name === "git.exe" ? overrides.git : undefined),
    fileExists: (path) => existing.has(path),
    env: overrides.env ?? {},
  };
}

test("git bash discovery reads the Git for Windows registry InstallPath first", () => {
  expect(parseGitForWindowsInstallPath(REG_OUTPUT)).toBe("D:\\gitbash\\Git");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  expect(
    findGitBashPath(
      fakeDeps({
        reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
        existing: [bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe")],
      }),
    ),
  ).toBe(bash);
});

test("git bash discovery falls back to the bin sibling of git.exe on PATH", () => {
  const bash = win32.join("D:\\gitroot", "bin", "bash.exe");
  expect(
    findGitBashPath(
      fakeDeps({
        git: win32.join("D:\\gitroot", "cmd", "git.exe"),
        existing: [bash, win32.join("D:\\gitroot", "cmd", "git.exe")],
      }),
    ),
  ).toBe(bash);
});

test("git bash discovery falls back to Program Files after registry and PATH miss", () => {
  const bash = win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
  expect(
    findGitBashPath(
      fakeDeps({
        env: { ProgramFiles: "C:\\Program Files" },
        existing: [bash, win32.join("C:\\Program Files", "Git", "cmd", "git.exe")],
      }),
    ),
  ).toBe(bash);
  expect(findGitBashPath(fakeDeps({}))).toBeUndefined();
});

test("ensureWindowsShellPath writes shellPath only when the user left it empty", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  const deps = fakeDeps({
    reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
    existing: [bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe"), "C:\\custom\\bash.exe"],
  });

  await writeFile(settingsPath, '{"defaultThinkingLevel":"max"}\n');
  const written = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(written).toEqual({ written: true, shellPath: bash });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
    defaultThinkingLevel: "max",
    shellPath: bash,
  });

  const alreadySet = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(alreadySet).toEqual({ written: false, shellPath: bash });

  await writeFile(settingsPath, '{"shellPath":"C:\\\\custom\\\\bash.exe"}\n');
  const untouched = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(untouched).toEqual({ written: false, shellPath: "C:\\custom\\bash.exe" });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
    shellPath: "C:\\custom\\bash.exe",
  });

  const notWindows = await ensureWindowsShellPath(agentDir, { platform: "darwin", deps });
  expect(notWindows).toEqual({ written: false });
});

test("git bash discovery prefers the machine-wide HKLM install over HKCU", () => {
  const hkcuBash = win32.join("D:\\user", "bin", "bash.exe");
  const hklmBash = win32.join("D:\\machine", "bin", "bash.exe");
  const regHkcu = `\r\nHKEY_CURRENT_USER\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    D:\\user\r\n`;
  const regHklm = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    D:\\machine\r\n`;
  const existing = [
    hkcuBash,
    win32.join("D:\\user", "cmd", "git.exe"),
    hklmBash,
    win32.join("D:\\machine", "cmd", "git.exe"),
  ];
  // Negative: a valid HKCU candidate is not taken while HKLM has one.
  expect(
    findGitBashPath(
      fakeDeps({
        reg: {
          "HKLM\\SOFTWARE\\GitForWindows": regHklm,
          "HKCU\\SOFTWARE\\GitForWindows": regHkcu,
        },
        existing,
      }),
    ),
  ).toBe(hklmBash);
  // An unusable HKLM entry falls through to HKCU instead of blocking discovery.
  expect(
    findGitBashPath(
      fakeDeps({
        reg: {
          "HKLM\\SOFTWARE\\GitForWindows": regHklm,
          "HKCU\\SOFTWARE\\GitForWindows": regHkcu,
        },
        existing: [hkcuBash, win32.join("D:\\user", "cmd", "git.exe")],
      }),
    ),
  ).toBe(hkcuBash);
});

test("ensureWindowsShellPath keeps a user-set shellPath on an unreachable network path", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  const deps = fakeDeps({
    reg: { "HKLM\\SOFTWARE\\GitForWindows": REG_OUTPUT },
    existing: [bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe")],
  });
  const networkPath = "\\\\nas\\git\\bash.exe";

  // A UNC share can be offline for a while; the missing file does not prove the
  // path is gone, so the user's key survives even when discovery has a hit.
  await writeFile(settingsPath, `${JSON.stringify({ shellPath: networkPath })}\n`);
  const kept = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(kept).toEqual({ written: false, shellPath: networkPath });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ shellPath: networkPath });
});

test("ensureWindowsShellPath keeps a user-set shellPath while its drive is unreachable", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  const deps = fakeDeps({
    reg: { "HKLM\\SOFTWARE\\GitForWindows": REG_OUTPUT },
    existing: [bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe")],
  });
  const unpluggedPath = "U:\\gitbash\\Git\\bin\\bash.exe";

  // The U: volume root does not answer (drive unplugged for now), so the path
  // is temporarily unreachable rather than provably gone.
  await writeFile(settingsPath, `${JSON.stringify({ shellPath: unpluggedPath })}\n`);
  const kept = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(kept).toEqual({ written: false, shellPath: unpluggedPath });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ shellPath: unpluggedPath });
});

test("ensureWindowsShellPath keeps a user-set shellPath that is a root-less relative path", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  const deps = fakeDeps({
    reg: { "HKLM\\SOFTWARE\\GitForWindows": REG_OUTPUT },
    existing: [bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe")],
  });
  const relativePath = win32.join("Git", "bin", "bash.exe");

  // A root-less relative path resolves against a cwd this check cannot
  // observe, so "not found here" is undecidable and the key must survive.
  await writeFile(settingsPath, `${JSON.stringify({ shellPath: relativePath })}\n`);
  const kept = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(kept).toEqual({ written: false, shellPath: relativePath });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ shellPath: relativePath });
});

test("git bash discovery strips quotes from the registry InstallPath value", () => {
  const quoted = `\r\nHKEY_CURRENT_USER\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    "D:\\gitbash\\Git"\r\n`;
  expect(parseGitForWindowsInstallPath(quoted)).toBe("D:\\gitbash\\Git");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  expect(
    findGitBashPath(
      fakeDeps({
        reg: { "HKCU\\SOFTWARE\\GitForWindows": quoted },
        existing: [bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe")],
      }),
    ),
  ).toBe(bash);
});

test("git bash discovery skips candidates without a paired git.exe", () => {
  const unpairedBash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  const pairedBash = win32.join("D:\\gitroot", "bin", "bash.exe");
  expect(
    findGitBashPath(
      fakeDeps({
        reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
        git: win32.join("D:\\gitroot", "cmd", "git.exe"),
        existing: [unpairedBash, pairedBash, win32.join("D:\\gitroot", "cmd", "git.exe")],
      }),
    ),
  ).toBe(pairedBash);
  expect(
    findGitBashPath(
      fakeDeps({
        reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
        existing: [unpairedBash],
      }),
    ),
  ).toBeUndefined();
});

test("ensureWindowsShellPath clears a stale shellPath and rediscovers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  // The C: volume answers, so a missing file there is a provably gone path.
  const deps = fakeDeps({
    reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
    existing: ["C:\\", bash, win32.join("D:\\gitbash\\Git", "cmd", "git.exe")],
  });

  // Stale shellPath with a discoverable replacement: the key is replaced, never kept stale.
  await writeFile(
    settingsPath,
    '{"defaultThinkingLevel":"max","shellPath":"C:\\\\gone\\\\bash.exe"}\n',
  );
  const replaced = await ensureWindowsShellPath(agentDir, { platform: "win32", deps });
  expect(replaced).toEqual({ written: true, shellPath: bash });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
    defaultThinkingLevel: "max",
    shellPath: bash,
  });

  // Stale shellPath with no discovery hit: the key is deleted so pi falls back to its own search.
  await writeFile(
    settingsPath,
    '{"defaultThinkingLevel":"max","shellPath":"C:\\\\gone\\\\bash.exe"}\n',
  );
  const cleared = await ensureWindowsShellPath(agentDir, {
    platform: "win32",
    deps: fakeDeps({ existing: ["C:\\"] }),
  });
  expect(cleared).toEqual({ written: true });
  expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
    defaultThinkingLevel: "max",
  });
});

test("ensureWindowsShellPath does not write when settings.json cannot be read", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  const settingsPath = join(agentDir, "settings.json");
  await mkdir(settingsPath, { recursive: true });
  await writeFile(join(settingsPath, "marker.txt"), "keep");
  const result = await ensureWindowsShellPath(agentDir, {
    platform: "win32",
    deps: fakeDeps({
      reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
      existing: [win32.join("D:\\gitbash\\Git", "bin", "bash.exe")],
    }),
  });
  expect(result).toEqual({ written: false });
  expect(await readFile(join(settingsPath, "marker.txt"), "utf8")).toBe("keep");
});

test("ensureWindowsShellPath leaves unparsable settings.json untouched", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "git-bash-shell-path-"));
  await mkdir(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, "not json");
  const bash = win32.join("D:\\gitbash\\Git", "bin", "bash.exe");
  const result = await ensureWindowsShellPath(agentDir, {
    platform: "win32",
    deps: fakeDeps({
      reg: { "HKCU\\SOFTWARE\\GitForWindows": REG_OUTPUT },
      existing: [bash],
    }),
  });
  expect(result).toEqual({ written: false });
  expect(await readFile(settingsPath, "utf8")).toBe("not json");
});
