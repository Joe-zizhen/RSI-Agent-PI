import { SettingsGroup, SettingsRow } from "./settings-utils";
import { t } from "../../t";

/**
 * "Mod" is Cmd on macOS and Ctrl elsewhere; "Ctrl" is Control on every platform.
 * "TabMod" is Control on macOS and Alt elsewhere, the side panel tab modifier.
 */
type KeyModifier = "Ctrl" | "Alt" | "Shift" | "Mod";
type Modifier = KeyModifier | "TabMod";

interface Shortcut {
  readonly title: string;
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

// Mirrors getDesktopCommandFromShortcut in contracts/ipc.ts and the keys the renderer handles
// itself (find, thread switcher, composer, terminal tabs).
const SHORTCUT_GROUPS: readonly {
  readonly title: string;
  readonly shortcuts: readonly Shortcut[];
}[] = [
  {
    get title() {
      return t("App", "应用");
    },
    shortcuts: [
      {
        get title() {
          return t("Command palette", "命令面板");
        },
        modifiers: ["Mod"],
        key: "K",
      },
      {
        get title() {
          return t("Go to file", "跳转到文件");
        },
        modifiers: ["Mod"],
        key: "P",
      },
      {
        get title() {
          return t("Open settings", "打开设置");
        },
        modifiers: ["Mod"],
        key: ",",
      },
      {
        get title() {
          return t("Toggle sidebar", "切换侧边栏");
        },
        modifiers: ["Mod"],
        key: "B",
      },
      {
        get title() {
          return t("Toggle side panel", "切换侧边面板");
        },
        modifiers: ["Mod", "Alt"],
        key: "B",
      },
      {
        get title() {
          return t("New window", "新建窗口");
        },
        modifiers: ["Mod", "Shift"],
        key: "N",
      },
    ],
  },
  {
    get title() {
      return t("Threads", "会话");
    },
    shortcuts: [
      {
        get title() {
          return t("New thread", "新建会话");
        },
        modifiers: ["Mod"],
        key: "N",
      },
      {
        get title() {
          return t("Switch to recent thread", "切换到最近会话");
        },
        modifiers: ["Mod"],
        key: "1–9",
      },
      {
        get title() {
          return t("Cycle through threads", "在会话间循环切换");
        },
        modifiers: ["Ctrl"],
        key: "Tab",
      },
      {
        get title() {
          return t("Find in thread", "在会话中查找");
        },
        modifiers: ["Mod"],
        key: "F",
      },
    ],
  },
  {
    get title() {
      return t("Composer", "输入框");
    },
    shortcuts: [
      {
        get title() {
          return t("Send message, or queue it during a run", "发送消息，运行期间则排队");
        },
        modifiers: [],
        key: "Enter",
      },
      {
        get title() {
          return t("Steer the running agent", "引导运行中的智能体");
        },
        modifiers: ["Mod"],
        key: "Enter",
      },
      {
        get title() {
          return t("New line", "换行");
        },
        modifiers: ["Shift"],
        key: "Enter",
      },
    ],
  },
  {
    get title() {
      return t("Workbench", "工作台");
    },
    shortcuts: [
      {
        get title() {
          return t("Toggle terminal", "切换终端");
        },
        modifiers: ["Mod"],
        key: "J",
      },
      {
        get title() {
          return t("New terminal tab", "新建终端标签页");
        },
        modifiers: ["Mod"],
        key: "T",
      },
      {
        get title() {
          return t("Toggle review", "切换审查面板");
        },
        modifiers: ["Mod"],
        key: "R",
      },
      {
        get title() {
          return t("Switch to side panel tab", "切换到侧边面板标签页");
        },
        modifiers: ["TabMod"],
        key: "1–9",
      },
      {
        get title() {
          return t("Close workbench tab", "关闭工作台标签页");
        },
        modifiers: ["Mod"],
        key: "W",
      },
    ],
  },
];

// Apple's modifier order is ⌃⌥⇧⌘, matching the menu bar and the command palette hints.
const MAC_MODIFIERS: readonly (readonly [KeyModifier, string])[] = [
  ["Ctrl", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Mod", "⌘"],
];

function shortcutKeys(platform: NodeJS.Platform, shortcut: Shortcut): readonly string[] {
  const held = shortcut.modifiers.map((modifier): KeyModifier =>
    modifier === "TabMod" ? (platform === "darwin" ? "Ctrl" : "Alt") : modifier,
  );
  if (platform === "darwin") {
    const modifiers = MAC_MODIFIERS.filter(([modifier]) => held.includes(modifier)).map(
      ([, symbol]) => symbol,
    );
    return [...modifiers, shortcut.key === "Enter" ? "↩" : shortcut.key];
  }
  const modifiers = (["Ctrl", "Alt", "Shift"] as const).filter(
    (modifier) => held.includes(modifier) || (modifier === "Ctrl" && held.includes("Mod")),
  );
  return [...modifiers, shortcut.key];
}

export function SettingsShortcutsSection({ platform }: { readonly platform: NodeJS.Platform }) {
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.shortcuts.map((shortcut) => (
            <SettingsRow key={shortcut.title} title={shortcut.title}>
              <span className="settings-keys">
                {shortcutKeys(platform, shortcut).map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </span>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
    </>
  );
}
