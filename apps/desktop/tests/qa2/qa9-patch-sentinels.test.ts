/**
 * qa2-9 补丁哨兵与信任边界（安全轴）
 *
 * 断言：pi 补丁只动用户可见文案，未破坏控制流哨兵字符串
 * （`"aborted"`、`"timeout:"`）；模型可见文本（工具 description）保持英文。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read } from "./helpers";

const BASH_JS = "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
const PATCH = "patches/@earendil-works__pi-coding-agent@1.0.0.patch";

test("哨兵字符串完好：aborted / timeout: 生产端与消费端一致", () => {
  const bash = read(BASH_JS);
  assert.ok(bash.includes('throw new Error("aborted")'), "aborted 生产端丢失");
  assert.ok(bash.includes("throw new Error(`timeout:${timeout}`)"), "timeout: 生产端丢失");
  assert.ok(bash.includes('err.message === "aborted"'), "aborted 消费端比较逻辑被改动");
  assert.ok(bash.includes('err.message.startsWith("timeout:")'), "timeout: 前缀比较逻辑被改动");
  assert.ok(bash.includes('err.message.split(":")[1]'), "timeout 秒数解析被改动");
});

test("补丁 diff 未触碰哨兵字面量（只改展示文案）", () => {
  const patch = read(PATCH);
  const changed = patch.split("\n").filter((line) => /^[+-]/.test(line) && !/^[+-]{3}/.test(line));
  for (const line of changed) {
    assert.ok(!/Error\("aborted"\)/.test(line), `补丁改动了 aborted 生产端: ${line.trim()}`);
    assert.ok(!/Error\(`timeout:/.test(line), `补丁改动了 timeout: 生产端: ${line.trim()}`);
    assert.ok(
      !/message === "aborted"|startsWith\("timeout:"\)/.test(line),
      `补丁改动了哨兵比较: ${line.trim()}`,
    );
  }
});

test("补丁产物：用户可见 shell 文案已中文化，结构未变", () => {
  const bash = read(BASH_JS);
  assert.ok(bash.includes("命令已中止"), "Command aborted 未中文化");
  assert.ok(
    bash.includes("命令在 ${timeoutSecs} 秒后超时") || bash.includes("秒后超时"),
    "超时文案未中文化",
  );
  assert.ok(bash.includes("工作目录不存在"), "工作目录错误未中文化");
  // appendStatus 签名与调用形态保持：文案进 throw，不进哨兵。
  assert.ok(/appendStatus\(text, "命令已中止"\)/.test(bash), "中止文案未走 appendStatus 包装");
});

test("补丁只动 dist 用户可见层，不动 API/类型面", () => {
  const patch = read(PATCH);
  const files = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(!file.endsWith(".d.ts"), `补丁动了类型声明: ${file}（计划 D8：不动 API/类型）`);
    assert.ok(file.startsWith("dist/"), `补丁动了 dist 之外: ${file}`);
  }
});

test("模型可见文本保持英文（工具 description/prompt，§2.3）", () => {
  const tools = read("packages/memloop-bridge/src/tools.ts");
  assert.ok(
    tools.includes("Search long-term memory claim cards recorded by memloop."),
    "memory_search description 被改写了",
  );
  assert.ok(
    tools.includes("Verify one memloop memory claim by running its verify command"),
    "memory_verify description 被改写了",
  );
  assert.ok(
    tools.includes("Explicitly bypass a memloop L2 hard block"),
    "memory_override description 被改写了",
  );
});
