/**
 * memloop model-facing tools: search, verify, override, and feedback on
 * memory claim cards. All four talk to the same sidecar the lifecycle hooks
 * use.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MemloopSidecar, RetrievedClaim } from "./sidecar.ts";
import type { QueryEmbedding } from "./memloop.ts";
import { t } from "./t.ts";

type EnsureClient = (ctx: ExtensionContext) => Promise<MemloopSidecar | undefined>;

/** Query embedder from memloop.ts (plan 3.5); undefined = lexical-only. */
export type EmbedQuery = (text: string) => Promise<QueryEmbedding | undefined>;

export function formatClaim(claim: RetrievedClaim): string {
  const confidence = claim.confidence !== undefined ? claim.confidence.toFixed(2) : "??";
  const verifyCmd = claim.verify_cmd;
  const verify =
    verifyCmd !== undefined && verifyCmd !== null && verifyCmd !== ""
      ? t(`verify: ${verifyCmd}`, `验证命令: ${verifyCmd}`)
      : t("no verify command", "无验证命令");
  const kind = claim.claim_kind !== undefined ? claim.claim_kind : "claim";
  const skill =
    claim.skill_path !== undefined && claim.skill_path !== null && claim.skill_path !== ""
      ? t(`\n  skill: ${claim.skill_path}`, `\n  契约: ${claim.skill_path}`)
      : "";
  return t(
    `- [${claim.key}] (${kind}, confidence ${confidence})\n  ${claim.text}\n  ${verify}${skill}`,
    `- [${claim.key}] (${kind}, 置信度 ${confidence})\n  ${claim.text}\n  ${verify}${skill}`,
  );
}

function formatClaims(claims: RetrievedClaim[]): string {
  if (claims.length === 0) return t("No matching Memory cards.", "没有匹配的记忆卡。");
  return claims.map(formatClaim).join("\n");
}

function unavailable(): { content: [{ type: "text"; text: string }]; details: undefined } {
  return {
    content: [
      {
        type: "text",
        text: t(
          "Memory system unavailable (sidecar not running).",
          "记忆系统不可用（sidecar 未运行）。",
        ),
      },
    ],
    details: undefined,
  };
}

function createSearchTool(ensureClient: EnsureClient, embedQuery?: EmbedQuery) {
  return defineTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search long-term memory claim cards recorded by memloop. " +
      "Use when prior project experience, past corrections, or verified practices may apply. " +
      "Each result carries a confidence score and a verify command. " +
      "Run memory_verify before relying on low-confidence cards.",
    promptSnippet: "Search memloop memory claim cards",
    parameters: Type.Object({
      query: Type.String({ description: "Search text, typically the task or tool context" }),
      k: Type.Optional(Type.Number({ description: "Maximum number of claims to return" })),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        return unavailable();
      }
      // Query embedding travels with the request (plan 3.5); absent or
      // failed embedding degrades to the lexical path silently.
      const emb = embedQuery !== undefined ? await embedQuery(params.query) : undefined;
      const result = await active.search({
        query: params.query,
        k: params.k,
        ctx_embedding: emb?.vector,
        ctx_model: emb?.model,
      });
      return { content: [{ type: "text", text: formatClaims(result.claims) }], details: undefined };
    },
  });
}

function createVerifyTool(ensureClient: EnsureClient) {
  return defineTool({
    name: "memory_verify",
    label: "Memory Verify",
    description:
      "Verify one memloop memory claim by running its verify command on the sidecar. " +
      "Returns ok when the claim still holds, falsified when the claim is stale. " +
      "A falsified claim is evicted and will not be injected again.",
    promptSnippet: "Verify a memloop memory claim",
    parameters: Type.Object({
      claim_id: Type.String({ description: "Claim id or key returned by memory_search" }),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        return unavailable();
      }
      const result = await active.verify({ claim_id: params.claim_id });
      const text = result.falsified
        ? t(
            `Memory card ${params.claim_id} was falsified. The card will be evicted and will not be injected again. Steps that cited it carry a re-check notice.`,
            `记忆卡 ${params.claim_id} 已证伪（falsified）。该卡将被清理，不再注入。引用过它的步骤会收到复核通告。`,
          )
        : result.ok
          ? t(
              `Memory card ${params.claim_id} verified (ok).`,
              `记忆卡 ${params.claim_id} 验证通过（ok）。`,
            )
          : result.status === "hearsay"
            ? t(
                `Memory card ${params.claim_id} has no verify command (hearsay).`,
                `记忆卡 ${params.claim_id} 无验证命令（HEARSAY）。`,
              )
            : t(
                `Memory card ${params.claim_id} did not verify; state unknown.`,
                `记忆卡 ${params.claim_id} 验证未通过，状态未知。`,
              );
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}

function createOverrideTool(ensureClient: EnsureClient) {
  return defineTool({
    name: "memory_override",
    label: "Memory Override",
    description:
      "Explicitly bypass a memloop L2 hard block for one claim. " +
      "Only call this after you have checked the situation and decided the block does not apply. " +
      "Records an override trace, allows the blocked call, and returns the full card text with its verify command.",
    promptSnippet: "Override a memloop hard block with a reason",
    parameters: Type.Object({
      claim_id: Type.String({ description: "Claim id named in the block reason" }),
      reason: Type.String({ description: "Why this call is an exception to the claim" }),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        return unavailable();
      }
      const result = await active.override({ claim_id: params.claim_id, reason: params.reason });
      const lines: string[] = [
        t(`Override recorded: ${params.claim_id}`, `已记录覆盖：${params.claim_id}`),
        t(`Reason: ${params.reason}`, `理由：${params.reason}`),
      ];
      if (result.claim !== undefined) {
        lines.push(t("Full card text:", "卡片全文："));
        lines.push(formatClaim(result.claim));
      } else {
        lines.push(
          t(
            "Full card text unavailable; use the original text in the block message.",
            "卡片全文不可用，请以拦截消息中的原文为准。",
          ),
        );
      }
      lines.push(
        t(
          "Verify hint: run the card's verify command to confirm it still holds, then retry the original call.",
          "验证提示：先运行卡片中的 verify 命令确认仍然有效，再重试原调用。",
        ),
      );
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  });
}

function createMemorySignalTool(ensureClient: EnsureClient, getLastUserInput: () => string) {
  return defineTool({
    name: "memory_signal",
    label: "Memory Signal",
    description:
      "Record explicit user feedback about the just-finished task into memloop's world verdict. " +
      "Use when the user corrects or affirms your work and no automatic feedback was recorded. " +
      "signal='correction' books a loss on the last closed task and stores the user's exact words as a new memory card that supersedes the same-key old card. " +
      "signal='affirmation' books a half-weight win and stores no card. " +
      "The user's exact last message is attached automatically as the card body. " +
      "reason is an audit note only and never enters the memory card. " +
      "Calling this twice for the same task and signal is a no-op.",
    promptSnippet: "Record user correction or affirmation feedback",
    parameters: Type.Object({
      signal: Type.String({ description: '"correction" or "affirmation"' }),
      reason: Type.Optional(
        Type.String({ description: "Why you read the message as feedback (audit note only)" }),
      ),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        return unavailable();
      }
      if (params.signal !== "correction" && params.signal !== "affirmation") {
        return {
          content: [
            {
              type: "text",
              text: t(
                `Unknown signal "${params.signal}": use "correction" or "affirmation".`,
                `未知信号 "${params.signal}"：请使用 "correction" 或 "affirmation"。`,
              ),
            },
          ],
          details: undefined,
        };
      }
      const text = getLastUserInput();
      if (text === "") {
        return {
          content: [
            {
              type: "text",
              text: t(
                "No user message to attach; memory_signal needs the user's exact words.",
                "暂无可附加的用户原话；memory_signal 需要用户原文。",
              ),
            },
          ],
          details: undefined,
        };
      }
      const result = await active.memorySignal({
        signal: params.signal,
        reason: params.reason,
        text,
      });
      const lines: string[] = [];
      if (result.skipped) {
        lines.push(
          t(
            "Feedback already recorded for this episode; nothing was changed.",
            "该反馈此前已入账，本次不做任何变更。",
          ),
        );
      } else if (result.applied !== true) {
        lines.push(
          t(
            "No closed episode to book this feedback against; nothing was recorded.",
            "没有已关闭的任务可供本次反馈入账，未做记录。",
          ),
        );
      } else {
        lines.push(
          params.signal === "correction"
            ? t(
                "Correction recorded: the user's exact words were saved as a new memory card.",
                "已记录纠正：用户原话已存为新记忆卡。",
              )
            : t("Affirmation recorded.", "已记录肯定。"),
        );
        if (result.claim !== undefined && result.claim !== null) {
          lines.push(formatClaim(result.claim));
        }
        const n = result.claim_ids?.length ?? 0;
        lines.push(
          params.signal === "correction"
            ? t(
                `Booked as a loss on ${n} card(s) of the last closed task.`,
                `已按 loss 入账到最近一个已关闭任务的 ${n} 张卡。`,
              )
            : t(
                `Booked as a half-weight win on ${n} card(s) of the last closed task.`,
                `已按半权重 win 入账到最近一个已关闭任务的 ${n} 张卡。`,
              ),
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  });
}

function formatCommandsBlock(
  commands: string[],
  hash: string | null | undefined,
): string {
  const body =
    commands.length > 0 ? commands.map((c) => `  ${c}`).join("\n") : t("  (none)", "  （无）");
  return [
    t("Command list (full text):", "命令清单（全文）："),
    body,
    t(`content hash: ${hash ?? "—"}`, `内容 hash：${hash ?? "—"}`),
  ].join("\n");
}

function createPromoteListTool(ensureClient: EnsureClient) {
  return defineTool({
    name: "memory_promote_list",
    label: "Memory Promote List",
    description:
      "List memloop promotion candidates: experience cards that can become skill contracts. " +
      "Each entry carries the suggested action (auto or confirm), the lineage, and an evidence summary. " +
      "Use memory_promote to fetch a contract draft and run the user confirmation flow.",
    promptSnippet: "List memloop promotion candidates",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true, idempotentHint: true },

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        return unavailable();
      }
      const result = await active.promoteCandidates();
      if (result.candidates.length === 0) {
        return {
          content: [{ type: "text", text: t("No promotion candidates.", "没有升格候选。") }],
          details: undefined,
        };
      }
      const lines = result.candidates.map((c) => {
        const ev = c.evidence;
        return t(
          `- [${c.id}] suggest ${c.suggest ?? "confirm"} | lineage ${c.lineage?.anchor ?? "—"} v${c.lineage?.last_version ?? 0} | evidence ${ev?.wins ?? 0}W/${ev?.losses ?? 0}L veto[${(ev?.veto ?? []).join(",")}]`,
          `- [${c.id}] 建议 ${c.suggest ?? "confirm"} | 谱系 ${c.lineage?.anchor ?? "—"} v${c.lineage?.last_version ?? 0} | 证据 ${ev?.wins ?? 0} 胜/${ev?.losses ?? 0} 负 否决[${(ev?.veto ?? []).join(",")}]`,
        );
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  });
}

function createPromoteTool(ensureClient: EnsureClient) {
  return defineTool({
    name: "memory_promote",
    label: "Memory Promote",
    description:
      "Promote one memloop experience card to a skill contract through the user confirmation flow. " +
      "This call only fetches the contract draft and runs the user's confirmation dialog. " +
      "The draft shows the full command list and the content hash the approval binds to. " +
      "The model cannot approve or reject: only the user's confirmation decides, " +
      "and the TS bridge then commits the draft's exact bytes with its content hash. " +
      "An auto_ok card is promoted by the periodic consolidate pass instead. " +
      "Commands are never executed automatically.",
    promptSnippet: "Promote a memory card to a skill contract",
    parameters: Type.Object({
      claim_id: Type.String({ description: "Claim id from memory_promote_list" }),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        return unavailable();
      }
      const { draft } = await active.promoteRequest({ claim_id: params.claim_id });
      const lines = [
        t(`Promotion draft: ${params.claim_id}`, `升格草案：${params.claim_id}`),
        t(
          `decision: ${draft.decision ?? "?"} (suggest ${draft.suggest ?? "confirm"})`,
          `判定：${draft.decision ?? "?"}（建议 ${draft.suggest ?? "confirm"}）`,
        ),
      ];
      if (draft.override) {
        lines.push(
          t(
            "override: user explicitly requested a veto-rejected card (audited)",
            "覆盖：用户显式请求被否决的卡（已留审计）",
          ),
        );
      }
      if (draft.veto.length > 0) {
        lines.push(t(`veto: ${draft.veto.join(", ")}`, `否决原因：${draft.veto.join("、")}`));
      }
      lines.push(t(`contract path: ${draft.path ?? "—"}`, `契约路径：${draft.path ?? "—"}`));
      lines.push(formatCommandsBlock(draft.commands, draft.content_hash));
      // A model call produces the draft only (三权分立): AUTO_OK commits ride
      // the consolidate path (不经模型), and the user's confirmation dialog is
      // the only commit path for a confirm-track card. The bridge binds the
      // commit to the draft's content hash.
      if (draft.decision === "auto_ok") {
        lines.push(
          t(
            "auto_ok: the consolidate pass promotes this card automatically. The model cannot commit it.",
            "auto_ok：该卡由 consolidate 自动路径升格。模型不能直接落盘。",
          ),
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
      }
      if (!ctx.hasUI) {
        lines.push(
          t(
            "User confirmation is required and no dialog is available here. Nothing was written.",
            "需要用户确认，但当前无确认界面。未写入任何内容。",
          ),
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
      }
      let approved: boolean;
      try {
        approved = await ctx.ui.confirm(
          t("Promote memory card?", "升格记忆卡？"),
          lines.join("\n"),
        );
      } catch (err) {
        lines.push(
          t(
            `User confirmation failed: ${String(err)}. Nothing was written.`,
            `用户确认失败：${String(err)}。未写入任何内容。`,
          ),
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
      }
      const res = await active.promoteCommit({
        claim_id: params.claim_id,
        approved,
        content_hash: draft.content_hash,
      });
      const out = [
        approved
          ? t(
              `Promotion approved: ${res.path ?? params.claim_id}`,
              `已批准升格：${res.path ?? params.claim_id}`,
            )
          : t(
              `Promotion rejected: ${params.claim_id} (card stays active)`,
              `已拒绝升格：${params.claim_id}（卡片保持 active）`,
            ),
      ];
      out.push(formatCommandsBlock(res.commands, res.content_hash));
      return { content: [{ type: "text", text: out.join("\n") }], details: undefined };
    },
  });
}

export function registerMemloopTools(
  pi: ExtensionAPI,
  ensureClient: EnsureClient,
  getLastUserInput: () => string,
  embedQuery?: EmbedQuery,
): void {
  pi.registerTool(createSearchTool(ensureClient, embedQuery));
  pi.registerTool(createVerifyTool(ensureClient));
  pi.registerTool(createOverrideTool(ensureClient));
  pi.registerTool(createMemorySignalTool(ensureClient, getLastUserInput));
  pi.registerTool(createPromoteListTool(ensureClient));
  pi.registerTool(createPromoteTool(ensureClient));
}
