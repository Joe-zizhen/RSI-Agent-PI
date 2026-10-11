/**
 * qa2-4 memloop 零手动内置（计划书阶段 B）
 *
 * 断言：builtin extension 注册且自动加载；设置开关默认开；记忆节提供
 * 启用开关与 verdictCmd；Python 发现顺序随包优先。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read } from "./helpers";

test("memloop 注册为 builtin extension，随应用自动加载", () => {
  const main = read("apps/desktop/electron/main.ts");
  assert.ok(
    main.includes('import { memloopExtensionFactory } from "@rsi-agent-pi/memloop-bridge"'),
    "main 未引入 memloopExtensionFactory",
  );
  assert.ok(
    /name:\s*MEMLOOP_BUILTIN_EXTENSION_NAME/.test(main),
    "builtinExtensions 未注册 memloop",
  );
  assert.ok(main.includes("factory: memloopExtensionFactory"), "memloop factory 未挂上");
  assert.ok(
    /displayName:\s*t\("memloop long-term memory",\s*"memloop 长期记忆"\)/.test(main),
    "memloop 显示名缺失或未中文化",
  );

  const ipc = read("apps/desktop/contracts/ipc.ts");
  assert.ok(ipc.includes('MEMLOOP_BUILTIN_EXTENSION_NAME = "memloop"'), "扩展名常量不是 memloop");
  assert.ok(
    ipc.includes('MEMLOOP_BUILTIN_EXTENSION_PATH = "<inline:memloop>"'),
    "扩展路径常量与 inline 名不匹配",
  );
});

test("memloop 设置开关默认开启（零手动）", () => {
  const store = read("apps/desktop/electron/application/app-store.ts");
  assert.ok(
    store.includes(
      "isBuiltinExtensionEnabled: (name) => !this.disabledBuiltinExtensions.has(name)",
    ),
    "builtin 启用判定不再是默认开（disabled 集合白名单制）",
  );

  const surfaces = read("apps/desktop/src/app/secondary-surfaces.tsx");
  assert.ok(/memoryExtension\?\.enabled \?\? true/.test(surfaces), "记忆开关默认值不是 true");
  assert.ok(
    surfaces.includes(
      "api.setExtensionEnabled(settingsWorkspace.id, MEMLOOP_BUILTIN_EXTENSION_PATH, enabled)",
    ),
    "记忆开关未走 setExtensionEnabled",
  );

  const supervisor = read("packages/pi-sdk-driver/src/session-supervisor.ts");
  assert.ok(
    supervisor.includes("options.isBuiltinExtensionEnabled ?? (() => true)"),
    "pi-sdk-driver 默认启用判定被改动",
  );
  const gate = read("packages/pi-sdk-driver/src/builtin-extensions.ts");
  assert.ok(gate.includes("export function gatedBuiltinExtensions"), "gatedBuiltinExtensions 丢失");
});

test("设置「记忆」节：启用开关 + verdictCmd 输入", () => {
  const sections = read("apps/desktop/src/features/settings/settings-sections.tsx");
  assert.ok(/id:\s*"memory"/.test(sections), "设置节 id=memory 不存在");
  assert.ok(
    /id:\s*"memory",\s*get title\(\)\s*\{\s*return t\("Memory",\s*"记忆"\);/.test(sections),
    "记忆节标题不是「记忆」",
  );

  const memory = read("apps/desktop/src/features/settings/settings-memory-section.tsx");
  assert.ok(memory.includes('title={t("Enable memory", "启用记忆")}'), "缺「启用记忆」行");
  assert.ok(memory.includes("<SettingsSwitch"), "启用记忆不是开关控件");
  assert.ok(memory.includes("verdictCmd"), "缺 verdictCmd 输入");
  assert.ok(/api\s*\.setMemloopSettings\(/.test(memory), "verdictCmd 未持久化");

  const view = read("apps/desktop/src/features/settings/settings-view.tsx");
  assert.ok(view.includes("<SettingsMemorySection"), "settings-view 未渲染记忆节");
});

test("Python 发现顺序：随包嵌入式优先，系统 python 兜底", () => {
  const sidecar = read("packages/memloop-bridge/src/sidecar.ts");
  assert.ok(/python\.exe/.test(sidecar), "随包 Windows python 候选缺失");
  assert.ok(/"python3"/.test(sidecar), "随包 POSIX python 候选缺失");
  assert.ok(sidecar.includes("MEMLOOP_PYTHON"), "环境变量覆盖通道缺失");
  const squeezed = sidecar.replace(/\s+/g, "");
  assert.ok(squeezed.includes('push("py","python3","python")'), "系统 python 兜底缺失");
  const order = sidecar.indexOf("runtime") < sidecar.indexOf("MEMLOOP_PYTHON");
  assert.ok(order, "随包 runtime 候选应在系统候选之前");
});

test("builtin 注册名与线程编排等先例同位挂载", () => {
  const main = read("apps/desktop/electron/main.ts");
  const block = main.match(/builtinExtensions:\s*\[[\s\S]*?\n\s*\],/);
  assert.ok(block, "builtinExtensions 数组不存在");
  for (const name of [
    "pi-gui-thread-orchestration",
    "pi-gui-scheduled-tasks",
    "MEMLOOP_BUILTIN_EXTENSION_NAME",
  ]) {
    assert.ok(block[0].includes(name), `builtin 列表缺少 ${name}`);
  }
});
