/**
 * Fetches the bundled Python runtime and stages the memloop Python package
 * under `apps/desktop/runtime/` for electron-builder `extraResources`.
 *
 * - `runtime/python/` is a python-build-standalone distribution (3.11, with
 *   sqlite3). It is downloaded on demand; GitHub is the primary source and
 *   `https://gh-proxy.com/` is the fallback mirror for slow networks.
 * - `runtime/memloop-py/memloop/` is the memloop sidecar package, copied from
 *   `packages/memloop-bridge/python/memloop/` on every run.
 *
 * `apps/desktop/runtime/` is generated output and stays untracked.
 *
 * Run: node scripts/fetch-python-runtime.mjs
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { readdir, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(repoRoot, "apps", "desktop", "runtime");
const pythonRoot = path.join(runtimeRoot, "python");
const memloopPyRoot = path.join(runtimeRoot, "memloop-py");
const memloopPySource = path.join(repoRoot, "packages", "memloop-bridge", "python", "memloop");

const RELEASE_TAG = "20250612";
const CPYTHON_VERSION = "3.11.13";

function assetName() {
  if (process.platform === "win32") {
    return `cpython-${CPYTHON_VERSION}+${RELEASE_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
  }
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    return `cpython-${CPYTHON_VERSION}+${RELEASE_TAG}-${arch}-apple-darwin-install_only_stripped.tar.gz`;
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `cpython-${CPYTHON_VERSION}+${RELEASE_TAG}-${arch}-unknown-linux-gnu-install_only_stripped.tar.gz`;
}

const downloadUrls = () => {
  const asset = assetName();
  const github = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${asset}`;
  return [github, `https://gh-proxy.com/${github}`];
};

function pythonExecutable() {
  return process.platform === "win32"
    ? path.join(pythonRoot, "python.exe")
    : path.join(pythonRoot, "bin", "python3");
}

function pythonRuntimePresent() {
  return existsSync(pythonExecutable());
}

async function download(url, destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "rsi-agent-pi-build" },
    });
    if (!response.ok || response.body === null) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPythonRuntime() {
  if (pythonRuntimePresent()) {
    console.log(`[fetch-python-runtime] reuse ${pythonExecutable()}`);
    return;
  }
  await mkdir(runtimeRoot, { recursive: true });
  const archive = path.join(runtimeRoot, `python-runtime-${assetName()}`);
  let fetched = false;
  for (const url of downloadUrls()) {
    try {
      console.log(`[fetch-python-runtime] download ${url}`);
      await download(url, archive);
      fetched = true;
      break;
    } catch (error) {
      console.warn(`[fetch-python-runtime] download failed: ${String(error)}`);
    }
  }
  if (!fetched) {
    throw new Error("python-build-standalone download failed from every source");
  }
  const untar = spawnSync("tar", ["-xzf", archive, "-C", runtimeRoot], {
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  await rm(archive, { force: true });
  if (untar.status !== 0) {
    throw new Error(`tar extract failed with status ${untar.status}`);
  }
  if (!pythonRuntimePresent()) {
    throw new Error(`extracted runtime has no interpreter at ${pythonExecutable()}`);
  }
  const version = spawnSync(pythonExecutable(), ["--version"], { encoding: "utf8" });
  console.log(`[fetch-python-runtime] installed ${String(version.stdout ?? "").trim()}`);
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDir(source, destination);
    } else if (entry.isFile()) {
      await copyFile(source, destination);
    }
  }
}

async function stageMemloopPackage() {
  if (!existsSync(memloopPySource)) {
    throw new Error(`memloop Python package missing at ${memloopPySource}`);
  }
  await rm(memloopPyRoot, { recursive: true, force: true });
  await copyDir(memloopPySource, path.join(memloopPyRoot, "memloop"));
  // memloop is stdlib-only: strip pip/setuptools/venv tooling and their exes.
  // Keeps the bundle smaller and saves electron-builder from rcedit/sign passes.
  for (const junk of ["Lib/site-packages/pip", "Lib/site-packages/setuptools", "Lib/venv"]) {
    await rm(path.join(runtimeRoot, "python", junk), { recursive: true, force: true });
  }
  console.log(`[fetch-python-runtime] staged memloop-py from ${memloopPySource}`);
}

await fetchPythonRuntime();
await stageMemloopPackage();
