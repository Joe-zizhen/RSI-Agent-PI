import type { DesktopNotificationPermissionStatus } from "../../../contracts/ipc";
import type { NotificationPreferences } from "../../../contracts/desktop-state";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { t, useLocale } from "../../t";

interface SettingsNotificationsSectionProps {
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
}

export function SettingsNotificationsSection({
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  onSetNotificationPreferences,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
}: SettingsNotificationsSectionProps) {
  useLocale();
  const statusLabel = labelForPermissionStatus(notificationPermissionStatus);
  const statusDescription = descriptionForPermissionStatus(notificationPermissionStatus);
  const showAskMacOs = notificationPermissionStatus === "default";
  const showOpenSystemSettings = notificationPermissionStatus === "denied";
  const showRecoveryActions = showAskMacOs || showOpenSystemSettings;

  return (
    <>
      <SettingsGroup
        title={t("System", "系统")}
        description={t(
          "macOS decides whether RSI-Agent-PI can show desktop notifications at all.",
          "由 macOS 决定 RSI-Agent-PI 是否可以显示桌面通知。",
        )}
      >
        <SettingsRow
          title={t("macOS notification access", "macOS 通知权限")}
          description={statusDescription}
        >
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title={t("Turn on notifications", "开启通知")}
            description={
              showAskMacOs
                ? t(
                    "RSI-Agent-PI asks macOS when active work first moves into the background. You can also ask now.",
                    "当进行中的工作首次转入后台时，RSI-Agent-PI 会向 macOS 发出请求。你也可以现在就发起请求。",
                  )
                : t(
                    "macOS notifications are already turned off for RSI-Agent-PI. Open System Settings to enable them again.",
                    "macOS 已为 RSI-Agent-PI 关闭通知。打开系统设置以重新启用。",
                  )
            }
          >
            <div className="settings-row__actions">
              {showAskMacOs ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onRequestNotificationPermission}
                >
                  {t("Ask macOS", "向 macOS 请求")}
                </button>
              ) : null}
              {showOpenSystemSettings ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onOpenSystemNotificationSettings}
                >
                  {t("Open System Settings", "打开系统设置")}
                </button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("In-app alerts", "应用内提醒")}
        description={t(
          "Choose which background events should try to notify once macOS access is enabled.",
          "获得 macOS 权限后，选择哪些后台事件应发出通知。",
        )}
      >
        <SettingsRow
          title={t("Background completion", "后台完成")}
          description={t(
            "Notify when a background session finishes.",
            "后台会话记录完成时发出通知。",
          )}
        >
          <SettingsSwitch
            checked={notificationPreferences.backgroundCompletion}
            label={t("Background completion", "后台完成")}
            onChange={(checked) => onSetNotificationPreferences({ backgroundCompletion: checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("Background failures", "后台失败")}
          description={t("Notify when a background session fails.", "后台会话记录失败时发出通知。")}
        >
          <SettingsSwitch
            checked={notificationPreferences.backgroundFailure}
            label={t("Background failures", "后台失败")}
            onChange={(checked) => onSetNotificationPreferences({ backgroundFailure: checked })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("Needs input or approval", "需要输入或批准")}
          description={t(
            "Notify when input is needed to continue.",
            "需要输入才能继续时发出通知。",
          )}
        >
          <SettingsSwitch
            checked={notificationPreferences.attentionNeeded}
            label={t("Needs input or approval", "需要输入或批准")}
            onChange={(checked) => onSetNotificationPreferences({ attentionNeeded: checked })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function labelForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return t("Enabled", "已启用");
    case "denied":
      return t("Turned off", "已关闭");
    case "default":
      return t("Not enabled yet", "尚未启用");
    case "unsupported":
      return t("Unavailable", "不可用");
    default:
      return t("Checking…", "检查中…");
  }
}

function descriptionForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return t(
        "macOS will allow RSI-Agent-PI to show desktop notifications for background thread updates.",
        "macOS 将允许 RSI-Agent-PI 在后台会话更新时显示桌面通知。",
      );
    case "denied":
      return t(
        "macOS notifications are turned off for RSI-Agent-PI. Enable them in System Settings to receive background completion alerts.",
        "macOS 已为 RSI-Agent-PI 关闭通知。请在系统设置中启用，以便接收后台完成提醒。",
      );
    case "default":
      return t(
        "RSI-Agent-PI has not asked macOS for desktop notification access yet.",
        "RSI-Agent-PI 尚未向 macOS 请求桌面通知权限。",
      );
    case "unsupported":
      return t("Desktop notifications are unavailable on this system.", "本系统不支持桌面通知。");
    default:
      return t(
        "Checking whether macOS notifications are available for RSI-Agent-PI.",
        "正在检查 macOS 是否为 RSI-Agent-PI 提供通知功能。",
      );
  }
}
