import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

/** A tiny stdio MCP server; connecting writes `<markerDir>/initialized.txt`. */
const MCP_SERVER_FIXTURE = resolve(
  __dirname,
  "../../../../packages/pi-sdk-driver/test/fixtures/mcp-stdio-server.mjs",
);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mirrors the app's `withHomeAsTilde`: paths under home display with a leading `~`. */
function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

async function openMcpSettings(window: Page) {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "MCP 服务器", exact: true }).click();
  await expect(window.locator(".view-header__title")).toHaveText("MCP 服务器");
}

test("adds, switches and removes an MCP server from Settings, editing mcp.json in place", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mcp-settings-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const mcpPath = join(agentDir, "mcp.json");
  const existing = {
    command: "existing-server",
    args: ["--port", "1"],
    env: { EXISTING_SECRET: "do-not-show-this" },
    exposure: "direct",
  };
  await writeFile(
    mcpPath,
    `${JSON.stringify({ autoEnableCodemode: true, mcpServers: { existing } }, null, 4)}\n`,
  );
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(
    join(workspacePath, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { "project-docs": { url: "http://127.0.0.1:9/mcp" } } }),
  );
  const markerDir = join(userDataDir, "mcp-markers");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await openMcpSettings(window);
    const surface = window.getByTestId("settings-surface");
    const row = (name: string) =>
      surface.locator(`[data-testid="mcp-server-row"][data-server-name="${name}"]`);

    await expect(row("existing")).toContainText("existing-server --port 1");
    await expect(row("project-docs")).toContainText("本项目 · http://127.0.0.1:9/mcp");
    await expect(row("project-docs").getByRole("button", { name: "移除" })).toHaveCount(0);
    await expect(surface).not.toContainText("do-not-show-this");

    await surface.getByLabel("服务器名称").fill("fixture");
    await surface.getByLabel("服务器说明").fill("Writes marker files");
    await surface.getByLabel("服务器命令").fill(process.execPath);
    await surface.getByLabel("服务器参数").fill(`"${MCP_SERVER_FIXTURE}" "${markerDir}"`);
    await surface.getByRole("button", { name: "添加服务器", exact: true }).click();
    await expect(row("fixture")).toContainText("Writes marker files");
    await expect(surface.getByLabel("服务器名称")).toHaveValue("");
    await expect(surface.getByLabel("服务器说明")).toHaveValue("");

    const afterAdd = await readJson(mcpPath);
    expect(afterAdd).toEqual({
      autoEnableCodemode: true,
      mcpServers: {
        existing,
        fixture: {
          command: process.execPath,
          args: [MCP_SERVER_FIXTURE, markerDir],
          description: "Writes marker files",
        },
      },
    });

    // pi would skip one of two servers whose names differ only by "-" and "_".
    await surface.getByLabel("服务器名称").fill("project_docs");
    await surface.getByLabel("服务器命令").fill("node");
    await surface.getByRole("button", { name: "添加服务器", exact: true }).click();
    await expect(surface).toContainText('An MCP server named "project-docs" already exists');
    await expect(row("project_docs")).toHaveCount(0);
    await surface.getByLabel("服务器名称").fill("");
    await surface.getByLabel("服务器命令").fill("");
    expect(await readFile(mcpPath, "utf8")).toMatch(/^ {4}"autoEnableCodemode"/m);

    // A thread starts the servers in mcp.json, the same file terminal pi reads.
    await createNamedThread(window, "MCP thread");
    await expect.poll(() => existsSync(join(markerDir, "initialized.txt"))).toBe(true);
    await openMcpSettings(window);

    const fixtureSwitch = row("fixture").getByRole("switch", { name: "启用 fixture" });
    await expect(fixtureSwitch).toBeChecked();
    await fixtureSwitch.click();
    await expect(fixtureSwitch).not.toBeChecked();
    await expect(fixtureSwitch).toBeEnabled();
    expect((await readJson(mcpPath)).mcpServers).toEqual({
      existing,
      fixture: {
        command: process.execPath,
        args: [MCP_SERVER_FIXTURE, markerDir],
        description: "Writes marker files",
        enabled: false,
      },
    });

    await fixtureSwitch.click();
    await expect(fixtureSwitch).toBeChecked();
    await expect(fixtureSwitch).toBeEnabled();
    expect((await readJson(mcpPath)).mcpServers).toEqual({
      existing,
      fixture: {
        command: process.execPath,
        args: [MCP_SERVER_FIXTURE, markerDir],
        description: "Writes marker files",
      },
    });

    const projectSwitch = row("project-docs").getByRole("switch", { name: "启用 project-docs" });
    await projectSwitch.click();
    await expect(projectSwitch).not.toBeChecked();
    await expect(projectSwitch).toBeEnabled();
    expect(await readJson(join(workspacePath, ".pi", "mcp.json"))).toEqual({
      mcpServers: { "project-docs": { url: "http://127.0.0.1:9/mcp", enabled: false } },
    });

    // Remove asks first, and says when the entry holds settings the list never shows.
    const declined = window.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await row("existing").getByRole("button", { name: "移除" }).click();
    expect(await declined).toContain("其隐藏设置（环境变量、请求头、登录配置）也会被删除。");
    await expect(row("existing")).toBeVisible();
    expect((await readJson(mcpPath)).mcpServers).toEqual({
      existing,
      fixture: {
        command: process.execPath,
        args: [MCP_SERVER_FIXTURE, markerDir],
        description: "Writes marker files",
      },
    });

    const accepted = window.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      return message;
    });
    await row("fixture").getByRole("button", { name: "移除" }).click();
    expect(await accepted).toBe("移除 MCP 服务器“fixture”？终端里的 pi 也会停止使用它。");
    await expect(row("fixture")).toHaveCount(0);
    expect(await readJson(mcpPath)).toEqual({
      autoEnableCodemode: true,
      mcpServers: { existing },
    });

    const codemodeSwitch = surface.getByRole("switch", { name: "始终开启代码模式" });
    await expect(codemodeSwitch).not.toBeChecked();
    await codemodeSwitch.click();
    await expect(codemodeSwitch).toBeChecked();
    await expect(codemodeSwitch).toBeEnabled();
    expect((await readJson(join(agentDir, "settings.json"))).defaultTools).toEqual(["+codemode"]);
    await codemodeSwitch.click();
    await expect(codemodeSwitch).not.toBeChecked();
    await expect(codemodeSwitch).toBeEnabled();
    expect((await readJson(join(agentDir, "settings.json"))).defaultTools).toBeUndefined();
  } finally {
    await harness.close();
  }
});

test("rejects a server Settings cannot run and leaves mcp.json alone", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("mcp-settings-invalid-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const mcpPath = join(agentDir, "mcp.json");

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await openMcpSettings(window);
    const surface = window.getByTestId("settings-surface");
    // The copy names the file this app really uses, here the test's own agent
    // directory (displayed home-abbreviated like the app).
    const shownMcpPath = displayPath(mcpPath);
    await expect(surface.getByTestId("mcp-servers-empty")).toContainText(shownMcpPath);
    // The save hint is localized; the named file is what the app really uses.
    await expect(surface).toContainText(
      new RegExp(`(?:Saved to |保存到 )${escapeRegExp(shownMcpPath)}[.。]`),
    );
    await expect(surface.getByTestId("mcp-servers-empty")).toContainText("/mcp");

    await surface.getByLabel("服务器名称").fill("local-file");
    await surface.getByRole("group", { name: "服务器类型" }).getByText("URL").click();
    await surface.getByLabel("服务器 URL").fill("file:///etc/passwd");
    await surface.getByRole("button", { name: "添加服务器", exact: true }).click();
    await expect(surface).toContainText("MCP server URL must be a valid http:// or https:// URL");
    await expect(surface.getByLabel("服务器名称")).toHaveValue("local-file");
    expect(existsSync(mcpPath)).toBe(false);

    // pi in the terminal adds a server while the app is in the background; focus shows it.
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { terminal: { command: "added" } } }));
    await harness.electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.emit("focus");
    });
    await expect(
      surface.locator('[data-testid="mcp-server-row"][data-server-name="terminal"]'),
    ).toContainText("added");
    await expect(surface.getByTestId("mcp-servers-empty")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
