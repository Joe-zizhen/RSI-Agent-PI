import { resolveRuntimeCommands } from "../../../contracts/composer-commands";
import type {
  RuntimeCommandRecord,
  RuntimeProviderRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@rsi-agent-pi/session-driver/runtime-types";
import type { ExtensionCommandCompatibilityRecord } from "../../../contracts/desktop-state";
import { titleCase } from "../../lib/string-utils";
import { t } from "../../t";

export type ComposerSlashCommandKind =
  | "runtime"
  | "model"
  | "thinking"
  | "tree"
  | "status"
  | "session"
  | "reload"
  | "compact"
  | "name"
  | "login"
  | "logout"
  | "settings"
  | "scoped-models";

export interface ComposerSlashCommand {
  readonly id: string;
  readonly kind: ComposerSlashCommandKind;
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
  readonly submitMode?: "immediate" | "prefill" | "pick-option";
  readonly section: "runtime" | "host";
  readonly runtimeCommand?: RuntimeCommandRecord;
  readonly sourceLabel?: string;
  readonly compatibility?: ExtensionCommandCompatibilityRecord;
}

export interface ComposerSlashCommandSection {
  readonly id: "runtime" | "host";
  readonly title?: string;
  readonly items: readonly ComposerSlashCommand[];
}

export interface ComposerSlashOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export interface ComposerSlashOptionEmptyState {
  readonly title: string;
  readonly description: string;
}

export interface ComposerModelOption extends ComposerSlashOption {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ComposerProviderOption extends ComposerSlashOption {
  readonly providerId: string;
}

export function modelOptionsEmptyTitle(): string {
  return t("No models available", "无可用模型");
}
export function modelOptionsEmptyDescription(): string {
  return t(
    "Open settings to enable models or sign in to a provider.",
    "打开设置以启用模型或登录提供商。",
  );
}

const HOST_ACTION_SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  {
    id: "host:model",
    kind: "model",
    command: "/model",
    template: "/model",
    get title() {
      return t("Model", "模型");
    },
    get description() {
      return t("Choose the model for this session", "选择本会话记录使用的模型");
    },
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:thinking",
    kind: "thinking",
    command: "/thinking",
    template: "/thinking",
    get title() {
      return t("Reasoning", "推理");
    },
    get description() {
      return t("Set thinking level for this session", "设置本会话记录的思考力度");
    },
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:tree",
    kind: "tree",
    command: "/tree",
    template: "/tree",
    get title() {
      return t("Tree", "树");
    },
    get description() {
      return t("Browse and jump between branches in this session", "浏览本会话记录的分支并跳转");
    },
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:status",
    kind: "status",
    command: "/status",
    template: "/status",
    get title() {
      return t("Status", "状态");
    },
    get description() {
      return t(
        "Show current session overrides in the timeline",
        "在时间线中显示当前会话记录的覆盖设置",
      );
    },
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:login",
    kind: "login",
    command: "/login",
    template: "/login",
    get title() {
      return t("Login", "登录");
    },
    get description() {
      return t("Authenticate a provider for this workspace", "为本项目登录提供商");
    },
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:logout",
    kind: "logout",
    command: "/logout",
    template: "/logout",
    get title() {
      return t("Logout", "退出登录");
    },
    get description() {
      return t("Remove a provider login from this workspace", "移除本项目的提供商登录");
    },
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:settings",
    kind: "settings",
    command: "/settings",
    template: "/settings",
    get title() {
      return t("Settings", "设置");
    },
    get description() {
      return t("Open model, skill, and notification settings", "打开模型、技能与通知设置");
    },
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:scoped-models",
    kind: "scoped-models",
    command: "/scoped-models",
    template: "/scoped-models",
    get title() {
      return t("Enabled models", "启用的模型");
    },
    get description() {
      return t("Choose which models appear in pickers", "选择选择器中显示的模型");
    },
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:session",
    kind: "session",
    command: "/session",
    template: "/session",
    get title() {
      return t("Session", "会话记录");
    },
    get description() {
      return t("Show current session details in the timeline", "在时间线中显示当前会话记录详情");
    },
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:name",
    kind: "name",
    command: "/name",
    get template() {
      return t("/name New thread title", "/name 新会话标题");
    },
    get title() {
      return t("Rename", "重命名");
    },
    get description() {
      return t("Rename the current session", "重命名当前会话记录");
    },
    submitMode: "prefill",
    section: "host",
  },
  {
    id: "host:compact",
    kind: "compact",
    command: "/compact",
    template: "/compact",
    get title() {
      return t("Compaction", "上下文压缩");
    },
    get description() {
      return t("Compact session context now", "立即对会话记录进行上下文压缩");
    },
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:reload",
    kind: "reload",
    command: "/reload",
    template: "/reload",
    get title() {
      return t("Reload", "重新加载");
    },
    get description() {
      return t(
        "Reload prompts, skills, and session resources",
        "重新加载提示词、技能与会话记录资源",
      );
    },
    submitMode: "immediate",
    section: "host",
  },
] as const;

export const THINKING_OPTIONS: readonly ComposerSlashOption[] = [
  {
    value: "low",
    label: "Low",
    get description() {
      return t("Faster responses, lighter reasoning", "响应更快，推理更轻量");
    },
  },
  {
    value: "medium",
    label: "Medium",
    get description() {
      return t(
        "Good for everyday tasks, balancing speed and reasoning depth",
        "适合日常任务，兼顾速度与推理深度",
      );
    },
  },
  {
    value: "high",
    label: "High",
    get description() {
      return t("For complex problems, deeper reasoning", "适合复杂问题，推理更深");
    },
  },
  {
    value: "xhigh",
    label: "Extra High",
    get description() {
      return t("For complex problems, very deep reasoning", "适合复杂问题，推理非常深");
    },
  },
  {
    value: "max",
    label: "Max",
    get description() {
      return t("The deepest reasoning the model supports", "支持的模型可用的最大推理深度");
    },
  },
] as const;

export function buildSlashCommandSections(
  query: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
  compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[] = [],
  options: {
    readonly allowTreeCommand?: boolean;
  } = {},
): readonly ComposerSlashCommandSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  const availableRuntimeCommands = resolveRuntimeCommands(runtime, sessionCommands);
  const compatibilityByKey = new Map(
    compatibilityRecords.map(
      (record) => [`${record.extensionPath}::${record.commandName}`, record] as const,
    ),
  );
  const runtimeMatches = availableRuntimeCommands
    .map<ComposerSlashCommand>((command) => ({
      id: `runtime:${command.source}:${command.name}`,
      kind: "runtime",
      command: `/${command.name}`,
      template: `/${command.name} `,
      title: formatRuntimeCommandTitle(command),
      description: formatRuntimeCommandDescription(command),
      submitMode: "prefill",
      section: "runtime",
      runtimeCommand: command,
      sourceLabel: formatRuntimeSourceLabel(command),
      compatibility: compatibilityByKey.get(`${command.sourceInfo.path}::${command.name}`),
    }))
    .filter((command) => matchesCommand(command, normalizedQuery));
  const allowTreeCommand = options.allowTreeCommand ?? true;
  const hostMatches = HOST_ACTION_SLASH_COMMANDS.filter(
    (command) =>
      (allowTreeCommand || command.kind !== "tree") && matchesCommand(command, normalizedQuery),
  );

  // Prefer a host action when it is a prefix match and runtime skills only
  // match fuzzily. Otherwise an installed skill such as `observe-state` can
  // steal `/stat` from the built-in `/status` command on Tab.
  const hostHasPrefixMatch = hostMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeHasPrefixMatch = runtimeMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeSection: ComposerSlashCommandSection = {
    id: "runtime",
    title: runtimeMatches.length > 0 ? t("Runtime Commands", "运行时命令") : undefined,
    items: runtimeMatches,
  };
  const hostSection: ComposerSlashCommandSection = {
    id: "host",
    title: hostMatches.length > 0 ? t("Host Actions", "宿主操作") : undefined,
    items: hostMatches,
  };
  const sections: ComposerSlashCommandSection[] =
    hostHasPrefixMatch && !runtimeHasPrefixMatch
      ? [hostSection, runtimeSection]
      : [runtimeSection, hostSection];

  return sections.filter((section) => section.items.length > 0);
}

export function flattenSlashSections(
  sections: readonly ComposerSlashCommandSection[],
): readonly ComposerSlashCommand[] {
  return sections.flatMap((section) => section.items);
}

export function buildProviderOptions(
  providers: readonly RuntimeProviderRecord[],
  filter: (provider: RuntimeProviderRecord) => boolean = () => true,
): readonly ComposerProviderOption[] {
  return providers
    .filter(filter)
    .sort(compareProviders)
    .map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: describeProvider(provider),
      providerId: provider.id,
    }));
}

export function buildModelOptions(
  runtime: RuntimeSnapshot | undefined,
): readonly ComposerModelOption[] {
  if (!runtime) {
    return [];
  }

  const enabledPatterns = runtime.settings.enabledModelPatterns;
  const allAvailable = enabledPatterns.length === 0;
  const enabledSet = allAvailable ? undefined : new Set(enabledPatterns);

  return [...runtime.models]
    .filter((model) => {
      if (!model.available) return false;
      if (!enabledSet) return true;
      return enabledSet.has(`${model.providerId}/${model.modelId}`);
    })
    .sort((left: RuntimeSnapshot["models"][number], right: RuntimeSnapshot["models"][number]) => {
      const providerCompare =
        providerRankForId(runtime.providers, left.providerId) -
        providerRankForId(runtime.providers, right.providerId);
      if (providerCompare !== 0) {
        return providerCompare;
      }
      return `${left.providerName} ${left.label}`.localeCompare(
        `${right.providerName} ${right.label}`,
      );
    })
    .map((model: RuntimeSnapshot["models"][number]) => ({
      value: model.modelId,
      label: `${model.providerName} · ${model.label}`,
      description: model.modelId,
      providerId: model.providerId,
      modelId: model.modelId,
    }));
}

export function slashOptionsForCommand(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
): readonly ComposerSlashOption[] {
  if (!command) {
    return [];
  }

  if (command.kind === "thinking") {
    return THINKING_OPTIONS;
  }
  if (command.kind === "model") {
    return buildModelOptions(runtime);
  }
  if (command.kind === "login") {
    return buildProviderOptions(runtime?.providers ?? [], (provider) => provider.oauthSupported);
  }
  if (command.kind === "logout") {
    return buildProviderOptions(
      runtime?.providers ?? [],
      (provider) => provider.authSource === "oauth" || provider.authSource === "auth_file",
    );
  }

  return [];
}

export function slashOptionEmptyState(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
): ComposerSlashOptionEmptyState | undefined {
  if (!command) {
    return undefined;
  }

  if (command.kind === "model" && buildModelOptions(runtime).length === 0) {
    return {
      title: modelOptionsEmptyTitle(),
      description: modelOptionsEmptyDescription(),
    };
  }

  return undefined;
}

function matchesCommand(command: ComposerSlashCommand, normalizedQuery: string): boolean {
  if (!normalizedQuery.startsWith("/")) {
    return false;
  }

  if (normalizedQuery === "/") {
    return true;
  }

  const queryWithoutSlash = normalizedQuery.replace(/^\/+/, "").trim();
  const rawSearchTerms = [command.command.toLowerCase()];
  const aliasSearchTerms = buildSlashSearchAliases(command);
  if (rawSearchTerms.some((value) => value.includes(normalizedQuery))) {
    return true;
  }

  if (!queryWithoutSlash) {
    return false;
  }

  return aliasSearchTerms.some((value) => value.includes(queryWithoutSlash));
}

function buildSlashSearchAliases(command: ComposerSlashCommand): readonly string[] {
  const aliases = new Set<string>([
    command.command.replace(/^\/+/, "").toLowerCase(),
    command.title.toLowerCase(),
    command.sourceLabel?.toLowerCase() ?? "",
    command.compatibility?.status === "terminal-only" ? "terminal-only" : "",
  ]);

  if (command.runtimeCommand) {
    aliases.add(command.runtimeCommand.name.toLowerCase());
    aliases.add(command.runtimeCommand.name.replace(/^skill:/, "").toLowerCase());
  }

  return [...aliases].filter(Boolean);
}

function describeProvider(provider: RuntimeProviderRecord): string {
  if (provider.authSource === "oauth") {
    return t("OAuth connected", "OAuth 已连接");
  }
  if (provider.authSource === "auth_file") {
    return t("Saved API key", "已保存 API key");
  }
  if (provider.authSource === "env") {
    return t("Configured via environment", "通过环境变量配置");
  }
  if (provider.authSource === "external") {
    return t("Configured externally", "在外部配置");
  }
  if (provider.oauthSupported) {
    return t("OAuth available", "可使用 OAuth");
  }
  if (provider.apiKeySetupSupported) {
    return t("Needs API key", "需要 API key");
  }
  return t("Available", "可用");
}

function compareProviders(left: RuntimeProviderRecord, right: RuntimeProviderRecord): number {
  const leftRank = providerRank(left);
  const rightRank = providerRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}

function providerRank(provider: RuntimeProviderRecord): number {
  if (provider.hasAuth) {
    return 0;
  }
  if (provider.id === "openai" || provider.id === "openai-codex" || provider.id === "anthropic") {
    return 1;
  }
  if (provider.oauthSupported) {
    return 2;
  }
  return 3;
}

function providerRankForId(
  providers: readonly RuntimeProviderRecord[],
  providerId: string,
): number {
  const provider = providers.find((entry) => entry.id === providerId);
  return provider ? providerRank(provider) : 99;
}

function summarizeSkillDescription(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return t("Reusable workflow", "可复用的工作流");
  }

  const firstSentence = trimmed.match(/^[^.!?]+[.!?]?/)?.[0]?.trim() ?? trimmed;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93).trimEnd()}...` : firstSentence;
}

function formatRuntimeCommandTitle(command: RuntimeCommandRecord): string {
  if (command.source === "skill" && command.name.startsWith("skill:")) {
    return titleCase(command.name.slice("skill:".length));
  }
  return titleCase(command.name.replace(/[:_-]+/g, " "));
}

function formatRuntimeCommandDescription(command: RuntimeCommandRecord): string {
  if (command.description?.trim()) {
    return command.description.trim();
  }
  if (command.source === "prompt") {
    return t("Prompt template", "提示词模板");
  }
  if (command.source === "skill") {
    return t("Skill command", "技能命令");
  }
  return t("Extension command", "扩展命令");
}

function formatRuntimeSourceLabel(command: RuntimeCommandRecord): string {
  if (command.source === "skill") {
    return t("Skill", "技能");
  }
  if (command.source === "prompt") {
    return t("Prompt", "提示词");
  }
  return command.sourceInfo.source.replace(/^extension:/, "");
}

export function isExactSlashCommand(query: string, command: ComposerSlashCommand): boolean {
  return query.trim().toLowerCase() === command.command.toLowerCase();
}

export function parseTreeComposerCommand(
  value: string,
): { readonly type: "tree" } | { readonly type: "error"; readonly message: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command !== "/tree") {
    return undefined;
  }

  if (rest.length > 0) {
    return {
      type: "error",
      message: t("/tree does not take arguments.", "/tree 不接受参数。"),
    };
  }

  return { type: "tree" };
}
