/**
 * memloop model-facing tools: search, verify, and override memory claim cards.
 * All three talk to the same sidecar the lifecycle hooks use.
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { MemloopSidecar, RetrievedClaim } from "./sidecar.ts";
import { t } from "./t.ts";

type EnsureClient = (ctx: ExtensionContext) => Promise<MemloopSidecar | undefined>;

export function formatClaim(claim: RetrievedClaim): string {
  const confidence = claim.confidence !== undefined ? claim.confidence.toFixed(2) : "??";
  const verifyCmd = claim.verify_cmd;
  const verify =
    verifyCmd !== undefined && verifyCmd !== null && verifyCmd !== ""
      ? t(`verify: ${verifyCmd}`, `验证命令: ${verifyCmd}`)
      : t("no verify command", "无验证命令");
  const kind = claim.claim_kind !== undefined ? claim.claim_kind : "claim";
  return t(
    `- [${claim.key}] (${kind}, confidence ${confidence})\n  ${claim.text}\n  ${verify}`,
    `- [${claim.key}] (${kind}, 置信度 ${confidence})\n  ${claim.text}\n  ${verify}`,
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

function createSearchTool(ensureClient: EnsureClient) {
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
      const result = await active.search({ query: params.query, k: params.k });
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
            `Memory card ${params.claim_id} was falsified. The card will be evicted and will not be injected again.`,
            `记忆卡 ${params.claim_id} 已证伪（falsified）。该卡将被清理，不再注入。`,
          )
        : result.ok
          ? t(
              `Memory card ${params.claim_id} verified (ok).`,
              `记忆卡 ${params.claim_id} 验证通过（ok）。`,
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

export function registerMemloopTools(pi: ExtensionAPI, ensureClient: EnsureClient): void {
  pi.registerTool(createSearchTool(ensureClient));
  pi.registerTool(createVerifyTool(ensureClient));
  pi.registerTool(createOverrideTool(ensureClient));
}
