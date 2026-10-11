import type { ReactNode } from "react";
import type {
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@rsi-agent-pi/session-driver/runtime-types";
import type {
  AppLocale,
  ModelSettingsScopeMode,
  NotificationPreferences,
  ThemePresetId,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import type {
  CustomProviderConfig,
  DesktopNotificationPermissionStatus,
} from "../../../contracts/ipc";
import { SettingsAppearanceSection } from "./settings-appearance-section";
import { SettingsGeneralSection } from "./settings-general-section";
import { type McpSettingsActions, SettingsMcpSection } from "./settings-mcp-section";
import { SettingsMemorySection } from "./settings-memory-section";
import { SettingsModelsSection } from "./settings-models-section";
import { SettingsNotificationsSection } from "./settings-notifications-section";
import { SettingsProvidersSection } from "./settings-providers-section";
import { type SettingsSection, settingsSectionDefinition } from "./settings-sections";
import { SettingsShortcutsSection } from "./settings-shortcuts-section";
import { SettingsUpdateSection } from "./settings-update-section";
import { t, useLocale } from "../../t";

export type { SettingsSection } from "./settings-sections";

interface SettingsViewProps {
  readonly workspace?: WorkspaceRecord;
  readonly runtime?: RuntimeSnapshot;
  readonly section: SettingsSection;
  readonly platform: NodeJS.Platform;
  /** Shown beside the page title, such as the workspace a page edits. */
  readonly headerAccessory?: ReactNode;
  readonly onSelectSection: (section: SettingsSection) => void;
  readonly notificationPreferences: NotificationPreferences;
  readonly notificationPermissionStatus: DesktopNotificationPermissionStatus;
  readonly notificationPermissionPending: boolean;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly locale: AppLocale;
  readonly themeMode: "system" | "light" | "dark";
  readonly themePresetId: ThemePresetId;
  readonly enableTransparency: boolean;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetDefaultModel: (provider: string, modelId: string) => void;
  readonly onSetThinkingLevel: (
    thinkingLevel: RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
  readonly onSetScopedModelPatterns: (patterns: readonly string[]) => void;
  readonly onLoginProvider: (providerId: string) => void;
  readonly onLogoutProvider: (providerId: string) => void;
  readonly onSetProviderApiKey: (providerId: string, apiKey: string) => Promise<string | undefined>;
  readonly onRemoveProviderApiKey: (providerId: string) => Promise<string | undefined>;
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
  readonly onSetNotificationPreferences: (preferences: Partial<NotificationPreferences>) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onSetLocale: (locale: AppLocale) => void;
  readonly onRelaunch: () => void;
  readonly onRequestNotificationPermission: () => void;
  readonly onOpenSystemNotificationSettings: () => void;
  readonly onSetThemeMode: (mode: "system" | "light" | "dark") => void;
  readonly onSetThemePresetId: (presetId: ThemePresetId) => void;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
  readonly memoryEnabled: boolean;
  readonly onToggleMemory: (enabled: boolean) => void;
  readonly mcpActions: McpSettingsActions;
}

export function SettingsView({
  workspace,
  runtime,
  section,
  platform,
  headerAccessory,
  onSelectSection,
  notificationPreferences,
  notificationPermissionStatus,
  notificationPermissionPending,
  modelSettingsScopeMode,
  integratedTerminalShell,
  locale,
  themeMode,
  themePresetId,
  enableTransparency,
  onSetModelSettingsScopeMode,
  onSetDefaultModel,
  onSetThinkingLevel,
  onToggleSkillCommands,
  onSetScopedModelPatterns,
  onLoginProvider,
  onLogoutProvider,
  onSetProviderApiKey,
  onRemoveProviderApiKey,
  onSaveCustomProvider,
  onDeleteCustomProvider,
  onSetNotificationPreferences,
  onSetIntegratedTerminalShell,
  onSetLocale,
  onRelaunch,
  onRequestNotificationPermission,
  onOpenSystemNotificationSettings,
  onSetThemeMode,
  onSetThemePresetId,
  onSetEnableTransparency,
  memoryEnabled,
  onToggleMemory,
  mcpActions,
}: SettingsViewProps) {
  useLocale();
  const definition = settingsSectionDefinition(section);
  const header = (
    <header className="view-header">
      <div>
        <h1 className="view-header__title">{definition.title}</h1>
        <p className="view-header__body">
          {definition.description(workspace?.name ?? t("this workspace", "当前项目"))}
        </p>
      </div>
      {headerAccessory ? <div className="view-header__actions">{headerAccessory}</div> : null}
    </header>
  );

  if (!workspace && definition.needsWorkspace) {
    return (
      <section className="canvas">
        <div className="conversation settings-view">
          {header}
          <div className="settings-group">
            <div className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{t("Select a workspace", "选择项目")}</div>
                <div className="settings-row__description">
                  {t(
                    "Providers and models are set per workspace. Choose one, or open a folder first.",
                    "提供商与模型按项目设置。请选择一个项目，或先打开一个文件夹。",
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas">
      <div className="conversation settings-view">
        {header}

        <div className="settings-grid">
          {section === "appearance" ? (
            <SettingsAppearanceSection
              themeMode={themeMode}
              themePresetId={themePresetId}
              onSetThemeMode={onSetThemeMode}
              onSetThemePresetId={onSetThemePresetId}
              enableTransparency={enableTransparency}
              onSetEnableTransparency={onSetEnableTransparency}
            />
          ) : null}

          {section === "general" ? (
            <SettingsGeneralSection
              runtime={runtime}
              modelSettingsScopeMode={modelSettingsScopeMode}
              integratedTerminalShell={integratedTerminalShell}
              locale={locale}
              onSetModelSettingsScopeMode={onSetModelSettingsScopeMode}
              onSetIntegratedTerminalShell={onSetIntegratedTerminalShell}
              onToggleSkillCommands={onToggleSkillCommands}
              onSetLocale={onSetLocale}
              onRelaunch={onRelaunch}
            />
          ) : null}

          {section === "shortcuts" ? <SettingsShortcutsSection platform={platform} /> : null}

          {section === "update" ? <SettingsUpdateSection /> : null}

          {section === "providers" ? (
            <SettingsProvidersSection
              runtime={runtime}
              onLoginProvider={onLoginProvider}
              onLogoutProvider={onLogoutProvider}
              onSetProviderApiKey={onSetProviderApiKey}
              onRemoveProviderApiKey={onRemoveProviderApiKey}
              onSaveCustomProvider={onSaveCustomProvider}
              onDeleteCustomProvider={onDeleteCustomProvider}
            />
          ) : null}

          {section === "models" ? (
            <SettingsModelsSection
              runtime={runtime}
              onOpenProviders={() => onSelectSection("providers")}
              onSetDefaultModel={onSetDefaultModel}
              onSetScopedModelPatterns={onSetScopedModelPatterns}
              onSetThinkingLevel={onSetThinkingLevel}
            />
          ) : null}

          {section === "mcp" && workspace ? (
            <SettingsMcpSection actions={mcpActions} workspaceId={workspace.id} />
          ) : null}

          {section === "memory" && workspace ? (
            <SettingsMemorySection
              workspaceId={workspace.id}
              memoryEnabled={memoryEnabled}
              onToggleMemory={onToggleMemory}
            />
          ) : null}

          {section === "notifications" ? (
            <SettingsNotificationsSection
              notificationPreferences={notificationPreferences}
              notificationPermissionStatus={notificationPermissionStatus}
              notificationPermissionPending={notificationPermissionPending}
              onSetNotificationPreferences={onSetNotificationPreferences}
              onRequestNotificationPermission={onRequestNotificationPermission}
              onOpenSystemNotificationSettings={onOpenSystemNotificationSettings}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
