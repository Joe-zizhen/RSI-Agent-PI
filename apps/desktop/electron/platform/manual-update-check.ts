/**
 * Manual update check with confirmation dialogs. Lives outside main.ts so the
 * Settings → 更新 pane can trigger it through IPC, not only the macOS app menu.
 */
import { BrowserWindow, dialog, type MessageBoxOptions } from "electron";

import { checkForUpdate, openReleasesPage } from "./update-checker";
import { t } from "../t";

export async function runManualUpdateCheck(window?: BrowserWindow | null): Promise<void> {
  const target = window && !window.isDestroyed() ? window : undefined;
  const showDialog = (options: MessageBoxOptions) =>
    target ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options);

  try {
    const result = await checkForUpdate();

    if (result.status === "update-available") {
      // The manual path always confirms with a dialog — a notification may
      // be silently suppressed if the OS permission is denied.
      const choice = await showDialog({
        type: "info",
        title: "RSI-Agent-PI",
        message: t(
          `Version ${result.latestVersion} is available.`,
          `版本 ${result.latestVersion} 可用。`,
        ),
        detail: t(`You have ${result.currentVersion}.`, `你正在使用 ${result.currentVersion}。`),
        buttons: [t("Download", "下载"), t("Later", "稍后")],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice.response === 0) {
        await openReleasesPage(result.releaseUrl);
      }
      return;
    }

    if (result.status === "up-to-date") {
      await showDialog({
        type: "info",
        title: "RSI-Agent-PI",
        message: t(
          `You're up to date on version ${result.currentVersion}.`,
          `当前已是最新版本 ${result.currentVersion}。`,
        ),
        buttons: [t("OK", "确定")],
      });
      return;
    }

    await showDialog({
      type: "warning",
      title: "RSI-Agent-PI",
      message: t("Could not check for updates right now.", "暂时无法检查更新。"),
      detail: result.message,
      buttons: [t("OK", "确定")],
    });
  } catch (error) {
    console.error("pi-gui: manual update check failed:", error);
    await showDialog({
      type: "warning",
      title: "RSI-Agent-PI",
      message: t("Could not check for updates right now.", "暂时无法检查更新。"),
      detail: error instanceof Error ? error.message : String(error),
      buttons: [t("OK", "确定")],
    }).catch(() => undefined);
  }
}
