/**
 * qa2-8 生成物警告注释（计划书 / README 生成物说明）
 *
 * 断言：生成物脚本带重建覆盖警告；README 生成物说明点名两个生成目录。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read } from "./helpers";

test("build-vendored-plugins.mjs 头部带中文化覆盖警告", () => {
  const script = read("scripts/build-vendored-plugins.mjs");
  const header = script.slice(0, 800);
  assert.ok(/WARNING/.test(header), "缺 WARNING 标记");
  assert.ok(/警告/.test(header), "缺中文警告");
  assert.ok(
    /overwrites the Chinese localization|覆盖中文化/.test(header),
    "警告未说明重建会覆盖中文化",
  );
});

test("fetch-python-runtime.mjs 声明 runtime/ 为生成物", () => {
  const script = read("scripts/fetch-python-runtime.mjs");
  const header = script.slice(0, 1500);
  assert.ok(/generated output/i.test(header) || /生成/.test(header), "未声明生成物");
  assert.ok(/apps\/desktop\/runtime/.test(header), "未点名 runtime 输出目录");
});

test("README「生成物说明」点名 vendor/plugins 与 apps/desktop/runtime", () => {
  const readme = read("README.md");
  const start = readme.indexOf("### 生成物说明");
  assert.ok(start !== -1, "README 缺「生成物说明」");
  const section = readme.slice(start, start + 800);
  assert.ok(section.includes("vendor/plugins"), "生成物说明未点名 vendor/plugins");
  assert.ok(section.includes("apps/desktop/runtime"), "生成物说明未点名 runtime");
  assert.ok(/覆盖|被覆盖|重建/.test(section), "未警告改动会被覆盖");
});

test("electron-builder 把生成物打进包（extraResources）", () => {
  const builder = read("apps/desktop/electron-builder.yml");
  assert.ok(/from:\s*runtime\/python/.test(builder), "runtime/python 未进 extraResources");
  assert.ok(/from:\s*runtime\/memloop-py/.test(builder), "memloop-py 未进 extraResources");
  assert.ok(/from:\s*\.\.\/\.\.\/vendor/.test(builder), "vendor 未进 extraResources");
});
