/**
 * Shared helpers for the qa2 adversarial review suite.
 *
 * Independent QA surface: asserts the delivered tree against the plan
 * (hawkeye-kid-flash-phil-coulson.md) and the translation spec. These files
 * are review instruments, not product tests; they are outside every lane glob.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const repoRoot = resolve(__dirname, "../../../..");

export function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

export function readJson<T = Record<string, unknown>>(relPath: string): T {
  return JSON.parse(read(relPath)) as T;
}

export function exists(relPath: string): boolean {
  try {
    statSync(join(repoRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

export function isDir(relPath: string): boolean {
  try {
    return statSync(join(repoRoot, relPath)).isDirectory();
  } catch {
    return false;
  }
}

interface SurfaceFile {
  readonly rel: string;
  readonly abs: string;
}

/**
 * Walks the user-visible translation surface: desktop UI, electron main,
 * memloop bridge, and the vendored plugins. Skips dependency closures, build
 * output maps, caches, and tests so hits mean real product strings.
 */
export function walkTranslationSurface(): SurfaceFile[] {
  const roots = [
    "apps/desktop/src",
    "apps/desktop/electron",
    "packages/memloop-bridge/src",
    "packages/memloop-bridge/python/memloop",
    "vendor/plugins",
    "vendor/extensions",
  ];
  const skipDirNames = new Set([
    "node_modules",
    "deps",
    "__pycache__",
    ".git",
    "dist",
    "out",
    "release",
    "qa2",
  ]);
  const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".py", ".json"]);
  const files: SurfaceFile[] = [];
  const walk = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) continue;
        walk(child);
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot === -1) continue;
      if (!extensions.has(entry.name.slice(dot))) continue;
      files.push({ rel: relative(repoRoot, child).replaceAll("\\", "/"), abs: child });
    }
  };
  for (const root of roots) {
    walk(join(repoRoot, root));
  }
  return files;
}

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export function findHits(
  pattern: RegExp,
  options: { roots?: string[]; extensions?: string[] } = {},
): Hit[] {
  let files: SurfaceFile[];
  if (options.roots) {
    files = [];
    for (const rel of options.roots) {
      const abs = join(repoRoot, rel);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        for (const file of walkTranslationSurface()) {
          if (file.rel === rel || file.rel.startsWith(`${rel}/`)) files.push(file);
        }
      } else {
        files.push({ rel, abs });
      }
    }
  } else {
    files = walkTranslationSurface();
  }
  const hits: Hit[] = [];
  for (const file of files) {
    if (options.extensions && !options.extensions.some((ext) => file.rel.endsWith(ext))) continue;
    let text;
    try {
      text = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push({ file: file.rel, line: index + 1, text: line.trim() });
      }
      pattern.lastIndex = 0;
    });
  }
  return hits;
}
