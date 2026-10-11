import { useEffect, useState } from "react";
import type { RuntimeSnapshot } from "@rsi-agent-pi/session-driver/runtime-types";
import type { AppLocale, ModelSettingsScopeMode } from "../../../contracts/desktop-state";
import { t, useLocale } from "../../t";
import { SettingsSegmented, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";

interface SettingsGeneralSectionProps {
  readonly runtime?: RuntimeSnapshot;
  readonly modelSettingsScopeMode: ModelSettingsScopeMode;
  readonly integratedTerminalShell: string;
  readonly locale: AppLocale;
  readonly onSetModelSettingsScopeMode: (mode: ModelSettingsScopeMode) => void;
  readonly onSetIntegratedTerminalShell: (shellPath: string) => void;
  readonly onToggleSkillCommands: (enabled: boolean) => void;
  readonly onSetLocale: (locale: AppLocale) => void;
  readonly onRelaunch: () => void;
}

export function SettingsGeneralSection({
  runtime,
  modelSettingsScopeMode,
  integratedTerminalShell,
  locale,
  onSetModelSettingsScopeMode,
  onSetIntegratedTerminalShell,
  onToggleSkillCommands,
  onSetLocale,
  onRelaunch,
}: SettingsGeneralSectionProps) {
  useLocale();
  const [terminalShellDraft, setTerminalShellDraft] = useState(integratedTerminalShell);
  const [localeNoticeVisible, setLocaleNoticeVisible] = useState(false);

  useEffect(() => {
    setTerminalShellDraft(integratedTerminalShell);
  }, [integratedTerminalShell]);

  const commitTerminalShellDraft = () => {
    if (terminalShellDraft !== integratedTerminalShell) {
      onSetIntegratedTerminalShell(terminalShellDraft);
    }
  };

  return (
    <>
      <SettingsGroup title={t("Interface", "界面")}>
        <SettingsRow
          title={t("Language", "语言")}
          description={t("The language of the interface.", "界面使用的语言。")}
        >
          <SettingsSegmented
            label={t("Language", "语言")}
            options={[
              { value: "zh", label: "简体中文" },
              { value: "en", label: "English" },
            ]}
            value={locale}
            onChange={(next) => {
              if (next === locale) {
                return;
              }
              onSetLocale(next);
              setLocaleNoticeVisible(true);
            }}
          />
        </SettingsRow>
        {localeNoticeVisible ? (
          <div className="locale-restart-notice" data-testid="locale-restart-notice">
            <div className="locale-restart-notice__body">
              <span className="locale-restart-notice__description">
                {t(
                  "The interface language has been changed. Menus, dialogs and built-in plugins change language after a restart.",
                  "界面语言已切换。菜单、对话框与内置插件的语言在重启后全部生效。",
                )}
              </span>
            </div>
            <button className="locale-restart-notice__action" type="button" onClick={onRelaunch}>
              {t("Restart Now", "立即重启")}
            </button>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t("Agent", "智能体")}>
        <SettingsRow
          title={t("Model settings scope", "模型设置范围")}
          description={t(
            "Apply the default model and enabled models everywhere, or set them per repo.",
            "在全局应用默认模型与启用的模型，或按仓库单独设置。",
          )}
        >
          <SettingsSegmented
            label={t("Model settings scope", "模型设置范围")}
            options={[
              { value: "app-global", label: t("App-global", "应用全局") },
              { value: "per-repo", label: t("Per repo", "按仓库") },
            ]}
            value={modelSettingsScopeMode}
            onChange={onSetModelSettingsScopeMode}
          />
        </SettingsRow>
        <SettingsRow
          title={t("Skill slash commands", "技能斜杠命令")}
          description={t(
            "Offer each skill as a slash command in the composer.",
            "在输入框中把每个技能作为斜杠命令提供。",
          )}
        >
          <SettingsSwitch
            checked={runtime?.settings.enableSkillCommands ?? true}
            label={t("Enable skill slash commands", "启用技能斜杠命令")}
            onChange={onToggleSkillCommands}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Terminal", "终端")}>
        <SettingsRow
          title="Shell"
          description={t(
            "The shell the integrated terminal starts. Leave blank to use your login shell.",
            "集成终端启动的 Shell。留空则使用登录 Shell。",
          )}
        >
          <input
            aria-label={t("Shell of integrated terminal", "集成终端的 Shell")}
            className="settings-text-input"
            placeholder="/bin/zsh"
            spellCheck={false}
            type="text"
            value={terminalShellDraft}
            onBlur={commitTerminalShellDraft}
            onChange={(event) => setTerminalShellDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
