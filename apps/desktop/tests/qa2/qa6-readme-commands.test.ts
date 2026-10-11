/**
 * qa2-6 README 主动命令四段式（计划书阶段 E / 用户补充口径）
 *
 * 解析 README「主动命令」节，断言每个命令都有
 * 是什么 / 怎么用 / 什么时候用 / 用了会怎样 四段，且命令集齐全。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read } from "./helpers";

const SEGMENTS = ["是什么", "怎么用", "什么时候用", "用了会怎样"];

function parseActiveCommands(readme: string): Map<string, string> {
  const start = readme.indexOf("## 主动命令");
  assert.ok(start !== -1, "README 缺「主动命令」章");
  const rest: string = readme.slice(start + "## 主动命令".length);
  const nextH2: number = rest.search(/\n## /);
  const section: string = nextH2 === -1 ? rest : rest.slice(0, nextH2);
  const parts: string[] = section.split(/^### /m).slice(1);
  const commands = new Map<string, string>();
  for (const part of parts) {
    const name: string = (part.split("\n")[0] ?? "").trim();
    commands.set(name, part);
  }
  return commands;
}

test("README 四段式：每个主动命令四段标题齐全", () => {
  const readme = read("README.md");
  const commands = parseActiveCommands(readme);
  assert.ok(commands.size >= 8, `主动命令数量不足: ${[...commands.keys()].join(", ")}`);
  for (const [name, body] of commands) {
    for (const segment of SEGMENTS) {
      assert.ok(
        body.includes(`- ${segment}：`) || body.includes(`- ${segment}:`),
        `命令 ${name} 缺「${segment}」段`,
      );
    }
  }
});

test("README 四段式：计划点名的命令全部收录", () => {
  const readme = read("README.md");
  const commands = parseActiveCommands(readme);
  const required = [
    "/memory list",
    "/memory show",
    "/memory forget",
    "/dreaming",
    "/dreaming rollback",
    "memory_search",
    "memory_verify",
    "memory_override",
  ];
  for (const name of required) {
    const found = [...commands.keys()].some((key) => key.startsWith(name));
    assert.ok(found, `README 主动命令缺 ${name}`);
  }
});

test("README 开箱流程与已知边界齐全", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("快速开始"), "README 缺快速开始");
  assert.ok(readme.includes("SmartScreen"), "README 缺 SmartScreen 已知边界");
  assert.ok(readme.includes("1.0.0"), "README 未声明 pi 锁版本");
  assert.ok(readme.includes("memloop") && readme.includes("记忆"), "README 缺记忆功能说明");
  assert.ok(readme.includes("## 更新"), "README 缺更新说明章");
  assert.ok(/检查更新/.test(readme), "README 未说明检查更新入口");
  assert.ok(readme.includes("致谢") && readme.includes("Matthew Lam"), "README 缺 fork 署名");
});

test("README 快速开始覆盖：下载→双击→配 API key→用", () => {
  const readme = read("README.md");
  const start = readme.indexOf("### 安装与首次启动");
  assert.ok(start !== -1, "README 缺安装与首次启动");
  const flow: string = readme.slice(start, start + 1200);
  assert.ok(/下载/.test(flow), "快速开始缺下载步骤");
  assert.ok(/双击/.test(flow), "快速开始缺双击步骤");
  assert.ok(/API key/.test(flow), "快速开始缺配 API key 步骤");
  assert.ok(/记忆自动/.test(flow), "快速开始未声明记忆自动生效");
});
