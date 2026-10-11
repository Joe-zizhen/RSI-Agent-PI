/**
 * qa2-10 memloop 命令输出中文化（计划书 D9「memloop 残留」+ README 对外表述）
 *
 * 断言：/memory 与 /dreaming 的用户可见输出标签用中文术语表译词。
 * 双语形态下英文键允许存在。断言目标是 t 对的中文值（或 formatClaim 的
 * 默认中文输出）等于术语表译词。README 声称「逐条显示记忆卡的 key、
 * 置信度、原文与验证命令」。中文值缺失或误译即 FAIL。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read } from "./helpers";

test("/memory list 输出标签使用术语表译词（置信度、验证命令）", () => {
  const commands = read("packages/memloop-bridge/src/commands.ts");
  const formatUsed = commands.match(/function formatUsed[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(formatUsed.length > 0, "formatUsed 不存在");
  assert.ok(
    /t\(\s*`[^`]*confidence[^`]*`,\s*`[^`]*置信度[^`]*`/.test(formatUsed),
    `/memory list 的 t 对中文值不是「置信度」: ${formatUsed.replace(/\s+/g, " ").slice(0, 200)}`,
  );
  assert.ok(
    /t\(\s*`[^`]*verify: [^`]*`,\s*`[^`]*验证命令: [^`]*`/.test(formatUsed),
    `/memory list 的 verify 标签 t 对中文值不是「验证命令」: ${formatUsed
      .replace(/\s+/g, " ")
      .slice(0, 200)}`,
  );
});

test("formatClaim 输出标签使用术语表译词", async () => {
  const tools = read("packages/memloop-bridge/src/tools.ts");
  const formatClaimSource = tools.match(/export function formatClaim[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(formatClaimSource.length > 0, "formatClaim 不存在");

  delete process.env.RSI_LOCALE;
  const { formatClaim } = await import("../../../../packages/memloop-bridge/src/tools.ts");
  const withVerify = formatClaim({
    key: "demo",
    text: "demo text",
    confidence: 0.5,
    verify_cmd: "npm test",
    claim_kind: "claim",
  });
  assert.ok(withVerify.includes("置信度 0.50"), "formatClaim 输出缺术语「置信度」");
  assert.ok(!/confidence /.test(withVerify), "formatClaim 输出残留英文标签 confidence");
  assert.ok(withVerify.includes("验证命令: npm test"), "formatClaim 输出缺术语「验证命令」");
  assert.ok(!/verify: /.test(withVerify), "formatClaim 输出残留英文标签 verify:");

  const noVerify = formatClaim({ key: "demo", text: "demo text", confidence: 0.5 });
  assert.ok(noVerify.includes("无验证命令"), "formatClaim 无验证命令分支未中文化");
  assert.ok(!/no verify command/.test(noVerify), "formatClaim 无验证命令分支残留英文");
});

test("/dreaming 审计报告字段标签已中文化（D9）", () => {
  const commands = read("packages/memloop-bridge/src/commands.ts");
  const report =
    commands.match(
      /const lines = \[\s*t\(`\/dreaming audit report`,\s*`\/dreaming 审计报告`\)[\s\S]*?\];/,
    )?.[0] ?? "";
  assert.ok(report.length > 0, "/dreaming 审计报告组装块不存在");
  const zhLabels: ReadonlyArray<readonly [string, string]> = [
    ["ran:", "已执行:"],
    ["winner:", "胜出:"],
    ["changed:", "已变更:"],
    ["scores:", "得分:"],
  ];
  for (const [label, zh] of zhLabels) {
    const pair = new RegExp("t\\(`" + label + " [^`]*`,\\s*`" + zh + " [^`]*`\\)");
    assert.ok(
      pair.test(report),
      `/dreaming 报表字段 ${label} 的 t 对中文值不是「${zh}」（D9 要求译）`,
    );
  }
  const diff = commands.match(/function renderPolicyDiff[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(
    /t\("policy diff: the result carries no policy fields",\s*"参数差异: 结果未携带 policy 字段"\)/.test(
      diff,
    ),
    "policy diff 空结果标签 t 对中文值未译",
  );
  assert.ok(
    /t\("policy diff \(incumbent → winner\):",\s*"参数差异 \(incumbent → winner\):"\)/.test(diff),
    "policy diff 标签 t 对中文值未译",
  );
  assert.ok(
    /t\(\s*`[^`]*\(unchanged\)`,\s*`[^`]*（未变）`/.test(diff),
    "(unchanged) 标签 t 对中文值未译",
  );
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
