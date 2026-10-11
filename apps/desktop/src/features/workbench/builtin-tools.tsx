import type { ComponentType, ReactNode } from "react";
import { BUILTIN_TOOL_KINDS, type BuiltinToolKind } from "../../../contracts/workbench";
import { DiffIcon, FileIcon, TerminalIcon } from "../../ui/icons";
import { t } from "../../t";

interface BuiltinToolDefinition {
  readonly label: string;
  /** Shown in the tool chooser. */
  readonly description: string;
  readonly Icon: ComponentType;
  /** Key that toggles the tool with the platform modifier, when it has one. */
  readonly shortcutKey?: string;
}

/** Presentation for every built-in tool; a missing kind fails the build. */
export const BUILTIN_TOOLS = {
  files: {
    get label() {
      return t("Files", "文件");
    },
    get description() {
      return t("Browse files in this checkout", "浏览此工作副本中的文件");
    },
    Icon: FileIcon,
  },
  changes: {
    get label() {
      return t("Review", "审查");
    },
    get description() {
      return t("Review uncommitted, branch or turn changes", "审查未提交、分支或轮次的变更");
    },
    Icon: DiffIcon,
    shortcutKey: "R",
  },
  terminal: {
    get label() {
      return t("Terminal", "终端");
    },
    get description() {
      return t("Run commands in this task's checkout", "在此任务的工作副本中运行命令");
    },
    Icon: TerminalIcon,
    shortcutKey: "J",
  },
} as const satisfies Record<BuiltinToolKind, BuiltinToolDefinition>;

/** Chooser order follows the contract's kind list. */
export const BUILTIN_TOOL_ENTRIES = BUILTIN_TOOL_KINDS.map(
  (kind): BuiltinToolDefinition & { readonly kind: BuiltinToolKind } => {
    const tool = BUILTIN_TOOLS[kind] as BuiltinToolDefinition;
    return {
      kind,
      get label() {
        return tool.label;
      },
      get description() {
        return tool.description;
      },
      Icon: tool.Icon,
      shortcutKey: tool.shortcutKey,
    };
  },
);

/** The composition root supplies one panel per built-in tool; rendered only while selected. */
type BuiltinToolPanels = Record<BuiltinToolKind, () => ReactNode>;

/** Requires a panel for every built-in kind, so a new tool cannot silently render nothing. */
export function renderBuiltinToolPanel(
  kind: BuiltinToolKind,
  panels: BuiltinToolPanels,
): ReactNode {
  return panels[kind]();
}
