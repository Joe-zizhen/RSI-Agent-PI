/**
 * WARNING: Rebuilding `vendor/plugins/` overwrites the Chinese localization.
 * 警告：重建会覆盖中文化。Re-run localization after any rebuild.
 *
 * Rebuilds `vendor/plugins/` from the pi agent's installed npm packages so the
 * desktop app can seed them without a network install (stage C, zero-install).
 *
 * Source of truth: `~/.pi/agent/npm/node_modules` (the packages as pi loads
 * them). Run with `node scripts/build-vendored-plugins.mjs`.
 *
 * Layout produced:
 *   vendor/plugins/<name>/        the six bundled plugins + @juicesharp/rpiv-i18n SDK
 *   vendor/plugins/deps/<name>/   flat production dependency closure they import
 *
 * Each package keeps its runtime files (package.json + what its `pi` manifest
 * and imports need) and drops nested `node_modules`, tests, docs, and media.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(repoRoot, "vendor");
const srcRoot =
  process.env.PI_PLUGIN_SRC_ROOT ?? join(homedir(), ".pi", "agent", "npm", "node_modules");

/** Bundled plugin packages. `keep` lists the runtime files each one loads or imports. */
const PLUGINS = {
  "pi-web-access": { keep: ["package.json", "dist", "LICENSE"] },
  "pi-subagents": {
    keep: ["package.json", "index.js", "src", "skills", "prompts", "agents", "LICENSE"],
    keepFiles: [/\.mjs$/],
    dropNames: [
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "index.d.ts",
      "index.d.ts.map",
      "index.js.map",
    ],
  },
  "@juicesharp/rpiv-todo": {
    keep: [
      "package.json",
      "config.ts",
      "index.ts",
      "todo.ts",
      "todo-overlay.ts",
      "state",
      "tool",
      "view",
      "locales",
      "LICENSE",
    ],
  },
  "@juicesharp/rpiv-ask-user-question": {
    keep: [
      "package.json",
      "ask-user-question.ts",
      "config.ts",
      "events.ts",
      "index.ts",
      "reconcile.ts",
      "rpc-fallback.ts",
      "state",
      "tool",
      "view",
      "locales",
      "LICENSE",
    ],
  },
  "pi-powerline-footer": {
    keep: ["package.json", "bash-mode", "queue", "LICENSE"],
    keepFiles: [/\.ts$/, /\.json$/],
    dropNames: ["tsconfig.json", "theme.example.json"],
  },
  "@narumitw/pi-usage": { keep: ["package.json", "dist", "LICENSE"] },
  "@juicesharp/rpiv-i18n": {
    keep: ["package.json", "index.ts", "i18n.ts", "i18n-ui.ts", "loader.ts", "LICENSE"],
  },
};

/** Files and folders never copied for dependency packages. */
const DEP_DROP_DIRS = new Set(["node_modules", "docs", "doc", "test", "tests", "__tests__"]);
const DEP_DROP_FILES = /\.(\d\.)?map$|\.tsbuildinfo$/;

function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function findDepDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function depClosure() {
  const roots = Object.keys(PLUGINS);
  const found = new Map();
  const queue = roots.map((name) => ({ name, from: srcRoot }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (found.has(name)) continue;
    const dir = findDepDir(name, from);
    if (!dir) throw new Error(`Dependency ${name} not installed under ${srcRoot}`);
    found.set(name, dir);
    for (const dep of Object.keys(readPkg(dir).dependencies ?? {})) {
      queue.push({ name: dep, from: dir });
    }
  }
  for (const root of roots) found.delete(root);
  return found;
}

function copyTree(from, to, acceptEntry) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!acceptEntry(entry.name, entry.isDirectory())) continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest, acceptEntry);
    } else if (entry.isFile()) {
      cpSync(src, dest);
    }
  }
}

function vendorPlugin(name, spec, srcDir) {
  const dest = join(vendorRoot, "plugins", name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const keepDirs = new Set(
    spec.keep.filter(
      (entry) => existsSync(join(srcDir, entry)) && statSync(join(srcDir, entry)).isDirectory(),
    ),
  );
  const dropNames = new Set(spec.dropNames ?? []);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const isKeepFile =
      entry.isFile() && spec.keep.includes(entry.name) && !dropNames.has(entry.name);
    const isKeepByPattern =
      entry.isFile() &&
      !spec.keep.includes(entry.name) &&
      !dropNames.has(entry.name) &&
      (spec.keepFiles ?? []).some((pattern) => pattern.test(entry.name));
    if (keepDirs.has(entry.name)) {
      copyTree(join(srcDir, entry.name), join(dest, entry.name), (childName, isDir) => {
        if (isDir)
          return childName !== "node_modules" && childName !== "docs" && childName !== "test";
        return !dropNames.has(childName) && !childName.endsWith(".map");
      });
    } else if (isKeepFile || isKeepByPattern) {
      cpSync(join(srcDir, entry.name), join(dest, entry.name));
    }
  }
  return { name, files: countFiles(dest) };
}

function vendorDep(name, srcDir) {
  const dest = join(vendorRoot, "plugins", "deps", name);
  rmSync(dest, { recursive: true, force: true });
  copyTree(srcDir, dest, (entryName, isDir) => {
    if (isDir) return !DEP_DROP_DIRS.has(entryName);
    return !DEP_DROP_FILES.test(entryName);
  });
  return { name, files: countFiles(dest) };
}

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

rmSync(join(vendorRoot, "plugins"), { recursive: true, force: true });
const report = [];
for (const [name, spec] of Object.entries(PLUGINS)) {
  const srcDir = join(srcRoot, name);
  if (!existsSync(join(srcDir, "package.json"))) {
    throw new Error(`Plugin source missing: ${srcDir}`);
  }
  report.push(vendorPlugin(name, spec, srcDir));
}
for (const [name, dir] of depClosure()) {
  report.push(vendorDep(name, dir));
}
for (const entry of report) {
  console.log(`${entry.name}\t${entry.files} files`);
}
console.log(`vendored ${report.length} packages into ${join(vendorRoot, "plugins")}`);
