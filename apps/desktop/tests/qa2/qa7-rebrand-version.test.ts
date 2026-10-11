/**
 * qa2-7 基座改名与 pi 版本钉死（计划书阶段 A）
 *
 * 断言：productName / 包名 / 窗口标题改名为 RSI-Agent-PI；LICENSE 署名保留；
 * pi 依赖精确钉死 1.0.0。用户可见文案不得残留旧名 pi-gui。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { findHits, read, readJson } from "./helpers";

test("改名：productName、包名、窗口标题为 RSI-Agent-PI", () => {
  const builder = read("apps/desktop/electron-builder.yml");
  assert.ok(/productName:\s*RSI-Agent-PI/.test(builder), "productName 未改名");
  assert.ok(/executableName:\s*RSI-Agent-PI/.test(builder), "exe 名未改名");
  assert.ok(
    /copyright:.*Based on pi-gui.*Matthew Lam/.test(builder),
    "electron-builder copyright 未保留 fork 署名",
  );

  const rootPkg = readJson<{ name: string }>("package.json");
  assert.equal(rootPkg.name, "rsi-agent-pi", `根包名未改名: ${rootPkg.name}`);
  const desktopPkg = readJson<{ name: string }>("apps/desktop/package.json");
  assert.ok(desktopPkg.name.includes("rsi-agent-pi"), `桌面包名未改名: ${desktopPkg.name}`);

  const main = read("apps/desktop/electron/main.ts");
  assert.ok(/title:\s*"RSI-Agent-PI"/.test(main), "窗口标题未改名");
});

test("改名：用户可见文案不得残留旧名 pi-gui", () => {
  // 白名单：内部通道名（pi-gui:*）、localStorage 键（pi-gui.*）、builtin 稳定 id、注释。
  // 含中文的 UI 文案行（字符串或 JSX 文本节点）中不得出现 pi-gui。
  const hits = findHits(/pi-gui/, {
    roots: ["apps/desktop/src", "apps/desktop/electron"],
    extensions: [".ts", ".tsx"],
  }).filter((h) => {
    if (!/[\u4e00-\u9fff]/.test(h.text)) return false;
    if (/^\s*[*/]/.test(h.text)) return false;
    if (/pi-gui[:.]/.test(h.text)) return false;
    if (/pi-gui-(thread|scheduled)/.test(h.text)) return false;
    return true;
  });
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} ${h.text.trim()}`),
    [],
    "用户可见文案残留旧产品名 pi-gui",
  );
});

test("LICENSE 署名完整（MIT © Matthew Lam）", () => {
  const license = read("LICENSE");
  assert.ok(license.includes("MIT License"), "LICENSE 非 MIT");
  assert.ok(license.includes("Copyright (c) 2026 Matthew Lam"), "LICENSE 原文版权声明被改动");
});

test("pi 依赖精确钉死 1.0.0（无范围符）", () => {
  for (const pkgPath of ["apps/desktop/package.json", "packages/pi-sdk-driver/package.json"]) {
    const pkg = readJson<{ dependencies?: Record<string, string> }>(pkgPath);
    const dep = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
    assert.equal(dep, "1.0.0", `${pkgPath}: ${String(dep)}`);
  }
  const lock = read("pnpm-lock.yaml");
  assert.ok(
    /@earendil-works\/pi-coding-agent@1\.0\.0/.test(lock),
    "lockfile 未钉住 pi-coding-agent@1.0.0",
  );
});

test("更新器占位常量可一处替换（owner/repo 未散落多份硬编码）", () => {
  const checker = read("apps/desktop/electron/platform/update-checker.ts");
  const owner = checker.match(/RSI_AGENT_PI_REPO_OWNER\s*=\s*"([^"]+)"/);
  const repo = checker.match(/RSI_AGENT_PI_REPO\s*=\s*"([^"]+)"/);
  assert.ok(owner && repo, "更新器仓库常量未定义");
  assert.equal(repo[1], "RSI-Agent-PI");
  // 计划要求占位常量集中一处。代码里只允许 update-checker.ts 一份；
  // electron-builder.yml 无法 import 常量，允许 yml 一份镜像。
  const ownerName: string = owner[1] as string;
  const hits = findHits(new RegExp(ownerName), {
    roots: ["apps/desktop/electron", "apps/desktop/src", "scripts"],
    extensions: [".ts", ".tsx", ".mjs"],
  });
  const distinctFiles = [...new Set(hits.map((h) => h.file))];
  assert.deepEqual(
    distinctFiles.filter((f) => f !== "apps/desktop/electron/platform/update-checker.ts"),
    [],
    `owner 占位散落在多处: ${distinctFiles.join(", ")}（计划要求集中一处）`,
  );
  const builder = read("apps/desktop/electron-builder.yml");
  assert.ok(
    new RegExp(`owner:\\s*${ownerName}`).test(builder),
    "electron-builder.yml 未镜像同一占位 owner",
  );
});
