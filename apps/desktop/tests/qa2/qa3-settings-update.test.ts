/**
 * qa2-3 设置「更新」节（需求：更新功能必须在设置里）
 *
 * 断言：设置导航存在「更新」节；检查更新按钮触发 IPC；主进程处理该 IPC 并
 * 调用更新检查；pi 本体版本只读展示且与 package.json 钉版一致。
 */

import assert from "node:assert/strict";
import { test } from "@playwright/test";
import { read, readJson } from "./helpers";

test("设置「更新」节真实存在且可从设置导航到达", () => {
  const sections = read("apps/desktop/src/features/settings/settings-sections.tsx");
  assert.ok(/id:\s*"update"/.test(sections), "设置节 id=update 不存在");
  assert.ok(/title:\s*"更新"/.test(sections), "设置节标题不是「更新」");

  const view = read("apps/desktop/src/features/settings/settings-view.tsx");
  assert.ok(
    view.includes('section === "update" ? <SettingsUpdateSection />'),
    "settings-view 未按 section=update 渲染 SettingsUpdateSection",
  );
  assert.ok(
    view.includes('from "./settings-update-section"'),
    "settings-view 未引入 settings-update-section",
  );
});

test("检查更新按钮点击触发 window.piApp.checkForUpdates IPC", () => {
  const section = read("apps/desktop/src/features/settings/settings-update-section.tsx");
  assert.ok(/api\s*\.checkForUpdates\(\)/.test(section), "按钮处理器未调用 api.checkForUpdates()");
  assert.ok(/onClick={handleCheck}/.test(section), "检查更新按钮没有 onClick");
  assert.ok(section.includes("检查更新"), "按钮文案不是「检查更新」");

  const preload = read("apps/desktop/electron/preload.ts");
  assert.ok(
    /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(desktopIpc\.checkForUpdates\)/.test(
      preload.replace(/\s+/g, " "),
    ),
    "preload 未把 checkForUpdates 暴露为 IPC invoke",
  );

  const ipc = read("apps/desktop/contracts/ipc.ts");
  assert.ok(
    ipc.includes('checkForUpdates: "pi-gui:check-for-updates"'),
    "contracts/ipc.ts 缺 checkForUpdates 频道",
  );
  assert.ok(/checkForUpdates\(\):\s*Promise<void>/.test(ipc), "piApp 类型缺 checkForUpdates");

  const register = read("apps/desktop/electron/ipc/register-desktop-ipc.ts");
  assert.ok(
    register.includes("ipcMain.handle(desktopIpc.checkForUpdates"),
    "主进程未 handle check-for-updates",
  );

  const main = read("apps/desktop/electron/main.ts");
  assert.ok(
    main.includes("checkForUpdates: (window) => runManualUpdateCheck(window)"),
    "main.ts 未把 IPC 接到 runManualUpdateCheck",
  );

  const manual = read("apps/desktop/electron/platform/manual-update-check.ts");
  assert.ok(manual.includes("checkForUpdate()"), "手动更新检查未调用 checkForUpdate");
  assert.ok(manual.includes("暂时无法检查更新"), "更新失败对话框未中文化");
  assert.ok(manual.includes("当前已是最新版本"), "最新版本对话框未中文化");
});

test("pi 本体版本只读展示且与 package.json 钉版一致", () => {
  const ipc = read("apps/desktop/contracts/ipc.ts");
  const pinned = ipc.match(/PI_RUNTIME_PINNED_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(pinned, "PI_RUNTIME_PINNED_VERSION 未定义");
  assert.equal(pinned[1], "1.0.0", "pi 版本钉死值必须是 1.0.0");

  const section = read("apps/desktop/src/features/settings/settings-update-section.tsx");
  assert.ok(section.includes("{PI_RUNTIME_PINNED_VERSION}（已锁定）"), "pi 版本未以只读文本展示");
  assert.ok(!/<input/.test(section.split("pi 运行时")[1] ?? ""), "pi 版本行出现可编辑控件");

  for (const pkgPath of ["apps/desktop/package.json", "packages/pi-sdk-driver/package.json"]) {
    const pkg = readJson<{ dependencies?: Record<string, string> }>(pkgPath);
    const version = pkg.dependencies?.["@earendil-works/pi-coding-agent"];
    assert.equal(
      version,
      "1.0.0",
      `${pkgPath} 的 pi 依赖不是精确 1.0.0（实际 ${String(version)}）`,
    );
    assert.ok(!/[\^~]/.test(version ?? ""), `${pkgPath} 的 pi 依赖带范围符`);
    assert.equal(version, pinned[1], `${pkgPath} 依赖版本与 PI_RUNTIME_PINNED_VERSION 不一致`);
  }
});

test("更新器指向 RSI-Agent-PI Releases 且通知中文化", () => {
  const checker = read("apps/desktop/electron/platform/update-checker.ts");
  assert.ok(
    checker.includes("RSI_AGENT_PI_REPO_OWNER") && checker.includes("RSI_AGENT_PI_REPO"),
    "更新器未定义 RSI-Agent-PI 仓库常量",
  );
  assert.ok(checker.includes("/releases/latest"), "更新检查未指向 GitHub Releases latest");
  assert.ok(checker.includes("RSI-Agent-PI 有新版本"), "更新通知未中文化/未改名");

  const builder = read("apps/desktop/electron-builder.yml");
  assert.ok(/repo:\s*RSI-Agent-PI/.test(builder), "electron-builder publish 未指向 RSI-Agent-PI");
  assert.ok(/productName:\s*RSI-Agent-PI/.test(builder), "productName 未改名");
});
