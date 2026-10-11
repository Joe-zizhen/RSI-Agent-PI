import type { ThemeMode, ThemePresetId } from "../../../contracts/desktop-state";
import { SettingsSelect, SettingsSwitch } from "./settings-controls";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import type { CSSProperties } from "react";
import { themePreset, themePresets, themeSwatches, themeTokensFor } from "../../../contracts/theme";
import { useActiveTheme } from "../../ui/active-theme";
import { t, useLocale } from "../../t";

interface SettingsAppearanceSectionProps {
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
  readonly onSetThemeMode: (mode: ThemeMode) => void;
  readonly onSetThemePresetId: (presetId: ThemePresetId) => void;
  readonly enableTransparency: boolean;
  readonly onSetEnableTransparency: (enabled: boolean) => void;
}

const THEME_MODES: readonly { readonly mode: ThemeMode; readonly label: string }[] = [
  {
    mode: "system",
    get label() {
      return t("System", "系统");
    },
  },
  {
    mode: "light",
    get label() {
      return t("Light", "浅色");
    },
  },
  {
    mode: "dark",
    get label() {
      return t("Dark", "深色");
    },
  },
];

export function SettingsAppearanceSection({
  themeMode,
  themePresetId,
  onSetThemeMode,
  onSetThemePresetId,
  enableTransparency,
  onSetEnableTransparency,
}: SettingsAppearanceSectionProps) {
  useLocale();
  const activePreset = themePreset(themePresetId);
  const { variant } = useActiveTheme();
  return (
    <>
      <SettingsGroup title={t("Theme", "主题")} plain>
        <div
          aria-label={t("Theme", "主题")}
          className="theme-mode-tiles"
          role="radiogroup"
          style={tilePalette(themePresetId)}
        >
          {THEME_MODES.map((option) => (
            <label className="theme-mode-tile" key={option.mode}>
              <input
                checked={themeMode === option.mode}
                name="theme-mode"
                type="radio"
                onChange={() => onSetThemeMode(option.mode)}
              />
              <span
                aria-hidden="true"
                className={`theme-mode-tile__preview theme-mode-tile__preview--${option.mode}`}
              >
                <span className="theme-mode-tile__window">
                  <span className="theme-mode-tile__line theme-mode-tile__line--title" />
                  <span className="theme-mode-tile__line" />
                  <span className="theme-mode-tile__line" />
                </span>
              </span>
              <span className="theme-mode-tile__label">{option.label}</span>
            </label>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow title={t("Color preset", "颜色预设")} description={activePreset.description}>
          <span className="settings-preset-control">
            <span aria-hidden="true" className="settings-preset-swatches">
              {themeSwatches(themePresetId, variant).map((swatch, index) => (
                <span key={index} style={{ background: swatch }} />
              ))}
            </span>
            <SettingsSelect
              label={t("Color preset", "颜色预设")}
              options={themePresets.map((preset) => ({ value: preset.id, label: preset.name }))}
              value={themePresetId}
              onChange={onSetThemePresetId}
            />
          </span>
        </SettingsRow>
        <SettingsRow
          title={t("Window transparency", "窗口透明")}
          description={t(
            "Let desktop colors show through supported surfaces.",
            "让桌面颜色透过受支持的界面显示。",
          )}
        >
          <SettingsSwitch
            checked={enableTransparency}
            label={t("Window transparency", "窗口透明")}
            onChange={onSetEnableTransparency}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function tilePalette(presetId: ThemePresetId): CSSProperties {
  const light = themeTokensFor(presetId, "light");
  const dark = themeTokensFor(presetId, "dark");
  return {
    "--tile-light-bg": light["--sidebar"],
    "--tile-light-window": light["--main"],
    "--tile-light-line": light["--line-strong"],
    "--tile-dark-bg": dark["--sidebar"],
    "--tile-dark-window": dark["--main"],
    "--tile-dark-line": dark["--line-strong"],
  } as CSSProperties;
}
