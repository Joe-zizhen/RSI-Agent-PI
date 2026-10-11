import type { ReactNode } from "react";
import { formatShortcut } from "../../../contracts/ipc";
import type { BuiltinToolKind } from "../../../contracts/workbench";
import type { ThreadAction } from "../threads/thread-actions";
import { BUILTIN_TOOL_ENTRIES } from "../workbench/builtin-tools";
import type { SettingsSection } from "../settings/settings-view";
import { sectionTitle } from "../settings/settings-sections";
import {
  ClockIcon,
  ExtensionIcon,
  FileIcon,
  FolderIcon,
  ModelIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarToggleIcon,
  SidePanelIcon,
  SkillIcon,
} from "../../ui/icons";
import { t } from "../../t";

export type PaletteMode = "commands" | "files" | "models";

export interface PaletteAction {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly hint?: string;
  /** Actions that open another palette list keep the palette open. */
  readonly keepsOpen?: boolean;
  readonly run: () => void;
}

/** "Settings" itself opens General. */
const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "appearance",
  "notifications",
  "shortcuts",
  "providers",
  "models",
  "mcp",
];

/** What the app can do right now; an action is listed only when it would work. */
export interface PaletteActionContext {
  readonly platform: NodeJS.Platform;
  readonly hasWorkspace: boolean;
  /** A thread is open in the main pane, with the actions its menus show. */
  readonly thread?: {
    readonly canSwitchModel: boolean;
    readonly actions: readonly ThreadAction[];
  };
  readonly canToggleSidebar: boolean;
  readonly newThread: () => void;
  readonly openFolder: () => void;
  readonly openSettings: (section: SettingsSection) => void;
  readonly openSkills: () => void;
  readonly openExtensions: () => void;
  readonly openScheduledTasks: () => void;
  readonly toggleSidebar: () => void;
  /** Shows the tool in the side panel, or hides the panel when that tool is already showing. */
  readonly toggleTool: (kind: BuiltinToolKind) => void;
  readonly toggleSidePanel: () => void;
  /** Extension views the side panel can open for this thread. */
  readonly extensionViews: readonly {
    readonly id: string;
    readonly title: string;
    readonly open: () => void;
  }[];
  readonly findInThread: () => void;
  readonly openPaletteMode: (mode: PaletteMode) => void;
}

export function buildPaletteActions(context: PaletteActionContext): readonly PaletteAction[] {
  const { platform, thread } = context;
  const actions: PaletteAction[] = [];
  if (context.hasWorkspace) {
    actions.push({
      id: "new-thread",
      title: t("New thread", "新建会话"),
      icon: <PlusIcon />,
      hint: formatShortcut(platform, "N"),
      run: context.newThread,
    });
  }
  actions.push({
    id: "open-folder",
    title: t("Open folder…", "打开文件夹…"),
    icon: <FolderIcon />,
    run: context.openFolder,
  });
  if (thread) {
    actions.push(
      {
        id: "go-to-file",
        title: t("Go to file…", "转到文件…"),
        icon: <FileIcon />,
        hint: formatShortcut(platform, "P"),
        keepsOpen: true,
        run: () => context.openPaletteMode("files"),
      },
      {
        id: "find-in-thread",
        title: t("Find in thread", "在会话中查找"),
        icon: <SearchIcon />,
        hint: formatShortcut(platform, "F"),
        run: context.findInThread,
      },
    );
    if (thread.canSwitchModel) {
      actions.push({
        id: "switch-model",
        title: t("Switch model…", "切换模型…"),
        icon: <ModelIcon />,
        keepsOpen: true,
        run: () => context.openPaletteMode("models"),
      });
    }
    for (const { kind, label, Icon, shortcutKey } of BUILTIN_TOOL_ENTRIES) {
      actions.push({
        id: `toggle-${kind}`,
        title: t(`Toggle ${label.toLowerCase()}`, `切换${label}面板`),
        icon: <Icon />,
        hint: shortcutKey ? formatShortcut(platform, shortcutKey) : undefined,
        run: () => context.toggleTool(kind),
      });
    }
    actions.push({
      id: "toggle-side-panel",
      title: t("Toggle side panel", "切换侧边面板"),
      icon: <SidePanelIcon />,
      hint: formatShortcut(platform, "B", { alt: true }),
      run: context.toggleSidePanel,
    });
    for (const view of context.extensionViews) {
      actions.push({
        id: `extension-view:${view.id}`,
        title: t(`Open ${view.title}`, `打开 ${view.title}`),
        icon: <ExtensionIcon />,
        run: view.open,
      });
    }
    actions.push(...thread.actions);
  }
  if (context.canToggleSidebar) {
    actions.push({
      id: "toggle-sidebar",
      title: t("Toggle sidebar", "切换侧边栏"),
      icon: <SidebarToggleIcon />,
      hint: formatShortcut(platform, "B"),
      run: context.toggleSidebar,
    });
  }
  actions.push({
    id: "scheduled-tasks",
    title: t("Scheduled tasks", "计划任务"),
    icon: <ClockIcon />,
    run: context.openScheduledTasks,
  });
  if (context.hasWorkspace) {
    actions.push(
      { id: "skills", title: t("Skills", "技能"), icon: <SkillIcon />, run: context.openSkills },
      {
        id: "extensions",
        title: t("Extensions", "扩展"),
        icon: <ExtensionIcon />,
        run: context.openExtensions,
      },
    );
  }
  actions.push({
    id: "settings",
    title: t("Settings", "设置"),
    icon: <SettingsIcon />,
    hint: formatShortcut(platform, ","),
    run: () => context.openSettings("general"),
  });
  for (const section of SETTINGS_SECTIONS) {
    actions.push({
      id: `settings-${section}`,
      title: t(`Settings: ${sectionTitle(section)}`, `设置：${sectionTitle(section)}`),
      icon: <SettingsIcon />,
      run: () => context.openSettings(section),
    });
  }
  return actions;
}
