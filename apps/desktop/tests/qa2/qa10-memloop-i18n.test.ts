/**
 * qa2-10 memloop 命令输出中文化（计划书 D9「memloop 残留」+ README 对外表述）
 *
 * 断言：/memory 与 /dreaming 的用户可见输出标签用中文术语表译词。
 * README 声称「逐条显示记忆卡的 key、置信度、原文与验证命令」，
 * /dreaming 审计报告字段标签按 D9 应译。残留英文标签即 FAIL。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read } from "./helpers";

test("/memory list 输出标签使用术语表译词（置信度、验证命令）", () => {
  const commands = read("packages/memloop-bridge/src/commands.ts");
  const formatUsed = commands.match(/function formatUsed[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(formatUsed.length > 0, "formatUsed 不存在");
  assert.ok(
    !/confidence \$\{/.test(formatUsed),
    `/memory list 残留英文标签 "confidence"（应为 置信度）: ${formatUsed.replace(/\s+/g, " ").slice(0, 200)}`,
  );
  assert.ok(
    !/verify: \$\{/.test(formatUsed),
    `/memory list 残留英文标签 "verify:"（应为 验证命令）: ${formatUsed.replace(/\s+/g, " ").slice(0, 200)}`,
  );
});

test("formatClaim 输出标签使用术语表译词", () => {
  const tools = read("packages/memloop-bridge/src/tools.ts");
  const formatClaim = tools.match(/export function formatClaim[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(formatClaim.length > 0, "formatClaim 不存在");
  assert.ok(
    !/confidence \$\{/.test(formatClaim),
    "formatClaim 残留英文标签 confidence（应为 置信度）",
  );
  assert.ok(!/verify: \$\{/.test(formatClaim), "formatClaim 残留英文标签 verify:（应为 验证命令）");
});

test("/dreaming 审计报告字段标签已中文化（D9）", () => {
  const commands = read("packages/memloop-bridge/src/commands.ts");
  const report = commands.match(/const lines = \[\s*`\/dreaming 审计报告`[\s\S]*?\];/)?.[0] ?? "";
  assert.ok(report.length > 0, "/dreaming 审计报告组装块不存在");
  for (const label of ["ran:", "winner:", "changed:", "scores:"]) {
    assert.ok(
      !report.includes(`\`${label}`) && !report.includes(`"${label}`),
      `/dreaming 报表字段标签残留英文 "${label}"（D9 要求译）`,
    );
  }
  const diff = commands.match(/function renderPolicyDiff[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(
    !/policy diff/.test(diff),
    `policy diff 标签残留英文: ${diff.replace(/\s+/g, " ").slice(0, 160)}`,
  );
  assert.ok(!/\(unchanged\)/.test(diff), "(unchanged) 标签残留英文");
});

test("README 对外描述与实现输出一致（置信度/验证命令）", () => {
  const readme = read("README.md");
  const listSection = readme.slice(readme.indexOf("### /memory list"));
  assert.ok(listSection.includes("置信度"), "README /memory list 段未写 置信度");
  const commands = read("packages/memloop-bridge/src/commands.ts");
  assert.ok(
    commands.includes("置信度") || !/confidence \$\{/.test(commands),
    "README 说显示「置信度」但实现输出 confidence（文档与实现不一致）",
  );
});
