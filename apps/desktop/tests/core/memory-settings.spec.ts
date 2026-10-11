import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("memory settings gate the memloop extension and persist verdictCmd", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("memory-settings-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window.getByRole("button", { name: "记忆", exact: true }).click();

    // The section is present and the gate starts on.
    const enableMemory = window.getByRole("switch", { name: "启用记忆" });
    await expect(enableMemory).toBeVisible();
    await expect(enableMemory).toBeChecked();

    // verdictCmd lands in the memloop section of pi's global settings file.
    const verdictInput = window.getByRole("textbox", { name: "verdictCmd 世界判决命令" });
    await expect(verdictInput).toBeVisible();
    await verdictInput.fill("exit 0");
    await verdictInput.press("Enter");
    await expect
      .poll(async () => {
        try {
          const raw = await readFile(join(userDataDir, "agent", "settings.json"), "utf8");
          const parsed = JSON.parse(raw) as { memloop?: { verdictCmd?: unknown } };
          return parsed.memloop?.verdictCmd;
        } catch {
          return undefined;
        }
      })
      .toBe("exit 0");

    // Switching memory off disables the built-in memloop extension everywhere.
    await enableMemory.click();
    await expect(enableMemory).not.toBeChecked();
    await window.getByRole("button", { name: "技能与扩展", exact: true }).click();
    await window.getByRole("tab", { name: /^Extensions/ }).click();
    await expect(window.getByTestId("extensions-surface")).toBeVisible();
    await expect(window.getByRole("switch", { name: "Enable memloop 长期记忆" })).not.toBeChecked();
  } finally {
    await harness.close();
  }
});
