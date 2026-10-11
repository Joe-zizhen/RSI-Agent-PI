import type { ReactNode } from "react";
import {
  BellIcon,
  ExtensionIcon,
  KeyboardIcon,
  ModelIcon,
  PlugIcon,
  RefreshIcon,
  SettingsIcon,
  SkillIcon,
  SparkIcon,
  SunIcon,
} from "../../ui/icons";
import { t } from "../../t";

export interface SettingsSectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly group: string;
  readonly icon: ReactNode;
  /** Words people search for that are not in the title, such as the page's row titles. */
  readonly keywords: readonly string[];
  readonly description: (workspaceName: string) => string;
  /** Pages that read or write one workspace's runtime. */
  readonly needsWorkspace: boolean;
}

/** Nav order: grouped the way Codex groups its settings, one entry per page. */
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    get title() {
      return t("General", "通用");
    },
    get group() {
      return t("App", "应用");
    },
    icon: <SettingsIcon />,
    keywords: ["model settings scope", "per repo", "skill slash commands", "terminal", "shell"],
    description: () => t("App and runtime defaults.", "应用与运行时默认设置。"),
    needsWorkspace: false,
  },
  {
    id: "appearance",
    get title() {
      return t("Appearance", "外观");
    },
    get group() {
      return t("App", "应用");
    },
    icon: <SunIcon />,
    keywords: ["theme", "light", "dark", "system", "preset", "colors", "transparency"],
    description: () =>
      t(
        "Choose light, dark or system mode and a color preset.",
        "选择浅色、深色或系统模式，并选择颜色预设。",
      ),
    needsWorkspace: false,
  },
  {
    id: "notifications",
    get title() {
      return t("Notifications", "通知");
    },
    get group() {
      return t("App", "应用");
    },
    icon: <BellIcon />,
    keywords: ["alerts", "background", "completion", "failures", "approval", "macos"],
    description: () =>
      t("Choose which background events alert you.", "选择哪些后台事件会向你发出提醒。"),
    needsWorkspace: false,
  },
  {
    id: "shortcuts",
    get title() {
      return t("Keyboard shortcuts", "键盘快捷键");
    },
    get group() {
      return t("App", "应用");
    },
    icon: <KeyboardIcon />,
    keywords: ["keys", "hotkeys", "keybindings"],
    description: () => t("Shortcuts available across the app.", "全应用可用的快捷键。"),
    needsWorkspace: false,
  },
  {
    id: "update",
    get title() {
      return t("Update", "更新");
    },
    get group() {
      return t("App", "应用");
    },
    icon: <RefreshIcon />,
    keywords: ["update", "upgrade", "release", "version", "pi runtime", "版本", "升级"],
    description: () =>
      t(
        "Check this app for updates, and see the built-in pi runtime version.",
        "检查本应用更新，并查看内置 pi 运行时版本。",
      ),
    needsWorkspace: false,
  },
  {
    id: "providers",
    get title() {
      return t("Providers", "提供商");
    },
    get group() {
      return t("Agent", "智能体");
    },
    icon: <PlugIcon />,
    keywords: ["login", "logout", "oauth", "api key", "auth", "custom endpoint"],
    description: (workspaceName) =>
      t(
        `Connect providers and manage auth for ${workspaceName}.`,
        `连接提供商并管理 ${workspaceName} 的认证。`,
      ),
    needsWorkspace: true,
  },
  {
    id: "models",
    get title() {
      return t("Models", "模型");
    },
    get group() {
      return t("Agent", "智能体");
    },
    icon: <ModelIcon />,
    keywords: ["default model", "reasoning", "thinking", "enabled models"],
    description: () =>
      t(
        "Choose the default model and which models appear in pickers.",
        "选择默认模型，以及选择器中显示的模型。",
      ),
    needsWorkspace: true,
  },
  {
    id: "mcp",
    get title() {
      return t("MCP servers", "MCP 服务器");
    },
    get group() {
      return t("Agent", "智能体");
    },
    icon: <ExtensionIcon />,
    keywords: ["mcp", "mcp.json", "model context protocol", "servers", "code mode", "codemode"],
    description: () =>
      t(
        "Add, remove and switch the MCP servers pi connects in each thread.",
        "添加、移除并切换 pi 在每个会话中连接的 MCP 服务器。",
      ),
    needsWorkspace: true,
  },
  {
    id: "memory",
    get title() {
      return t("Memory", "记忆");
    },
    get group() {
      return t("Agent", "智能体");
    },
    icon: <SparkIcon />,
    keywords: ["memory", "memloop", "verdict", "verdictCmd", "记忆", "判决", "世界判决"],
    description: () =>
      t(
        "memloop long-term memory switch and world verdict command.",
        "memloop 长期记忆开关与世界判决命令。",
      ),
    needsWorkspace: true,
  },
] as const satisfies readonly SettingsSectionDefinition[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Skills and extensions live in the settings nav but are their own app views. */
export const CUSTOMIZE_SECTION_ID = "customize";

export const SETTINGS_NAV_ITEMS = [
  ...SETTINGS_SECTIONS,
  {
    id: CUSTOMIZE_SECTION_ID,
    get title() {
      return t("Skills and extensions", "技能与扩展");
    },
    get group() {
      return t("custom", "自定义");
    },
    icon: <SkillIcon />,
    keywords: ["skills", "extensions", "plugins", "slash commands", "tools"],
  },
] as const;

export function settingsSectionDefinition(section: SettingsSection): SettingsSectionDefinition {
  return SETTINGS_SECTIONS.find((definition) => definition.id === section) ?? SETTINGS_SECTIONS[0];
}

export function sectionTitle(section: SettingsSection): string {
  return settingsSectionDefinition(section).title;
}
