import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

test("one icon and keyboard shortcuts toggle the selected workspace tool", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("workbench-shortcuts");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Shortcut thread");
    // The toggle sits in the topbar while the pane is hidden and in the
    // workbench tab strip while it is shown; there is only ever one.
    const toggle = window.getByRole("button", { name: "切换侧边面板" });
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("");
    await toggle.click();
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) await window.getByTestId("workbench-add-tab").click();
    const modifierLabel = process.platform === "darwin" ? "⌘" : "Ctrl+";
    // Chooser tile names are localized via `aria-label`; match either language.
    const tile = (name: RegExp) => chooser.getByRole("button", { name });
    await expect(tile(/^Review$|^审查$/).locator("kbd")).toHaveText(`${modifierLabel}R`);
    await expect(tile(/^Terminal$|^终端$/).locator("kbd")).toHaveText(`${modifierLabel}J`);
    await expect(tile(/^Files$|^文件$/).locator("kbd")).toHaveCount(0);
    await selectSidePanel(window, "文件");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await window.getByTestId("composer").click();
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.getByTestId("file-workbench")).toBeVisible();

    await selectSidePanel(window, "审查");
    await expect(window.locator(".diff-panel")).toBeVisible();
    await expect(window.getByTestId("file-workbench")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("R"));
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await window.keyboard.press(desktopShortcut("Alt+B"));
    await expect(window.locator(".diff-panel")).toBeVisible();

    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".sidebar")).toHaveCount(0);
    await expect(window.locator(".diff-panel")).toBeVisible();
    await window.keyboard.press(desktopShortcut("B"));
    await expect(window.locator(".sidebar")).toHaveCount(1);

    await window.keyboard.press(desktopShortcut("J"));
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await expect(window.locator(".diff-panel")).toHaveCount(0);
    await terminal.locator(".xterm").click();
    const modifier = process.platform === "darwin" ? "meta" : "control";
    const pressSidePanelShortcut = () =>
      harness.electronApp.evaluate(({ BrowserWindow }, keyModifier) => {
        BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
          type: "keyDown",
          keyCode: "b",
          modifiers: [keyModifier, "alt"],
        });
      }, modifier);
    await pressSidePanelShortcut();
    await expect(window.getByTestId("workbench")).toHaveCount(0);
    await pressSidePanelShortcut();
    await expect(terminal).toBeVisible();
    await expect(
      window.getByRole("tablist", { name: /^(Workspace tools|工作台工具)$/ }).getByRole("tab"),
    ).toHaveCount(3);

    // Cmd+R reaches Review from the terminal on macOS; Ctrl+R stays with the shell elsewhere.
    await terminal.locator(".xterm").click();
    await harness.electronApp.evaluate(({ BrowserWindow }, keyModifier) => {
      BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "r",
        modifiers: [keyModifier],
      });
    }, modifier);
    if (process.platform === "darwin") {
      await expect(window.locator(".diff-panel")).toBeVisible();
    } else {
      await expect(terminal.locator(".xterm-rows")).toContainText(/i-search/);
      await expect(window.locator(".diff-panel")).toHaveCount(0);
    }
  } finally {
    await harness.close();
  }
});
