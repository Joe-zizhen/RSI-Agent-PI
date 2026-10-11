/**
 * Fake memloop sidecar for protocol smoke tests.
 *
 * Implements only the stdio JSONL envelope and deterministic per-op results.
 * The real sidecar (memloop serve.py) is exercised in the integration stage.
 *
 * Env:
 *   FAKE_LOG       - append every request/response line to this file
 *   FAKE_WATERMARK - watermark_seq returned by get_state (default 0)
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_LOG;
const watermark = Number(process.env.FAKE_WATERMARK ?? "0");
let eventId = 0;

function log(entry) {
  if (logPath !== undefined && logPath !== "") {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

const SAMPLE_CLAIM = {
  id: "c1",
  key: "test_cmd",
  text: "全量测试命令是 pytest tests/qa -q",
  confidence: 0.83,
  verify_cmd: "pytest tests/qa -q",
  claim_kind: "experience",
};

// Mutable store so the forget/show flow can assert delete-then-gone.
const claims = new Map([["c1", SAMPLE_CLAIM]]);

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (line.trim() === "") return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  log({ dir: "in", ...req });
  const { id, op, args } = req;

  const reply = (result) => {
    const msg = { id, ok: true, result };
    log({ dir: "out", ...msg });
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const fail = (error) => {
    const msg = { id, ok: false, error };
    log({ dir: "out", ...msg });
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  switch (op) {
    case "ping":
      return reply({ pong: true });
    case "capture":
      eventId += 1;
      return reply({ event_id: eventId });
    case "cardify":
      return reply({ card_id: `card-${String(args.event_id)}`, event_id: args.event_id });
    case "retrieve":
      return reply({ picked: [SAMPLE_CLAIM], conflicts: [], injected: 1 });
    case "guard": {
      // Deterministic guard rules so the smoke test can hit each level.
      const callKey = String(args.call_key ?? "");
      if (callKey.includes("rm -rf")) {
        return reply({
          level: "l2",
          claim_id: "c1",
          message: "[memloop 硬拦截] 命中已验证的失败模式。",
          blocked: true,
        });
      }
      if (callKey.includes("remind")) {
        return reply({
          level: "l1",
          claim_id: "c1",
          message: "[memloop 提醒] 命中记忆卡 (test_cmd)。",
          blocked: false,
        });
      }
      return reply({ level: "none", claim_id: null, message: "", blocked: false });
    }
    case "override":
      return reply({ claim_id: args.claim_id, ok: true, claim: SAMPLE_CLAIM });
    case "verify":
      return reply({ ok: true, falsified: false });
    case "get_claim":
      return reply({ claim: claims.get(String(args.claim_id)) ?? null });
    case "delete_claim":
      return reply({ deleted: claims.delete(String(args.claim_id)) });
    case "search":
      return reply({ claims: [SAMPLE_CLAIM] });
    case "classify_signal": {
      const text = String(args.text ?? "");
      if (text.includes("不对")) return reply({ signal: "correction" });
      if (text.includes("可以了")) return reply({ signal: "affirmation" });
      return reply({ signal: "none" });
    }
    case "begin_task":
      return reply({ episode_id: "ep-1" });
    case "close_episode":
      return reply({ verdict: "unknown", claim_ids: ["c1"], applied: 0 });
    case "episode_signal":
      return reply({ ok: true });
    case "consolidate":
      return reply({ ok: true });
    case "run_dream":
      return reply({
        ran: true,
        winner: "l2_min_confidence=0.8",
        scores: { current: 0.5, candidate: 0.7 },
        changed: true,
      });
    case "stats":
      return reply({ events: eventId, claims: 1 });
    case "import_events":
      return reply({ imported: Array.isArray(args.events) ? args.events.length : 0 });
    case "get_state":
      return reply({ watermark_seq: watermark });
    default:
      return fail(`unknown op: ${String(op)}`);
  }
});

// Exit cleanly on stdin EOF so shutdown() can finish gracefully.
rl.on("close", () => {
  process.exit(0);
});
