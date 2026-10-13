import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertExists,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("supports workspace rename and remove from the sidebar menu", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspaceA = await makeWorkspace("workspace-menu-a");
  const workspaceB = await makeWorkspace("workspace-menu-b");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspaceA, workspaceB],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspaceA);
    await waitForWorkspaceByPath(window, workspaceB);

    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.path === workspaceA);
    assertExists(workspace, "Expected first workspace");

    await window
      .getByRole("button", {
        name: new RegExp(
          `^(Workspace actions for ${basename(workspaceA)}|${basename(workspaceA)} 的项目操作)$`,
        ),
      })
      .click();
    const workspaceMenu = window.locator(".workspace-menu").last();
    await expect(workspaceMenu.getByRole("button", { name: "打开文件夹" })).toBeVisible();
    await expect(workspaceMenu.getByRole("button", { name: "编辑名称" })).toBeVisible();
    await expect(workspaceMenu.getByRole("button", { name: "移除" })).toBeVisible();

    await workspaceMenu.getByRole("button", { name: "编辑名称" }).click();
    const renameInput = window.getByLabel(`重命名 ${basename(workspaceA)}`);
    await renameInput.fill("Renamed workspace");
    await window.getByRole("button", { name: "保存" }).click();

    await expect
      .poll(async () => {
        const latest = await getDesktopState(window);
        return latest.workspaces.find((entry) => entry.id === workspace.id)?.name;
      })
      .toBe("Renamed workspace");

    const acceptRemoval = window.waitForEvent("dialog").then((dialog) => dialog.accept());
    await window.getByRole("button", { name: "Renamed workspace 的项目操作" }).click();
    await Promise.all([window.getByRole("button", { name: "移除" }).click(), acceptRemoval]);

    await expect
      .poll(async () => {
        const latest = await getDesktopState(window);
        return latest.workspaces.some((entry) => entry.id === workspace.id);
      })
      .toBe(false);
  } finally {
    await harness.close();
  }
});
