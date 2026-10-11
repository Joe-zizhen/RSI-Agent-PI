import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("settings general offers the language row and switching to English relabels it", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("locale-settings-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "设置", exact: true }).click();
    await window.getByRole("button", { name: "通用", exact: true }).click();

    const languageGroup = window.locator('[aria-label="语言"]');
    await expect(languageGroup).toHaveCount(1);
    await expect(languageGroup.getByRole("button", { name: "English", exact: true })).toHaveCount(
      1,
    );
    await expect(
      languageGroup.getByRole("button", { name: "简体中文", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    await languageGroup.getByRole("button", { name: "English", exact: true }).click();

    const notice = window.locator('[data-testid="locale-restart-notice"]');
    await expect(notice).toContainText("The interface language has been changed.");
    await expect(notice.getByRole("button", { name: "Restart Now", exact: true })).toHaveCount(1);
    // t() reads the new locale as soon as the switch lands: the row is relabelled.
    await expect(window.locator(".settings-row__title", { hasText: "Language" })).toHaveCount(1);

    await expect
      .poll(async () => {
        const raw = await readFile(join(userDataDir, "ui-state.json"), "utf8");
        return (JSON.parse(raw) as { locale?: string }).locale;
      })
      .toBe("en");
  } finally {
    await harness.close();
  }
});
