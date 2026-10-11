/**
 * memloop memory extension entry for RSI-Agent-PI.
 *
 * Hooks the agent lifecycle to the memloop Python sidecar: L0 memory
 * injection at task start, L2 hard blocks and L1 reminders on tool calls,
 * event capture on user input and tool failures, and episode verdicts at
 * settle time.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEventResult,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createClaimRegistry,
  MemloopSidecar,
  type ClaimRegistry,
  type ConflictEntry,
  type GuardResult,
  type RetrievedClaim,
  type SignalKind,
} from "./sidecar.ts";
import { registerMemloopCommands } from "./commands.ts";
import { registerMemloopTools } from "./tools.ts";
import { t } from "./t.ts";

// L0 display budget: per-card and total caps keep the prompt section bounded.
// Storage never truncates; full text stays reachable via memory_search.
const CARD_DISPLAY_MAX_CHARS = 600;
const BLOCK_BUDGET_CHARS = 1800;
const MEMORY_SECTION = "memory";
const MEMLOOP_HINT_TYPE = "memloop-hint";

// Must stay in lockstep with loops.py USAGE_RULES (same block, same teaching).
// Not migrated to t() on purpose: this block is injected into the model prompt
// and the Python sidecar (python/memloop/loops.py) is not localized this round.
const USAGE_RULES = [
  "长期记忆卡。每条带置信度（0 至 1）与验证方式。",
  "使用规则：置信度低于 0.70 时先执行 verify 命令确认。hearsay 条目仅作线索。",
  "与当前任务无关的条目请忽略。需要更多记忆时调用 memory_search。",
];

// Only deterministic strong-instruction words turn a plain instruction into a
// card. Semantic judgment stays out of capture; the sidecar owns claim quality.
const STRONG_INSTRUCTION_PATTERN = /记住|以后|必须|always|never/i;

interface PendingFailure {
  command: string;
  eventId: string | number;
}

function normalizeKey(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function firstCommandToken(command: string): string {
  const firstLine = command.split("\n")[0] ?? "";
  return normalizeKey(firstLine.trim().split(/\s+/)[0] ?? firstLine);
}

function makeCallKey(toolName: string, input: unknown): string {
  const rec = inputToRecord(input);
  const anchor =
    typeof rec.command === "string"
      ? rec.command
      : typeof rec.path === "string"
        ? rec.path
        : JSON.stringify(input ?? {});
  return `${toolName}:${anchor}`;
}

function inputToRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function truncateForDisplay(text: string): string {
  if (text.length <= CARD_DISPLAY_MAX_CHARS) return text;
  return `${text.slice(0, CARD_DISPLAY_MAX_CHARS)}…（全文见 memory_search）`;
}

// Card line mirrors loops.py _card_line exactly: no verify path means the card
// is hearsay, and the CONFLICTED flag trails the bracket. Not migrated to t():
// the format must stay byte-compatible with the Python sidecar's card line.
function formatClaimLine(claim: RetrievedClaim, conflicted: boolean): string {
  const confidence = claim.confidence !== undefined ? claim.confidence.toFixed(2) : "??";
  const verifyCmd = claim.verify_cmd;
  const hasVerify = verifyCmd !== undefined && verifyCmd !== null && verifyCmd !== "";
  const tag = hasVerify ? `verify: ${verifyCmd}` : "HEARSAY";
  const flag = conflicted ? " CONFLICTED" : "";
  return `- (${claim.key}) ${truncateForDisplay(claim.text)} [${confidence} ${tag}]${flag}`;
}

function renderMemoryBlock(picked: RetrievedClaim[], conflicts: ConflictEntry[]): string {
  const conflictKeys = new Set<string>();
  const conflictIds = new Set<string>();
  for (const entry of conflicts) {
    conflictKeys.add(entry.key);
    for (const id of entry.claim_ids ?? []) conflictIds.add(String(id));
  }
  const lines: string[] = [...USAGE_RULES];
  let used = lines.join("\n").length;
  for (const claim of picked) {
    // Both sides of a conflicted key stay visible, each flagged: the model
    // resolves the conflict, the renderer only makes it undeniable.
    const conflicted =
      conflictKeys.has(claim.key) || (claim.id !== undefined && conflictIds.has(String(claim.id)));
    const line = formatClaimLine(claim, conflicted);
    if (used + line.length + 1 > BLOCK_BUDGET_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return `<memloop>\n${lines.join("\n")}\n</memloop>`;
}

/** Pi's global settings file (`~/.pi/agent/settings.json`), matching the app's resolution. */
function agentSettingsPath(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  const agentDir = override
    ? override.startsWith("~")
      ? path.join(homedir(), override.slice(1))
      : override
    : path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "settings.json");
}

function readVerdictCmdFrom(settingsPath: string): string | undefined {
  // A missing settings file is the normal case, so parse failures stay silent.
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const root = JSON.parse(raw) as unknown;
    const rootRec =
      root !== null && typeof root === "object" ? (root as Record<string, unknown>) : {};
    const section = rootRec.memloop;
    const sectionRec =
      section !== null && typeof section === "object" ? (section as Record<string, unknown>) : {};
    const verdictCmd = sectionRec.verdictCmd;
    if (typeof verdictCmd === "string" && verdictCmd.trim() !== "") return verdictCmd.trim();
  } catch {
    // absent or invalid settings file: fall through to the next source
  }
  return undefined;
}

export default function memloop(pi: ExtensionAPI) {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const registry: ClaimRegistry = createClaimRegistry();
  let client: MemloopSidecar | undefined;
  let sessionKey = "session";
  let projectRoot = "";
  let degradedNotified = false;
  let lastDiagnostic = "";
  let taskPickedCount = 0;
  let hintShownThisTask = false;
  const guardCache = new Map<string, GuardResult>();
  let pendingFailures: PendingFailure[] = [];

  // Priority: MEMLOOP_VERDICT_CMD env > ~/.pi/agent/settings.json memloop.verdictCmd
  // (the Settings → 记忆 control writes this file) > <cwd>/.pi/settings.json > none.
  const resolveVerdictCmd = (): string | undefined => {
    const fromEnv = process.env.MEMLOOP_VERDICT_CMD;
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
    return (
      readVerdictCmdFrom(agentSettingsPath()) ??
      readVerdictCmdFrom(path.join(projectRoot, ".pi", "settings.json"))
    );
  };

  const ensureClient = async (ctx: ExtensionContext): Promise<MemloopSidecar | undefined> => {
    if (client !== undefined && (await client.ensureReady())) return client;
    sessionKey = ctx.sessionManager.getSessionId();
    projectRoot = ctx.cwd;
    if (client === undefined) {
      client = new MemloopSidecar({
        projectRoot: ctx.cwd,
        sessionKey,
        extensionDir,
        verdictCmd: resolveVerdictCmd(),
        onDiagnostic: (line) => {
          lastDiagnostic = line;
        },
      });
    }
    const ready = await client.ensureReady();
    if (!ready) {
      // Degraded mode must never break the agent: no memory, one notice.
      if (!degradedNotified) {
        degradedNotified = true;
        const detail = lastDiagnostic !== "" ? t(`: ${lastDiagnostic}`, `：${lastDiagnostic}`) : "";
        ctx.ui.notify(
          t(
            `memloop memory unavailable (missing Python 3.11+ or sidecar start failure); running without memory${detail}`,
            `memloop 记忆不可用（缺少 Python 3.11+ 或 sidecar 启动失败），以无记忆模式运行${detail}`,
          ),
          "warning",
        );
      }
      return undefined;
    }
    degradedNotified = false;
    return client;
  };

  // The hint is a custom entry: turn_end can append entries without
  // continuing the run, and entries stay out of the model context.
  pi.registerEntryRenderer<{ count: number }>(MEMLOOP_HINT_TYPE, (entry, _options, theme) => {
    const count = entry.data?.count ?? 0;
    return new Text(
      theme.fg("dim", t(`used ${count} memories this turn`, `本次引用了 ${count} 条记忆`)),
    );
  });

  // Session start is the sleep-between-sessions maintenance point: cleanup
  // and skill promotion first (fast), then one gated dream pass.
  pi.on("session_start", async (_event, ctx) => {
    const active = await ensureClient(ctx);
    if (active === undefined) return;
    try {
      await active.consolidate();
      await active.runDream({});
    } catch (err) {
      ctx.ui.notify(
        t(`memloop maintenance failed: ${String(err)}`, `memloop 维护失败：${String(err)}`),
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const active = await ensureClient(ctx);
    if (active === undefined) return;
    taskPickedCount = 0;
    hintShownThisTask = false;
    // Failure pairing is task-scoped: a fix demonstrated in another task
    // says nothing about this task's failures.
    pendingFailures = [];
    try {
      await active.beginTask({ prompt: event.prompt, session: sessionKey });
      const result = await active.retrieve({ context: event.prompt });
      const picked = result.picked;
      if (picked.length > 0) {
        taskPickedCount = picked.length;
        for (const claim of picked) registry.record(claim);
        event.systemPromptOptions.sections[MEMORY_SECTION] = renderMemoryBlock(
          picked,
          result.conflicts ?? [],
        );
      } else {
        delete event.systemPromptOptions.sections[MEMORY_SECTION];
      }
    } catch (err) {
      // Memory must never block the turn; run without injection on failure.
      ctx.ui.notify(
        t(`memloop injection failed: ${String(err)}`, `memloop 注入失败：${String(err)}`),
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const active = await ensureClient(ctx);
    if (active === undefined) return;
    const callKey = makeCallKey(event.toolName, event.input);
    try {
      const guard = await active.guard({
        tool_name: event.toolName,
        args: inputToRecord(event.input),
        call_key: callKey,
      });
      guardCache.set(event.toolCallId, guard);
      registry.recordGuardHit(guard);
      if (guard.level === "l2" && guard.blocked === true) {
        return {
          block: true,
          reason:
            guard.message ??
            t(
              "[memloop hard block] matched a verified failure pattern.",
              "[memloop 硬拦截] 命中已验证的失败模式。",
            ),
        };
      }
    } catch (err) {
      // A tool_call handler failure blocks the tool as fail-safe; guard
      // errors must not, so allow the call to proceed.
      ctx.ui.notify(
        t(`memloop guard failed: ${String(err)}`, `memloop guard 失败：${String(err)}`),
        "warning",
      );
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const active = await ensureClient(ctx);
    if (active === undefined) return;
    const callKey = makeCallKey(event.toolName, event.input);
    let guard = guardCache.get(event.toolCallId);
    guardCache.delete(event.toolCallId);
    if (guard === undefined) {
      try {
        guard = await active.guard({
          tool_name: event.toolName,
          args: event.input,
          call_key: callKey,
        });
      } catch {
        guard = undefined;
      }
    }

    let result: ToolResultEventResult | undefined;

    // L1 reminder: prepend to model-visible content, the earliest point the
    // model sees a warning (tool_call has no insert-before channel).
    if (
      guard !== undefined &&
      guard.level === "l1" &&
      guard.message !== undefined &&
      guard.message !== ""
    ) {
      const content = [...event.content];
      const first = content[0];
      if (first !== undefined && first.type === "text") {
        content[0] = { type: "text", text: `${guard.message}\n${first.text}` };
      } else {
        content.unshift({ type: "text", text: guard.message });
      }
      result = { content };
      // Replacing content alone drops structuredContent; carry it over.
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
    }

    if (event.toolName === "bash" || event.toolName === "powershell") {
      const command = event.input.command;
      if (typeof command === "string") {
        if (event.isError) {
          const firstLine = command.split("\n")[0] ?? command;
          try {
            // A failed command must never become a verify target:
            // memory_verify re-runs the verify command, so recording
            // the failure there would re-run a known-bad or
            // destructive command. The event only records evidence.
            const captured = await active.capture({
              kind: "failure_fix",
              payload: {
                text: t(`command failed: ${firstLine}`, `命令失败：${firstLine}`),
                failed_cmd: command,
              },
              origin_key: `pi:${sessionKey}:fail-${Date.now()}-${createHash("sha1").update(command).digest("hex").slice(0, 8)}`,
            });
            pendingFailures.push({ command, eventId: captured.event_id });
          } catch (err) {
            ctx.ui.notify(
              t(`memloop capture failed: ${String(err)}`, `memloop 捕获失败：${String(err)}`),
              "warning",
            );
          }
        } else {
          // Pair the closest preceding different failure with this
          // success: one success demonstrates one fix (LIFO). The
          // card's verify path is the success, its match pattern the
          // failure. Unpaired failures stay events, never cards.
          for (let i = pendingFailures.length - 1; i >= 0; i--) {
            const failure = pendingFailures[i];
            if (failure === undefined || failure.command === command) continue;
            pendingFailures.splice(i, 1);
            try {
              await active.cardify({
                event_id: failure.eventId,
                key: firstCommandToken(failure.command),
                text: t(
                  `${failure.command} failed; succeeded after switching to ${command}`,
                  `${failure.command} 失败，改用 ${command} 后成功`,
                ),
                claim_kind: "experience",
                verify_cmd: command,
                match_pattern: failure.command,
              });
            } catch (err) {
              ctx.ui.notify(
                t(`memloop cardify failed: ${String(err)}`, `memloop 成卡失败：${String(err)}`),
                "warning",
              );
            }
            break;
          }
        }
      }
    }

    return result;
  });

  pi.on("input", async (event, ctx) => {
    const active = await ensureClient(ctx);
    if (active === undefined) return;
    const text = event.text;
    // InputEvent carries no entry id, so the origin key uses timestamp+hash.
    const originKey = `pi:${sessionKey}:${Date.now()}-${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
    let signal: SignalKind = "none";
    try {
      ({ signal } = await active.classifySignal({ text }));
    } catch (err) {
      ctx.ui.notify(
        t(
          `memloop signal classification failed: ${String(err)}`,
          `memloop 信号识别失败：${String(err)}`,
        ),
        "warning",
      );
      return;
    }
    const kind = signal === "correction" ? "user_correction" : "explicit_instruction";
    let eventId: string | number | undefined;
    try {
      const captured = await active.capture({ kind, payload: { text }, origin_key: originKey });
      eventId = captured.event_id;
    } catch (err) {
      ctx.ui.notify(
        t(`memloop capture failed: ${String(err)}`, `memloop 捕获失败：${String(err)}`),
        "warning",
      );
    }
    // T2 signals are world-verdict input and must not be lost when capture
    // fails, so they run in their own guard. They fire at input time, before
    // the next begin_task, and therefore land on the previous episode.
    if (signal === "correction" || signal === "affirmation") {
      try {
        await active.episodeSignal({ signal });
      } catch (err) {
        ctx.ui.notify(
          t(
            `memloop verdict signal failed: ${String(err)}`,
            `memloop 判决信号失败：${String(err)}`,
          ),
          "warning",
        );
      }
    }
    if (
      eventId !== undefined &&
      (signal === "correction" || STRONG_INSTRUCTION_PATTERN.test(text))
    ) {
      try {
        await active.cardify({ event_id: eventId, key: normalizeKey(text.slice(0, 24)) });
      } catch (err) {
        ctx.ui.notify(
          t(`memloop cardify failed: ${String(err)}`, `memloop 成卡失败：${String(err)}`),
          "warning",
        );
      }
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const active = await ensureClient(ctx);
    if (active === undefined) return;
    try {
      // The sidecar records the verdict trace itself; only trigger it here.
      await active.closeEpisode({ verdict_cmd: resolveVerdictCmd() });
    } catch (err) {
      ctx.ui.notify(
        t(`memloop verdict failed: ${String(err)}`, `memloop 判决失败：${String(err)}`),
        "warning",
      );
    }
  });

  pi.on("turn_end", (): TurnEndEventResult | undefined => {
    if (taskPickedCount > 0 && !hintShownThisTask) {
      hintShownThisTask = true;
      return {
        entries: [
          { type: "custom", customType: MEMLOOP_HINT_TYPE, data: { count: taskPickedCount } },
        ],
      };
    }
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    const active = client;
    if (active === undefined) return;
    try {
      await active.consolidate();
    } catch {
      // best-effort cleanup at shutdown
    }
    try {
      // Idempotent: reload, session replacement, and quit can converge here.
      await active.shutdown();
    } catch {
      // shutdown must never throw into the runtime
    }
  });

  registerMemloopTools(pi, ensureClient);
  registerMemloopCommands(pi, ensureClient, registry);
}
