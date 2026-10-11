/**
 * qa2-2 术语一致性（计划书 §2.2 术语表）
 *
 * 规则：同一概念全程一个译词。同概念出现两种译词即 FAIL。
 * 同时扫描禁用的同义误译（thread=线程、workspace=工作区、provider=供应商 等）。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { findHits, read } from "./helpers";

const FORBIDDEN = [
  { concept: "thread（应为 会话）", pattern: /线程/ },
  { concept: "workspace（应为 项目）", pattern: /工作区|工作空间|工作目录集合/ },
  { concept: "provider（应为 提供商）", pattern: /供应商/ },
  { concept: "dream（应为 梦境）", pattern: /做梦|梦想|梦幻回放/ },
  { concept: "verdict/outcome（应为 世界判决）", pattern: /裁决|判定结果|世界裁定/ },
  { concept: "confidence（应为 置信度）", pattern: /可信度|信心度|信任度/ },
  { concept: "subagent（应为 子代理）", pattern: /子智能体|子代理人|子代理者/ },
  { concept: "tool call（应为 工具调用）", pattern: /工具呼叫|工具调用用/ },
  { concept: "compaction（应为 上下文压缩）", pattern: /压缩上下文活动|上下文精简|对话压缩/ },
  { concept: "portable（应为 便携版）", pattern: /便携式版|绿色版/ },
  { concept: "extension（应为 扩展）", pattern: /插件扩展名/ },
];

test("术语表：禁用误译在翻译面零命中", () => {
  for (const { concept, pattern } of FORBIDDEN) {
    const hits = findHits(pattern);
    assert.deepEqual(
      hits.map((h) => `${h.file}:${h.line} ${h.text}`),
      [],
      `术语违例 ${concept}`,
    );
  }
});

test("术语表：规定译词在用户可见面实际使用", () => {
  const required = [
    ["会话（thread）", /会话/],
    ["记忆卡（memory card）", /记忆卡/],
    ["置信度（confidence）", /置信度/],
    ["梦境（dream）", /梦境/],
    ["世界判决（outcome/verdict）", /世界判决/],
    ["上下文压缩（compaction）", /上下文压缩/],
    ["工具调用（tool call）", /工具调用/],
    ["子代理（subagent）", /子代理/],
    ["提供商（provider）", /提供商/],
  ];
  for (const [concept, pattern] of required) {
    const hits = findHits(pattern);
    assert.ok(hits.length > 0, `规定译词未出现: ${concept}`);
  }
  const readme = read("README.md");
  assert.ok(readme.includes("梦境（dream）"), "README 未定义术语 梦境");
  assert.ok(readme.includes("世界判决"), "README 未使用术语 世界判决");
  assert.ok(readme.includes("置信度"), "README 未使用术语 置信度");
});

test("术语一致：thinking level 概念只允许一种译词", () => {
  // 同一概念 defaultThinkingLevel / reasoning effort 的中文词必须唯一。
  const pattern = /思考力度|推理力度|推理挡位|思考挡位/;
  const hits = findHits(pattern);
  const terms = [...new Set(hits.map((h) => h.text.match(pattern)[0]))].sort();
  assert.deepEqual(
    terms.length <= 1 ? terms : [`多种译词并存: ${JSON.stringify(terms)}`],
    terms.length <= 1 ? terms : [],
    `同一概念（thinking level）出现 ${terms.length} 种译词：${terms.join(" / ")}。证据：\n` +
      hits.map((h) => `  ${h.file}:${h.line} ${h.text}`).join("\n"),
  );
});

test("术语一致：workspace 概念在设置描述中统一为「项目」", () => {
  // 「当前项目」是 workspace 的规定译法；不得与「工作目录」混用于同一概念标签。
  const view = read("apps/desktop/src/features/settings/settings-view.tsx");
  assert.ok(view.includes('"当前项目"'), "设置页 workspace 回退名未用「项目」（当前项目）");
  const hits = findHits(/"工作目录"|\(工作目录\)/, {
    roots: [
      "apps/desktop/src/features/settings",
      "apps/desktop/src/features/threads",
      "apps/desktop/src/features/conversation",
    ],
    extensions: [".ts", ".tsx"],
  });
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}`),
    [],
    "workspace 概念被译成「工作目录」，与术语表「项目」冲突",
  );
});

test("术语一致：memory card 概念只允许「记忆卡」一种译词", () => {
  const pattern = /记忆卡片|记忆条目|声明卡|记忆块|经验卡/;
  const hits = findHits(pattern);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line} ${h.text}`),
    [],
    "memory card 概念出现了「记忆卡」以外的译词",
  );
  const cardHits = findHits(/记忆卡/);
  assert.ok(cardHits.length >= 5, "规定译词「记忆卡」出现次数过少，翻译可能未落地");
});
