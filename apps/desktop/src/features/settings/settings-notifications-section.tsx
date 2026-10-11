import type { DesktopNotificationPermissionStatus } from "../../../contracts/ipc";
import type { NotificationPreferences } from "../../../contracts/desktop-state";
import { SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

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
  const statusLabel = labelForPermissionStatus(notificationPermissionStatus);
  const statusDescription = descriptionForPermissionStatus(notificationPermissionStatus);
  const showAskMacOs = notificationPermissionStatus === "default";
  const showOpenSystemSettings = notificationPermissionStatus === "denied";
  const showRecoveryActions = showAskMacOs || showOpenSystemSettings;

  return (
    <>
      <SettingsGroup title="系统" description="由 macOS 决定 RSI-Agent-PI 是否可以显示桌面通知。">
        <SettingsRow title="macOS 通知权限" description={statusDescription}>
          <span className="settings-row__value">{statusLabel}</span>
        </SettingsRow>
        {showRecoveryActions ? (
          <SettingsRow
            title="开启通知"
            description={
              showAskMacOs
                ? "当进行中的工作首次转入后台时，RSI-Agent-PI 会向 macOS 发出请求。你也可以现在就发起请求。"
                : "macOS 已为 RSI-Agent-PI 关闭通知。打开系统设置以重新启用。"
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
                  向 macOS 请求
                </button>
              ) : null}
              {showOpenSystemSettings ? (
                <button
                  className="button button--secondary"
                  disabled={notificationPermissionPending}
                  type="button"
                  onClick={onOpenSystemNotificationSettings}
                >
                  打开系统设置
                </button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="应用内提醒"
        description="获得 macOS 权限后，选择哪些后台事件应发出通知。"
      >
        <SettingsRow title="后台完成" description="后台会话记录完成时发出通知。">
          <SettingsSwitch
            checked={notificationPreferences.backgroundCompletion}
            label="后台完成"
            onChange={(checked) => onSetNotificationPreferences({ backgroundCompletion: checked })}
          />
        </SettingsRow>
        <SettingsRow title="后台失败" description="后台会话记录失败时发出通知。">
          <SettingsSwitch
            checked={notificationPreferences.backgroundFailure}
            label="后台失败"
            onChange={(checked) => onSetNotificationPreferences({ backgroundFailure: checked })}
          />
        </SettingsRow>
        <SettingsRow title="需要输入或批准" description="需要输入才能继续时发出通知。">
          <SettingsSwitch
            checked={notificationPreferences.attentionNeeded}
            label="需要输入或批准"
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
      return "已启用";
    case "denied":
      return "已关闭";
    case "default":
      return "尚未启用";
    case "unsupported":
      return "不可用";
    default:
      return "检查中…";
  }
}

function descriptionForPermissionStatus(status: DesktopNotificationPermissionStatus): string {
  switch (status) {
    case "granted":
      return "macOS 将允许 RSI-Agent-PI 在后台会话更新时显示桌面通知。";
    case "denied":
      return "macOS 已为 RSI-Agent-PI 关闭通知。请在系统设置中启用，以便接收后台完成提醒。";
    case "default":
      return "RSI-Agent-PI 尚未向 macOS 请求桌面通知权限。";
    case "unsupported":
      return "本系统不支持桌面通知。";
    default:
      return "正在检查 macOS 是否为 RSI-Agent-PI 提供通知功能。";
  }
}
