/**
 * qa2-1 白名单边界（计划书 §2.1）
 *
 * 1. 推理挡位值保持英文，不被译成中文。
 * 2. 模型/提供商公司名保持英文。
 * 3. `Provider ID` 标签被译为「提供商 ID」；`API key` 与 `Base URL` 保持英文。
 * 4. `OAuth`、命令名、路径等技术标识保持英文。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { findHits, read } from "./helpers";

const hasCjk = (s: string): boolean => /[\u4e00-\u9fff]/.test(s);

test("白名单：推理挡位值不得被译成中文", () => {
  const composer = read("apps/desktop/src/features/conversation/composer-commands.ts");
  const block = composer.match(/THINKING_OPTIONS[\s\S]*?\] as const/);
  assert.ok(block, "THINKING_OPTIONS 不存在");
  const optionSource: string = block[0];
  const labels = [...optionSource.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  assert.ok(labels.length >= 5, `挡位标签数量异常: ${labels.join(",")}`);
  for (const label of labels) {
    assert.ok(
      !hasCjk(label),
      `推理挡位值被翻译了: "${label}"（composer-commands.ts THINKING_OPTIONS）`,
    );
  }
  // 白名单值域：Off/Min/Low/Med/High/XHigh/Max 允许的英文拼写变体。
  const allowed = new Set([
    "Off",
    "Min",
    "Low",
    "Med",
    "Medium",
    "High",
    "XHigh",
    "Extra High",
    "Max",
  ]);
  for (const label of labels) {
    assert.ok(allowed.has(label), `挡位值超出白名单拼写: "${label}"`);
  }

  const settingsUtils = read("apps/desktop/src/features/settings/settings-utils.tsx");
  assert.ok(
    settingsUtils.includes('return "Extra High"'),
    "labelForThinking 的 xhigh 分支不再是英文 Extra High",
  );
  const fnBody = settingsUtils.match(/export function labelForThinking[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(
    !/return\s+"[^"]*[\u4e00-\u9fff][^"]*"/.test(fnBody),
    "labelForThinking 返回了中文挡位值",
  );
});

test("白名单：公司名保持英文，翻译面无中文公司名映射", () => {
  const chineseCompanyNames = [/开放人工智能/, /月之暗面/, /安斯罗普|安瑟比/, /克劳德|克洛德/];
  for (const pattern of chineseCompanyNames) {
    const hits = findHits(pattern);
    assert.deepEqual(
      hits.map((h) => `${h.file}:${h.line}`),
      [],
      `公司名被翻译: ${pattern}`,
    );
  }
  // 补丁不得改写模型目录里的公司名/模型名字段。
  const patch = read("patches/@earendil-works__pi-coding-agent@1.0.0.patch");
  const patchChanged = patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^[+-]{3}/.test(line))
    .join("\n");
  for (const name of ["Anthropic", "OpenAI", "Claude", "Gemini", "Llama", "DeepSeek"]) {
    assert.ok(
      !patchChanged.includes(name),
      `pi 补丁改动了公司/模型名 ${name}（应只动用户可见文案层）`,
    );
  }
});

test("白名单：Provider ID 标签被译，API key 与 Base URL 保持英文", () => {
  const endpoints = read(
    "apps/desktop/src/features/settings/settings-custom-endpoints-section.tsx",
  );
  assert.ok(
    /<span>\{t\("Provider ID",\s*"提供商 ID"\)\}<\/span>/.test(endpoints),
    "Provider ID 标签未译成「提供商 ID」",
  );
  assert.ok(!/<span>Provider ID<\/span>/.test(endpoints), "Provider ID 标签仍是英文");
  assert.ok(endpoints.includes("<span>API key</span>"), "API key 标签不再是英文 API key");
  assert.ok(endpoints.includes("<span>Base URL</span>"), "Base URL 标签不再是英文 Base URL");
  assert.ok(!endpoints.includes("API 密钥"), "API key 被译成了 API 密钥");
  assert.ok(!endpoints.includes("基础 URL") && !endpoints.includes("基本 URL"), "Base URL 被译了");
});

test("白名单：OAuth、命令名、配置路径保持英文", () => {
  const composer = read("apps/desktop/src/features/conversation/composer-commands.ts");
  assert.ok(composer.includes("OAuth 已连接"), "OAuth 字面量丢失");
  assert.ok(!composer.includes("开放授权"), "OAuth 被译掉了");
  const readme = read("README.md");
  assert.ok(readme.includes("`/memory"), "README 命令名 /memory 被改动");
  assert.ok(readme.includes("`/dreaming"), "README 命令名 /dreaming 被改动");
  assert.ok(readme.includes("verdictCmd"), "字段名 verdictCmd 被改动");
  const settings = read("apps/desktop/src/features/settings/settings-custom-endpoints-section.tsx");
  assert.ok(settings.includes("~/.pi/agent/models.json"), "设置页路径被改动");
});
