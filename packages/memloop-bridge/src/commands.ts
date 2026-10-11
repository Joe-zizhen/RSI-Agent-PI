/**
 * memloop user commands: /memory (list, show, forget) and /dreaming (dream
 * replay audit). These are the transparency surface; capture stays zero-touch.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ClaimRegistry, MemloopSidecar, RunDreamResult, UsedClaim } from "./sidecar.ts";
import { formatClaim } from "./tools.ts";

type EnsureClient = (ctx: ExtensionContext) => Promise<MemloopSidecar | undefined>;

function formatUsed(claim: UsedClaim): string {
  const confidence = claim.confidence !== undefined ? claim.confidence.toFixed(2) : "??";
  const verify =
    claim.verify_cmd !== undefined && claim.verify_cmd !== ""
      ? `验证命令: ${claim.verify_cmd}`
      : "无验证命令";
  return `- [${claim.key}] 置信度 ${confidence}\n  ${claim.text}\n  ${verify}`;
}

async function showList(ctx: ExtensionCommandContext, registry: ClaimRegistry): Promise<void> {
  const used = registry.list();
  if (used.length === 0) {
    ctx.ui.notify("本会话还没有使用过记忆卡。", "info");
    return;
  }
  ctx.ui.notify(`本会话用卡 ${used.length} 条：\n${used.map(formatUsed).join("\n")}`, "info");
}

async function showDetail(
  ctx: ExtensionCommandContext,
  client: MemloopSidecar,
  id: string,
): Promise<void> {
  try {
    const result = await client.getClaim({ claim_id: id });
    if (result.claim === null) {
      ctx.ui.notify(`未找到记忆卡：${id}`, "warning");
      return;
    }
    ctx.ui.notify(formatClaim(result.claim), "info");
  } catch (err) {
    ctx.ui.notify(`查询失败：${String(err)}`, "warning");
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
      ctx.ui.notify(`未找到记忆卡：${id}`, "warning");
      return;
    }
    ctx.ui.notify(`将删除：\n${formatClaim(existing.claim)}`, "info");
    const result = await client.deleteClaim({ claim_id: id });
    if (result.deleted) {
      ctx.ui.notify(`已物理删除：${id}`, "info");
    } else {
      ctx.ui.notify(`删除失败：sidecar 未删除 ${id}`, "warning");
    }
  } catch (err) {
    ctx.ui.notify(`删除失败：${String(err)}`, "warning");
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
  if (keys.length === 0) return ["参数差异: 结果未携带 policy 字段"];
  const lines = ["参数差异 (incumbent → winner):"];
  for (const key of keys) {
    const before = incumbent?.[key];
    const after = winner?.[key];
    lines.push(
      JSON.stringify(before) === JSON.stringify(after)
        ? `  ${key}: ${formatField(before)} （未变）`
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
    description: "memloop memory: list | show <id> | forget <id>",
    getArgumentCompletions: (prefix) => {
      const sub = ["list", "show", "forget"].filter((s) => s.startsWith(prefix));
      return sub.length > 0 ? sub.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        ctx.ui.notify("记忆系统不可用（sidecar 未运行）。", "warning");
        return;
      }
      const [sub = "list", ...rest] = args.trim().split(/\s+/);
      const id = rest.join(" ").trim();
      if (sub === "list") {
        await showList(ctx, registry);
      } else if (sub === "show") {
        if (id === "") {
          ctx.ui.notify("用法：/memory show <id>", "warning");
          return;
        }
        await showDetail(ctx, active, id);
      } else if (sub === "forget") {
        if (id === "") {
          ctx.ui.notify("用法：/memory forget <id>", "warning");
          return;
        }
        await forgetClaim(ctx, active, id);
      } else {
        ctx.ui.notify("用法：/memory list | show <id> | forget <id>", "warning");
      }
    },
  });

  pi.registerCommand("dreaming", {
    description: "memloop 梦境回放：/dreaming | /dreaming rollback",
    handler: async (args, ctx) => {
      const active = await ensureClient(ctx);
      if (active === undefined) {
        ctx.ui.notify("记忆系统不可用（sidecar 未运行）。", "warning");
        return;
      }
      if (args.trim() === "rollback") {
        const result = await active.runDream({ rollback: true });
        const restored = resolveRestored(result);
        const lines = [
          "/dreaming 回滚完成",
          `已变更: ${String(result.changed)}`,
          "恢复后的 policy 字段：",
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
        `/dreaming 审计报告`,
        `已执行: ${String(result.ran)}`,
        `胜出: ${JSON.stringify(result.winner)}`,
        `已变更: ${String(result.changed)}`,
        ...renderPolicyDiff(incumbent, winner),
        `得分: ${JSON.stringify(result.scores)}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
