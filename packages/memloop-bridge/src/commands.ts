/**
 * memloop user commands: /memory (list, show, forget, audit) and /dreaming
 * (dream replay audit). These are the transparency surface; capture stays
 * zero-touch.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ClaimRegistry, MemloopSidecar, RunDreamResult, UsedClaim } from "./sidecar.ts";
import { formatClaim } from "./tools.ts";
import { t } from "./t.ts";

type EnsureClient = (ctx: ExtensionContext) => Promise<MemloopSidecar | undefined>;

function formatUsed(claim: UsedClaim): string {
  const confidence = claim.confidence !== undefined ? claim.confidence.toFixed(2) : "??";
  const verify =
    claim.verify_cmd !== undefined && claim.verify_cmd !== ""
      ? t(`verify: ${claim.verify_cmd}`, `验证命令: ${claim.verify_cmd}`)
      : t("no verify command", "无验证命令");
  return t(
    `- [${claim.key}] confidence ${confidence}\n  ${claim.text}\n  ${verify}`,
    `- [${claim.key}] 置信度 ${confidence}\n  ${claim.text}\n  ${verify}`,
  );
}

async function showList(ctx: ExtensionCommandContext, registry: ClaimRegistry): Promise<void> {
  const used = registry.list();
  if (used.length === 0) {
    ctx.ui.notify(
      t("No Memory cards used in this session yet.", "本会话还没有使用过记忆卡。"),
      "info",
    );
    return;
  }
  ctx.ui.notify(
    t(
      `Used ${used.length} cards this session:\n${used.map(formatUsed).join("\n")}`,
      `本会话用卡 ${used.length} 条：\n${used.map(formatUsed).join("\n")}`,
    ),
    "info",
  );
}

async function showDetail(
  ctx: ExtensionCommandContext,
  client: MemloopSidecar,
  id: string,
): Promise<void> {
  try {
    const detail = await client.claimDetail({ claim_id: id });
    if (detail.claim === null) {
      ctx.ui.notify(t(`Memory card not found: ${id}`, `未找到记忆卡：${id}`), "warning");
      return;
    }
    const lines: string[] = [formatClaim(detail.claim)];
    const judged = detail.evidence.filter((row) => row.outcome !== undefined && row.outcome !== null);
    const losses = judged.filter((row) => row.outcome === false).length;
    const recent = judged
      .slice(-3)
      .map((row) => (row.outcome ? "win" : "loss"))
      .join(" -> ");
    lines.push(t("Evidence:", "证据摘要："));
    lines.push(
      t(
        `  rows ${detail.evidence.length}, counterexamples ${losses}`,
        `  行数 ${detail.evidence.length}，反例数 ${losses}`,
      ),
    );
    lines.push(t(`  recent verdicts: ${recent || "—"}`, `  最近判决：${recent || "—"}`));
    const chain = detail.chain
      .map((row) => `${row.id}(${row.status ?? "?"}${row.status_reason ? `: ${row.status_reason}` : ""})`)
      .join(" -> ");
    lines.push(t(`Lineage: ${chain || "—"}`, `谱系链：${chain || "—"}`));
    if (detail.contract !== null && detail.contract !== undefined) {
      lines.push(
        t(
          `Contract: ${detail.contract.path} (status: ${detail.contract.status ?? "—"})`,
          `契约：${detail.contract.path}（status：${detail.contract.status ?? "—"}）`,
        ),
      );
    } else {
      lines.push(t("Contract: none", "契约：无"));
    }
    if (detail.notices.length === 0) {
      lines.push(t("Notices: none", "通告：无"));
    } else {
      lines.push(t("Notices (retention, audit rows included):", "通告保留区（含审计行）："));
      for (const row of detail.notices.slice(-10)) {
        lines.push(`  [${row.kind}] ${row.text}`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (err) {
    ctx.ui.notify(t(`Query failed: ${String(err)}`, `查询失败：${String(err)}`), "warning");
  }
}

async function showAudit(ctx: ExtensionCommandContext, client: MemloopSidecar): Promise<void> {
  try {
    const rep = await client.audit();
    const lines = [t("/memory audit", "/memory 审计")];
    lines.push(
      t("Missed (candidates - picked, no re-scoring):", "漏召（candidates − picked，不重打分）："),
    );
    if (rep.missed.length === 0) {
      lines.push(t("  none", "  无"));
    } else {
      for (const row of rep.missed.slice(0, 20)) {
        lines.push(`  [${row.claim_id}] ${row.key ?? ""} x ${row.count ?? 0}`);
      }
    }
    lines.push(
      t("False triggers (injected into a loss episode):", "误触发（注入后 episode loss）："),
    );
    if (rep.false_triggers.length === 0) {
      lines.push(t("  none", "  无"));
    } else {
      for (const row of rep.false_triggers.slice(0, 20)) {
        lines.push(`  [${row.claim_id}] ${row.key ?? ""} @ ${row.episode_id ?? "—"}`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (err) {
    ctx.ui.notify(t(`Audit failed: ${String(err)}`, `审计失败：${String(err)}`), "warning");
  }
}

async function forgetClaim(
  ctx: ExtensionCommandContext,
  client: MemloopSidecar,
  id: string,
): Promise<void> {
  // No confirm dialog: typing /memory forget is itself explicit user intent.
  try {
    const existing = await client.getClaim({ claim_id: id });
    if (existing.claim === null) {
      ctx.ui.notify(t(`Memory card not found: ${id}`, `未找到记忆卡：${id}`), "warning");
      return;
    }
    ctx.ui.notify(
      t(`Will delete:\n${formatClaim(existing.claim)}`, `将删除：\n${formatClaim(existing.claim)}`),
      "info",
    );
    const result = await client.deleteClaim({ claim_id: id });
    if (result.deleted) {
      ctx.ui.notify(t(`Deleted permanently: ${id}`, `已物理删除：${id}`), "info");
    } else {
      ctx.ui.notify(
        t(`Delete failed: the sidecar did not delete ${id}`, `删除失败：sidecar 未删除 ${id}`),
        "warning",
      );
    }
  } catch (err) {
    ctx.ui.notify(t(`Delete failed: ${String(err)}`, `删除失败：${String(err)}`), "warning");
  }
}

function formatField(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

function asPolicyFields(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  return Object.keys(rec).length > 0 ? rec : undefined;
}

// The dream result carries policy fields under several agreed names; probe
// them instead of binding to one spelling while the sidecar settles the shape.
function resolvePolicySides(result: RunDreamResult): {
  incumbent: Record<string, unknown> | undefined;
  winner: Record<string, unknown> | undefined;
} {
  const incumbent = asPolicyFields(result.incumbent ?? result.current ?? result.before);
  let winner = asPolicyFields(result.winner_policy ?? result.winner_fields);
  if (winner === undefined) {
    if (typeof result.winner === "string") {
      const candidates = asPolicyFields(result.candidates ?? result.policies);
      winner = candidates !== undefined ? asPolicyFields(candidates[result.winner]) : undefined;
    } else {
      winner = asPolicyFields(result.winner);
    }
  }
  return { incumbent, winner };
}

function renderPolicyDiff(
  incumbent: Record<string, unknown> | undefined,
  winner: Record<string, unknown> | undefined,
): string[] {
  const keys = [...new Set([...Object.keys(incumbent ?? {}), ...Object.keys(winner ?? {})])].sort();
  if (keys.length === 0)
    return [
      t("policy diff: the result carries no policy fields", "参数差异: 结果未携带 policy 字段"),
    ];
  const lines = [t("policy diff (incumbent → winner):", "参数差异 (incumbent → winner):")];
  for (const key of keys) {
    const before = incumbent?.[key];
    const after = winner?.[key];
    lines.push(
      JSON.stringify(before) === JSON.stringify(after)
        ? t(
            `  ${key}: ${formatField(before)} (unchanged)`,
            `  ${key}: ${formatField(before)} （未变）`,
          )
        : `  ${key}: ${formatField(before)} -> ${formatField(after)}`,
    );
  }
  return lines;
}

function resolveRestored(result: RunDreamResult): Record<string, unknown> | undefined {
  return asPolicyFields(result.restored ?? result.policy ?? result.after ?? result.winner);
}

export function registerMemloopCommands(
  pi: ExtensionAPI,
  ensureClient: EnsureClient,
  registry: ClaimRegistry,
): void {
  pi.registerCommand("memory", {
    description: "memloop memory: list | show <id> | forget <id> | audit",
    getArgumentCompletions: (prefix) => {
      const sub = ["list", "show", "forget", "audit"].filter((s) => s.startsWith(prefix));
      return sub.length > 0 ? sub.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        ctx.ui.notify(
          t(
            "Memory system unavailable (sidecar not running).",
            "记忆系统不可用（sidecar 未运行）。",
          ),
          "warning",
        );
        return;
      }
      const [sub = "list", ...rest] = args.trim().split(/\s+/);
      const id = rest.join(" ").trim();
      if (sub === "list") {
        await showList(ctx, registry);
      } else if (sub === "show") {
        if (id === "") {
          ctx.ui.notify(t("Usage: /memory show <id>", "用法：/memory show <id>"), "warning");
          return;
        }
        await showDetail(ctx, active, id);
      } else if (sub === "forget") {
        if (id === "") {
          ctx.ui.notify(t("Usage: /memory forget <id>", "用法：/memory forget <id>"), "warning");
          return;
        }
        await forgetClaim(ctx, active, id);
      } else if (sub === "audit") {
        await showAudit(ctx, active);
      } else {
        ctx.ui.notify(
          t(
            "Usage: /memory list | show <id> | forget <id> | audit",
            "用法：/memory list | show <id> | forget <id> | audit",
          ),
          "warning",
        );
      }
    },
  });

  pi.registerCommand("dreaming", {
    description: t(
      "memloop Dream replay: /dreaming | /dreaming rollback",
      "memloop 梦境回放：/dreaming | /dreaming rollback",
    ),
    handler: async (args, ctx) => {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        ctx.ui.notify(
          t(
            "Memory system unavailable (sidecar not running).",
            "记忆系统不可用（sidecar 未运行）。",
          ),
          "warning",
        );
        return;
      }
      if (args.trim() === "rollback") {
        const result = await active.runDream({ rollback: true });
        const restored = resolveRestored(result);
        const lines = [
          t("/dreaming rollback complete", "/dreaming 回滚完成"),
          t(`changed: ${String(result.changed)}`, `已变更: ${String(result.changed)}`),
          t("Restored policy fields:", "恢复后的 policy 字段："),
        ];
        if (restored !== undefined) {
          for (const key of Object.keys(restored).sort())
            lines.push(`  ${key}: ${formatField(restored[key])}`);
        } else {
          lines.push(`  ${JSON.stringify(result)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const result = await active.runDream({ force: true });
      const { incumbent, winner } = resolvePolicySides(result);
      const lines = [
        t(`/dreaming audit report`, `/dreaming 审计报告`),
        t(`ran: ${String(result.ran)}`, `已执行: ${String(result.ran)}`),
        t(`winner: ${JSON.stringify(result.winner)}`, `胜出: ${JSON.stringify(result.winner)}`),
        t(`changed: ${String(result.changed)}`, `已变更: ${String(result.changed)}`),
        ...renderPolicyDiff(incumbent, winner),
        t(`scores: ${JSON.stringify(result.scores)}`, `得分: ${JSON.stringify(result.scores)}`),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
