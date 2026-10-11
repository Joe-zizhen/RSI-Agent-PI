import type { RuntimeExtensionRecord } from "@rsi-agent-pi/session-driver/runtime-types";
import type {
  ExtensionCommandCompatibilityRecord,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import { ExtensionIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import {
  extensionGroupLabel,
  isPiAddonExtension,
  isPiGuiBuiltinExtension,
  piAddonsLabel,
  piGuiToolsLabel,
  sourceScopeGroupLabel,
} from "./extension-display";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";
import { t, useLocale } from "../../t";

const groupOrder = (): readonly string[] => [
  sourceScopeGroupLabel("project"),
  sourceScopeGroupLabel("user"),
  sourceScopeGroupLabel("temporary"),
  piAddonsLabel(),
  piGuiToolsLabel(),
];

interface ExtensionsTabProps {
  readonly workspace: WorkspaceRecord;
  readonly extensions: readonly RuntimeExtensionRecord[];
  readonly commandCompatibility: readonly ExtensionCommandCompatibilityRecord[];
  readonly searching: boolean;
  /** The extension whose detail page is open, looked up in the unfiltered list. */
  readonly selected?: RuntimeExtensionRecord;
  readonly onSelect: (path: string | undefined) => void;
  readonly onToggleExtension: (path: string, enabled: boolean) => void;
  readonly onOpenExtensionFolder: (path: string) => void;
}

export function ExtensionsTab({
  workspace,
  extensions,
  commandCompatibility,
  searching,
  selected,
  onSelect,
  onToggleExtension,
  onOpenExtensionFolder,
}: ExtensionsTabProps) {
  useLocale();
  // The list stays mounted under an open detail so expanded groups, scroll and focus survive.
  const list =
    extensions.length === 0 ? (
      <ResourceEmptyState
        title={
          searching
            ? t("No extensions match", "没有匹配的扩展")
            : t("No extensions yet", "还没有扩展")
        }
        body={
          searching
            ? t("Try another name, command or tool.", "换一个名称、命令或工具再试。")
            : t(
                "Extensions are discovered in this workspace and your user extension folders. Refresh after adding one.",
                "扩展会在此项目和你的用户扩展文件夹中被发现。添加后刷新即可。",
              )
        }
      />
    ) : (
      <ResourceList
        expanded={searching}
        groups={groupExtensions(extensions, onToggleExtension)}
        icon={<ExtensionIcon />}
        testId="extensions-list"
        onOpen={onSelect}
      />
    );

  return (
    <>
      {selected ? (
        <ExtensionDetail
          commandCompatibility={commandCompatibility}
          selected={selected}
          workspace={workspace}
          onOpenExtensionFolder={onOpenExtensionFolder}
          onSelect={onSelect}
          onToggleExtension={onToggleExtension}
        />
      ) : null}
      <div hidden={Boolean(selected)}>{list}</div>
    </>
  );
}

function ExtensionDetail({
  selected,
  workspace,
  commandCompatibility,
  onSelect,
  onToggleExtension,
  onOpenExtensionFolder,
}: Omit<ExtensionsTabProps, "extensions" | "searching" | "selected"> & {
  readonly selected: RuntimeExtensionRecord;
}) {
  useLocale();
  const hasFolder = isFolderExtension(selected);
  const compatibilityRecords = commandCompatibility
    .filter((record) => record.extensionPath === selected.path)
    .sort((left, right) => left.commandName.localeCompare(right.commandName));
  return (
    <ResourceDetail
      actions={
        hasFolder ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onOpenExtensionFolder(selected.path)}
          >
            Open folder
          </button>
        ) : null
      }
      backLabel="All extensions"
      enabled={selected.enabled}
      icon={<ExtensionIcon />}
      subtitle={selected.sourceInfo.source}
      title={selected.displayName}
      onBack={() => onSelect(undefined)}
      onToggle={
        isToggleableExtension(selected)
          ? (enabled) => onToggleExtension(selected.path, enabled)
          : undefined
      }
    >
      {selected.description ? (
        <p className="resource-detail__description">{selected.description}</p>
      ) : null}
      <SettingsGroup>
        <SettingsRow
          title={t("Source", "来源")}
          description={
            isPiAddonExtension(selected)
              ? t(
                  "Ships with pi; this switch also applies to pi in the terminal",
                  "随 pi 附带；此开关同时作用于终端中的 pi",
                )
              : selected.sourceInfo.origin === "package"
                ? t("Installed as a package", "已作为软件包安装")
                : t("Loaded from a file", "从文件加载")
          }
        >
          <span className="settings-row__value">{extensionGroupLabel(selected)}</span>
        </SettingsRow>
        {isPiGuiBuiltinExtension(selected) || isPiAddonExtension(selected) ? null : (
          <SettingsRow title={t("Location", "位置")}>
            <code className="resource-detail__code" title={selected.path}>
              {displayPath(selected.path, workspace.path)}
            </code>
          </SettingsRow>
        )}
      </SettingsGroup>
      <ExtensionContributionSection
        title={t("Tools", "工具")}
        items={selected.tools.map((tool) => tool.name)}
      />
      {selected.commands.length > 0 ? (
        <ExtensionCompatibilitySection
          commands={selected.commands}
          compatibilityRecords={compatibilityRecords}
        />
      ) : null}
      <ExtensionContributionSection title={t("Flags", "标志")} items={selected.flags} />
      <ExtensionContributionSection title={t("Shortcuts", "快捷键")} items={selected.shortcuts} />
      <ExtensionDiagnostics diagnostics={selected.diagnostics} />
    </ResourceDetail>
  );
}

function groupExtensions(
  extensions: readonly RuntimeExtensionRecord[],
  onToggleExtension: (path: string, enabled: boolean) => void,
): readonly ResourceListGroup[] {
  return groupOrder()
    .map((label) => ({
      label,
      items: extensions
        .filter((extension) => extensionGroupLabel(extension) === label)
        .map((extension) => ({
          id: extension.path,
          title: extension.displayName,
          description: describeExtension(extension),
          enabled: extension.enabled,
          onToggle: isToggleableExtension(extension)
            ? (enabled: boolean) => onToggleExtension(extension.path, enabled)
            : undefined,
        })),
    }))
    .filter((group) => group.items.length > 0);
}

/** One line for the list: the extension's own description, else what it contributes. */
function describeExtension(extension: RuntimeExtensionRecord): string {
  if (extension.description) return extension.description;
  const parts = [
    countLabel(extension.tools.length, t("Tools", "工具")),
    countLabel(extension.commands.length, t("Command", "命令")),
    countLabel(extension.diagnostics.length, t("Problems", "问题")),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : extension.sourceInfo.source;
}

function countLabel(count: number, noun: string): string {
  return count === 0 ? "" : t(`${count} ${noun}${count === 1 ? "" : "s"}`, `${count} 个${noun}`);
}

function isFolderExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    !isPiAddonExtension(extension) &&
    (extension.sourceInfo.scope === "project" || extension.sourceInfo.scope === "user")
  );
}

function isToggleableExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    isFolderExtension(extension) ||
    isPiAddonExtension(extension) ||
    isPiGuiBuiltinExtension(extension)
  );
}

function ExtensionContributionSection({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <SettingsGroup title={title}>
      <div className="resource-detail__tokens">
        {items.map((item) => (
          <code className="resource-detail__token" key={item}>
            {item}
          </code>
        ))}
      </div>
    </SettingsGroup>
  );
}

function ExtensionDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: RuntimeExtensionRecord["diagnostics"];
}) {
  useLocale();
  if (diagnostics.length === 0) return null;
  return (
    <SettingsGroup title={t("Diagnostics", "诊断")}>
      {diagnostics.map((diagnostic, index) => (
        <div
          className={`activity-item activity-item--${diagnostic.type === "error" ? "error" : "info"}`}
          key={`${diagnostic.message}:${index}`}
        >
          <div className="activity-item__text">{diagnostic.message}</div>
          {diagnostic.path ? <div className="activity-item__meta">{diagnostic.path}</div> : null}
        </div>
      ))}
    </SettingsGroup>
  );
}

function ExtensionCompatibilitySection({
  commands,
  compatibilityRecords,
}: {
  readonly commands: readonly string[];
  readonly compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[];
}) {
  useLocale();
  const supported = compatibilityRecords.filter((record) => record.status === "supported");
  const terminalOnly = compatibilityRecords.filter((record) => record.status === "terminal-only");
  const unknown = commands.filter((commandName) =>
    compatibilityRecords.every(
      (record) =>
        record.commandName !== commandName && !record.commandName.startsWith(`${commandName}:`),
    ),
  );

  return (
    <SettingsGroup
      title={t("Command", "命令")}
      description={t(
        "Whether each command works in the app is learned the first time it runs here.",
        "每个命令是否可在应用内使用，会在它首次在此运行后获知。",
      )}
    >
      <div className="resource-detail__tokens">
        {supported.map((record) => (
          <code className="resource-detail__token" key={`supported:${record.commandName}`}>
            {t(`${record.commandName} · GUI compatible`, `${record.commandName} · 兼容 GUI`)}
          </code>
        ))}
        {terminalOnly.map((record) => (
          <code
            className="resource-detail__token resource-detail__token--warning"
            key={`terminal:${record.commandName}`}
          >
            {t(`${record.commandName} · Terminal only`, `${record.commandName} · 仅限终端`)}
          </code>
        ))}
        {unknown.map((commandName) => (
          <code className="resource-detail__token" key={`unknown:${commandName}`}>
            {t(`${commandName} · Unknown`, `${commandName} · 未知`)}
          </code>
        ))}
      </div>
    </SettingsGroup>
  );
}
