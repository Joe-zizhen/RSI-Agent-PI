import type { SessionConfig } from "@rsi-agent-pi/session-driver";
import type {
  RuntimeCommandRecord,
  RuntimeSnapshot,
} from "@rsi-agent-pi/session-driver/runtime-types";
import { t } from "./t";

export type ParsedComposerCommand =
  | { type: "model"; provider: string; modelId: string }
  | { type: "thinking"; thinkingLevel: string }
  | { type: "tree" }
  | { type: "status" }
  | { type: "session" }
  | { type: "reload" }
  | { type: "compact"; customInstructions?: string }
  | { type: "name"; title: string };

const INCOMPLETE_COMMAND_MESSAGES: Readonly<Record<string, readonly [string, string]>> = {
  "/compact": [
    "Add optional instructions after /compact or send it directly from the slash menu.",
    "在 /compact 后补充可选指令，或直接从斜杠菜单发送。",
  ],
  "/login": [
    "Choose a provider from the slash menu before sending /login.",
    "发送 /login 前，请先从斜杠菜单选择提供商。",
  ],
  "/logout": [
    "Choose a connected provider from the slash menu before sending /logout.",
    "发送 /logout 前，请先从斜杠菜单选择一个已连接的提供商。",
  ],
  "/model": [
    "Choose a provider and model from the slash menu before sending /model.",
    "发送 /model 前，请先从斜杠菜单选择提供商和模型。",
  ],
  "/name": ["Add a thread title after /name.", "请在 /name 后添加会话标题。"],
  "/scoped-models": [
    "Open Enabled models from the slash menu or Settings.",
    "请从斜杠菜单或设置打开“已启用模型”。",
  ],
  "/settings": ["Open Settings from the slash menu or Cmd+,.", "请从斜杠菜单或按 Cmd+, 打开设置。"],
  "/thinking": [
    "Choose a reasoning level from the slash menu before sending /thinking.",
    "发送 /thinking 前，请先从斜杠菜单选择思考力度。",
  ],
} as const;

export function resolveRuntimeCommands(
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): readonly RuntimeCommandRecord[] {
  if (!runtime) {
    return sessionCommands;
  }

  const baseCommands = runtime.settings.enableSkillCommands
    ? sessionCommands
    : sessionCommands.filter((command) => command.source !== "skill");
  if (!runtime.settings.enableSkillCommands) {
    return baseCommands;
  }

  const merged = [...baseCommands];
  const seenNames = new Set(baseCommands.map((command) => command.name));
  for (const skill of runtime.skills) {
    if (!skill.enabled) {
      continue;
    }

    const commandName = normalizeRuntimeCommandName(skill.slashCommand);
    if (seenNames.has(commandName)) {
      continue;
    }

    seenNames.add(commandName);
    merged.push({
      name: commandName,
      description: skill.description,
      source: "skill",
      sourceInfo: {
        path: skill.filePath,
        source: skill.source,
        scope: skill.filePath.startsWith(runtime.workspace.path) ? "project" : "user",
        origin: "top-level",
        baseDir: skill.baseDir,
      },
    });
  }

  return merged;
}

export function hasRuntimeSlashCommand(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): boolean {
  return Boolean(resolveRuntimeSlashCommand(text, runtime, sessionCommands));
}

export function resolveRuntimeSlashCommand(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
): RuntimeCommandRecord | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = normalizeRuntimeCommandName(
    spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex),
  );
  return resolveRuntimeCommands(runtime, sessionCommands).find(
    (command) => command.name === commandName,
  );
}

/**
 * Whether submitting this text can change the sender window's selection, so it must run
 * in that window's serialized action queue. Local composer commands and extension
 * commands can (an extension may create or select a session). Skills, prompt templates
 * and plain text starting with "/" are ordinary prompts that await the whole turn, so
 * they must not hold the queue. Until the session's commands are known, any "/" text may
 * be an extension command, so it stays serialized.
 */
export function composerSubmitNeedsSenderView(
  text: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[] | undefined,
): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  if (!sessionCommands) {
    return true;
  }
  const runtimeCommand = resolveRuntimeSlashCommand(trimmed, runtime, sessionCommands);
  if (runtimeCommand) {
    return runtimeCommand.source === "extension";
  }
  return (
    parseComposerCommand(trimmed) !== undefined ||
    incompleteComposerCommandMessage(trimmed) !== undefined
  );
}

function normalizeRuntimeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function formatSessionConfigStatus(config?: SessionConfig): string {
  const parts = [
    config?.provider && config?.modelId ? `Model ${config.provider}:${config.modelId}` : undefined,
    config?.thinkingLevel ? `Thinking ${config.thinkingLevel}` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "No session overrides set";
}

export function parseComposerCommand(value: string): ParsedComposerCommand | undefined {
  const trimmed = value.trim();
  if (trimmed === "/tree") {
    return { type: "tree" };
  }
  if (trimmed === "/status") {
    return { type: "status" };
  }
  if (trimmed === "/session") {
    return { type: "session" };
  }
  if (trimmed === "/reload") {
    return { type: "reload" };
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command === "/compact") {
    return { type: "compact", customInstructions: rest.join(" ").trim() || undefined };
  }
  if (command === "/name") {
    const title = rest.join(" ").trim();
    return title ? { type: "name", title } : undefined;
  }
  if (command === "/thinking") {
    const thinkingLevel = rest[0]?.trim();
    if (!thinkingLevel) {
      return undefined;
    }
    return { type: "thinking", thinkingLevel };
  }

  if (command === "/model") {
    if (rest.length >= 2) {
      return {
        type: "model",
        provider: rest[0] ?? "",
        modelId: rest.slice(1).join(" "),
      };
    }

    const combined = rest[0];
    if (combined?.includes(":")) {
      const [provider, ...modelParts] = combined.split(":");
      const modelId = modelParts.join(":");
      if (provider && modelId) {
        return { type: "model", provider, modelId };
      }
    }
  }

  return undefined;
}

export function incompleteComposerCommandMessage(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command] = trimmed.split(/\s+/);
  const entry = INCOMPLETE_COMMAND_MESSAGES[command as keyof typeof INCOMPLETE_COMMAND_MESSAGES];
  return entry ? t(entry[0], entry[1]) : undefined;
}
