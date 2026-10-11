/**
 * Real end-to-end integration: the sidecar.ts client against the real
 * memloop serve.py subprocess (Python from memloop/.venv, PYTHONPATH set by
 * the client's launch resolver). No mocks.
 *
 * Scenarios (integration handoff a-h):
 *   a. capture dedupe on origin_key
 *   b. Chinese card + Chinese retrieve (acceptance 1)
 *   c. L2 guard: 3 full-weight wins -> confidence 0.8 -> block once per
 *      call_key -> override releases (message carries verify path + override)
 *   d. verdict loop: WIN books, LOSS books, flaky UNKNOWN books nothing
 *   e. episode_signal: correction loss w1.0 vs affirmation win w0.5
 *   f. verify self-heal: falsified -> consolidate -> evicted -> no retrieve
 *   g. get_claim / delete_claim round trip
 *   h. crash recovery: kill sidecar, restart, journal replay is loss-free
 *      and duplicate-free
 *   i. (acceptance 10) a proven EXPERIENCE card promotes to a loadable
 *      .pi/skills/<key>/SKILL.md
 *
 * Run: node test/integration.mjs   (from memloop/pi-bridge)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MemloopSidecar } from "../src/sidecar.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
// The bundled python-build-standalone runtime, as packaged under app resources.
const PY =
  process.env.MEMLOOP_PYTHON ??
  path.join(repoRoot, "apps", "desktop", "runtime", "python", "python.exe");
process.env.MEMLOOP_PYTHON = PY;
// The vendored memloop package: resolveServeLaunch finds <home>/memloop/serve.py.
process.env.MEMLOOP_HOME = path.join(packageRoot, "python");

const tmpRoot = path.join(here, ".tmp-it");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

const outcomes = [];
async function step(name, fn) {
  try {
    await fn();
    outcomes.push([name, "PASS"]);
    console.log(`PASS ${name}`);
  } catch (err) {
    outcomes.push([name, "FAIL"]);
    console.log(`FAIL ${name}: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

function makeClient(dataDir, sessionKey) {
  return new MemloopSidecar({
    projectRoot: here,
    sessionKey,
    extensionDir: path.join(packageRoot, "src"),
    dataDir,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Outcomes array ([[ts, success, weight], ...]) straight from the store. */
function outcomesOf(dbPath, claimId) {
  const code =
    "import json,sqlite3,sys\n" +
    'row=sqlite3.connect(sys.argv[1]).execute("SELECT outcomes FROM claims WHERE id=?",(sys.argv[2],)).fetchone()\n' +
    "print(json.dumps(json.loads(row[0]) if row else None))\n";
  const res = spawnSync(PY, ["-c", code, dbPath, claimId], { encoding: "utf8" });
  assert.equal(res.status, 0, `outcome peek failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

/** Raw get_claim result, including contract fields the TS reader normalizes. */
async function rawClaim(client, claimId) {
  const res = await client.request("get_claim", { claim_id: claimId });
  return res.claim;
}

async function main() {
  const dataDir = path.join(tmpRoot, "main");
  const client = makeClient(dataDir, "it-main");
  assert.equal(await client.ensureReady(), true, "real sidecar must start");
  assert.deepEqual(await client.ping(), { pong: true });
  const dbPath = client.dbPath;

  // ---------------------------------------------------------------- a
  await step("a. capture dedupe (origin_key idempotent)", async () => {
    const first = await client.capture({
      kind: "observation",
      payload: { text: "it:1 第一条事件" },
      origin_key: "it:1",
    });
    assert.ok(first.event_id !== undefined && first.event_id !== null);
    assert.equal(first.deduped, false);
    const again = await client.capture({
      kind: "observation",
      payload: { text: "it:1 重复投递" },
      origin_key: "it:1",
    });
    assert.equal(again.deduped, true, "second capture must dedupe");
    assert.equal(again.event_id, first.event_id, "dedupe keeps the original event id");
    const stats = await client.stats();
    assert.equal(stats.events, 1, "events must not duplicate");
  });

  // ---------------------------------------------------------------- b
  await step("b. Chinese card + Chinese retrieve", async () => {
    const text = "全量测试命令是 pytest tests/qa -q";
    const captured = await client.capture({
      kind: "observation",
      payload: { text },
      origin_key: "it:2",
    });
    const cardified = await client.cardify({
      event_id: captured.event_id,
      key: "test_cmd",
      text,
      verify_cmd: "exit 0",
    });
    assert.equal(cardified.claim.key, "test_cmd");
    assert.equal(cardified.claim.verify_cmd, "exit 0");
    const got = await client.retrieve({ context: "跑全量测试" });
    assert.ok(
      got.picked.some((c) => c.key === "test_cmd"),
      `Chinese retrieve must hit test_cmd, got ${JSON.stringify(got.picked.map((c) => c.key))}`,
    );
    assert.ok(typeof got.injected === "string" && got.injected.includes("test_cmd"));
  });

  // ---------------------------------------------------------------- c
  await step("c. L2 guard: 3 wins -> block once -> override flip stays in its task", async () => {
    const text = "禁止直接跑 pytest 危险命令会破坏环境";
    const captured = await client.capture({
      kind: "observation",
      payload: { text },
      origin_key: "it:3",
    });
    const cardified = await client.cardify({
      event_id: captured.event_id,
      key: "guard_card",
      text,
      verify_cmd: "exit 0",
      match_pattern: "pytest ",
    });
    const cid = cardified.claim.id;

    // three full-weight world wins through the real verdict loop
    for (let i = 0; i < 3; i++) {
      await client.beginTask({ prompt: "guard 权重构建" });
      const got = await client.retrieve({ context: "危险命令 pytest", limit: 1 });
      assert.equal(got.picked[0]?.key, "guard_card", "win attribution must land on guard_card");
      const closed = await client.closeEpisode({ verdict_cmd: "exit 0" });
      assert.equal(closed.verdict, "win");
    }
    const after = await rawClaim(client, cid);
    assert.ok(
      Math.abs(after.confidence - 0.8) < 1e-9,
      `confidence must be 0.8, got ${after.confidence}`,
    );
    assert.equal(after.status, "active");

    const g1 = await client.guard({
      tool_name: "bash",
      args: { command: "pytest" },
      call_key: "it:guard-1",
    });
    assert.equal(g1.level, "l2");
    assert.equal(g1.blocked, true, "L2 must block");
    assert.ok(g1.message.includes("exit 0"), "block message must carry the verify path");
    assert.ok(
      g1.message.includes("memory_override"),
      "block message must carry the override channel",
    );

    const g2 = await client.guard({
      tool_name: "bash",
      args: { command: "pytest" },
      call_key: "it:guard-1",
    });
    assert.equal(g2.blocked, false, "second call on the same call_key must pass");

    // Same-task flip (plan 4.3): the override happens inside this task, so
    // this task's WIN books the opposite way on the overridden card (the
    // block was noise -> the card loses confidence).
    await client.beginTask({ prompt: "覆盖任务" });
    const ov = await client.override({
      claim_id: cid,
      reason: "集成验证：本次属例外",
      call_key: "it:guard-2",
    });
    assert.equal(ov.claim?.key, "guard_card");
    const g3 = await client.guard({
      tool_name: "bash",
      args: { command: "pytest" },
      call_key: "it:guard-2",
    });
    assert.equal(g3.blocked, false, "overridden claim must not block");
    assert.equal(g3.level, "none");
    const confBefore = (await rawClaim(client, cid)).confidence;
    const closed = await client.closeEpisode({ verdict_cmd: "exit 0" });
    assert.equal(closed.verdict, "win");
    const confAfter = (await rawClaim(client, cid)).confidence;
    assert.ok(
      confAfter < confBefore,
      `same-task override + WIN must flip to LOSS (拦错被世界纠正) ${confBefore} -> ${confAfter}`,
    );
    const outs = outcomesOf(dbPath, cid);
    assert.equal(
      outs.at(-1)[1],
      false,
      "override + WIN must book LOSS on the overridden card (4.3)",
    );
    assert.equal(outs.at(-1)[2], 1.0, "the flip books at full loss weight");

    // Cross-task control (qa2 test_override_flip_must_not_leak_into_next_task):
    // task 1's override must not flip task 2's WIN. Task 2 has no override.
    await client.beginTask({ prompt: "跨任务对照" });
    const picked = await client.retrieve({ context: "危险命令 pytest", limit: 1 });
    assert.equal(picked.picked[0]?.key, "guard_card");
    const closed2 = await client.closeEpisode({ verdict_cmd: "exit 0" });
    assert.equal(closed2.verdict, "win");
    const confNext = (await rawClaim(client, cid)).confidence;
    assert.ok(
      confNext > confAfter,
      `task 2 without override must book WIN normally ${confAfter} -> ${confNext}`,
    );
    const outs2 = outcomesOf(dbPath, cid);
    assert.equal(outs2.at(-1)[1], true, "the flip must not leak into the next task");
  });

  // ---------------------------------------------------------------- d
  await step("d. verdict loop: WIN / LOSS / single-run WIN / flaky UNKNOWN", async () => {
    const shown = await rawClaim(
      client,
      (await client.search({ query: "跑全量测试", k: 1 })).claims[0].id,
    );
    const tcid = shown.id;
    assert.equal(shown.key, "test_cmd");
    const before = shown.confidence;

    await client.beginTask({ prompt: "跑全量测试" });
    const picked = await client.retrieve({ context: "跑全量测试", limit: 1 });
    assert.equal(picked.picked[0]?.key, "test_cmd");
    const win = await client.closeEpisode({ verdict_cmd: "exit 0" });
    assert.equal(win.verdict, "win");
    assert.equal(win.applied, true, "WIN must be booked");
    const afterWin = (await rawClaim(client, tcid)).confidence;
    assert.ok(afterWin > before, `WIN must raise confidence ${before} -> ${afterWin}`);

    await client.beginTask({ prompt: "再跑全量测试" });
    await client.retrieve({ context: "跑全量测试", limit: 1 });
    const loss = await client.closeEpisode({ verdict_cmd: "exit 1" });
    assert.equal(loss.verdict, "loss", "exit 1 twice must be LOSS");
    assert.equal(loss.applied, true, "LOSS must be booked");
    const afterLoss = (await rawClaim(client, tcid)).confidence;
    assert.ok(afterLoss < afterWin, `LOSS must lower confidence ${afterWin} -> ${afterLoss}`);

    // A counter verdict script exits `first` on run 1 and `second` on run 2.
    const counterCmd = (name, first, second) => {
      const script = path.join(tmpRoot, `${name}.py`);
      const counter = path.join(tmpRoot, `${name}-n.txt`);
      writeFileSync(
        script,
        "import pathlib, sys\n" +
          "p = pathlib.Path(sys.argv[1])\n" +
          "n = int(p.read_text()) if p.exists() else 0\n" +
          "p.write_text(str(n + 1))\n" +
          `raise SystemExit(${first} if n == 0 else ${second})\n`,
        "utf8",
      );
      return { cmd: `"${PY}" "${script}" "${counter}"`, counterPath: counter };
    };

    // Plan 5.1 row one (qa2 test_t1_exit_zero_on_first_run_is_win): first
    // exit 0 -> WIN, and the verdict command runs exactly once. A confirm
    // re-run after a pass is vetoed (side effects) and 0-then-non-0 is not
    // a plan signal, so the (0, 1) script must end at one invocation.
    const once = counterCmd("t1-once", 0, 1);
    await client.beginTask({ prompt: "首次 0 判决" });
    await client.retrieve({ context: "跑全量测试", limit: 1 });
    const onceRes = await client.closeEpisode({ verdict_cmd: once.cmd });
    assert.equal(onceRes.verdict, "win", "first exit 0 must be WIN");
    assert.equal(onceRes.applied, true, "WIN must be booked");
    assert.equal(
      readFileSync(once.counterPath, "utf8").trim(),
      "1",
      "verdict command must run exactly once on first exit 0",
    );
    const afterOnce = (await rawClaim(client, tcid)).confidence;
    assert.ok(afterOnce > afterLoss, "single-run WIN must raise confidence");

    // Flaky = first non-0, second 0 -> UNKNOWN (plan 5.1 "一次非 0 一次 0",
    // qa2 test_flaky_three_combinations). Nothing may be booked.
    const flaky = counterCmd("t1-flaky", 1, 0);
    const n1 = outcomesOf(dbPath, tcid);
    await client.beginTask({ prompt: "flaky 判决" });
    await client.retrieve({ context: "跑全量测试", limit: 1 });
    const flakyRes = await client.closeEpisode({ verdict_cmd: flaky.cmd });
    assert.equal(
      flakyRes.verdict,
      "unknown",
      `flaky (non-0 then 0) must be UNKNOWN, got ${flakyRes.verdict}`,
    );
    assert.equal(flakyRes.applied, false, "UNKNOWN must not book");
    assert.equal(
      readFileSync(flaky.counterPath, "utf8").trim(),
      "2",
      "flaky detection must re-run once after the non-zero exit",
    );
    const n2 = outcomesOf(dbPath, tcid);
    assert.equal(n2.length, n1.length, "UNKNOWN must not add an outcome");
    assert.equal(
      (await rawClaim(client, tcid)).confidence,
      afterOnce,
      "UNKNOWN must not move confidence",
    );
  });

  // ---------------------------------------------------------------- e
  await step("e. episode_signal: correction w1.0 vs affirmation w0.5", async () => {
    const mk = async (key, text, origin) => {
      const captured = await client.capture({
        kind: "observation",
        payload: { text },
        origin_key: origin,
      });
      const cardified = await client.cardify({
        event_id: captured.event_id,
        key,
        text,
        verify_cmd: "exit 0",
      });
      return cardified.claim.id;
    };
    const e1 = await mk("ep1_card", "午夜构建端口说明 e1", "it:e1");
    const e2 = await mk("ep2_card", "午夜构建端口说明 e2", "it:e2");

    await client.beginTask({ prompt: "ep1 任务" });
    const got1 = await client.retrieve({ context: "e1 午夜端口", limit: 1 });
    assert.equal(got1.picked[0]?.key, "ep1_card");
    const pending1 = await client.closeEpisode({});
    assert.equal(pending1.verdict, "pending", "close without verdict_cmd must stay pending");
    assert.equal(pending1.applied, false);
    const c0 = (await rawClaim(client, e1)).confidence;
    const sig1 = await client.episodeSignal({ signal: "correction" });
    assert.equal(sig1.applied, true);
    const c1 = (await rawClaim(client, e1)).confidence;
    assert.ok(c1 < c0, `correction must lower confidence ${c0} -> ${c1}`);

    await client.beginTask({ prompt: "ep2 任务" });
    const got2 = await client.retrieve({ context: "e2 午夜端口", limit: 1 });
    assert.equal(got2.picked[0]?.key, "ep2_card");
    await client.closeEpisode({});
    const d0 = (await rawClaim(client, e2)).confidence;
    const sig2 = await client.episodeSignal({ signal: "affirmation" });
    assert.equal(sig2.applied, true);
    const d1 = (await rawClaim(client, e2)).confidence;
    assert.ok(d1 > d0, `affirmation must raise confidence ${d0} -> ${d1}`);

    // weights: correction books loss at 1.0, affirmation books win at 0.5
    const o1 = outcomesOf(dbPath, e1);
    const o2 = outcomesOf(dbPath, e2);
    assert.equal(o1.length, 1);
    assert.equal(o1[0][1], false);
    assert.equal(o1[0][2], 1.0, "correction weight must be 1.0");
    assert.equal(o2.length, 1);
    assert.equal(o2[0][1], true);
    assert.equal(o2[0][2], 0.5, "affirmation weight must be 0.5");
    assert.ok(
      c0 - c1 > d1 - d0,
      `full loss (${c0 - c1}) must move more than half win (${d1 - d0})`,
    );
  });

  // ---------------------------------------------------------------- f
  await step("f. verify self-heal: falsify -> consolidate -> evicted", async () => {
    const text = "伪造知识 紫色月亮每晚升起";
    const captured = await client.capture({
      kind: "observation",
      payload: { text },
      origin_key: "it:6",
    });
    const cardified = await client.cardify({
      event_id: captured.event_id,
      key: "fake_card",
      text,
      verify_cmd: "exit 1",
    });
    const fid = cardified.claim.id;

    const before = await client.retrieve({ context: "紫色月亮 伪造知识", limit: 5 });
    assert.ok(
      before.picked.some((c) => c.key === "fake_card"),
      "card must be retrievable before verify",
    );

    const v = await client.verify({ claim_id: fid });
    assert.equal(v.ok, false);
    assert.equal(v.falsified, true, "verify failure must falsify");
    assert.equal((await rawClaim(client, fid)).status, "falsified");

    const cons = await client.consolidate();
    assert.ok(
      Array.isArray(cons.evicted) && cons.evicted.includes(fid),
      "consolidate must evict falsified",
    );
    assert.equal((await rawClaim(client, fid)).status, "evicted");

    const after = await client.retrieve({ context: "紫色月亮 伪造知识", limit: 5 });
    assert.ok(
      !after.picked.some((c) => c.key === "fake_card"),
      "evicted card must not be retrieved",
    );
  });

  // ---------------------------------------------------------------- g
  await step("g. get_claim / delete_claim round trip", async () => {
    const captured = await client.capture({
      kind: "observation",
      payload: { text: "临时卡片 沙盒条目" },
      origin_key: "it:7",
    });
    const cardified = await client.cardify({
      event_id: captured.event_id,
      key: "tmp_card",
      text: "临时卡片 沙盒条目",
    });
    const gid = cardified.claim.id;
    const shown = await client.getClaim({ claim_id: gid });
    assert.equal(shown.claim?.key, "tmp_card");
    const del = await client.deleteClaim({ claim_id: gid });
    assert.equal(del.deleted, true, "delete_claim must delete");
    const gone = await client.getClaim({ claim_id: gid });
    assert.equal(gone.claim, null, "deleted claim must be gone");
    const del2 = await client.deleteClaim({ claim_id: gid });
    assert.equal(del2.deleted, false, "second delete must report false");
  });

  // ---------------------------------------------------------------- i
  // acceptance 10: a proven EXPERIENCE card promotes to a loadable skill
  await step("i. promote: proven card -> .pi/skills/<key>/SKILL.md", async () => {
    const text = "升格候选：打包前必须跑 pytest tests/qa -q";
    const captured = await client.capture({
      kind: "failure_fix",
      payload: { text },
      origin_key: "it:9",
    });
    const cardified = await client.cardify({
      event_id: captured.event_id,
      key: "promote_demo",
      text,
      claim_kind: "experience",
      verify_cmd: "exit 0",
    });
    const pid = cardified.claim.id;
    for (let i = 0; i < 3; i++) {
      await client.beginTask({ prompt: "升格任务" });
      const got = await client.retrieve({ context: "打包 升格候选 pytest", limit: 1 });
      assert.equal(got.picked[0]?.key, "promote_demo");
      const closed = await client.closeEpisode({ verdict_cmd: "exit 0" });
      assert.equal(closed.verdict, "win");
    }
    const cons = await client.consolidate();
    assert.ok(
      Array.isArray(cons.promoted) && cons.promoted.includes(pid),
      "consolidate must promote the proven card",
    );
    const skillPath = path.join(here, ".pi", "skills", "promote_demo", "SKILL.md");
    assert.ok(existsSync(skillPath), `skill file must exist at ${skillPath}`);
    const body = readFileSync(skillPath, "utf8").replace(/\r\n/g, "\n");
    assert.ok(body.startsWith("---\nname: promote_demo\n"), "skill must carry pi frontmatter");
    assert.ok(body.includes("pytest tests/qa -q"), "skill must carry the card text");
    assert.ok(body.includes("`exit 0`"), "skill must carry the verify command");
    rmSync(path.join(here, ".pi"), { recursive: true, force: true });
  });

  await client.shutdown();

  // ---------------------------------------------------------------- h
  await step("h. crash recovery: kill sidecar, journal replay, no loss/dup", async () => {
    const dataDirH = path.join(tmpRoot, `crash-${process.pid}`);
    const session = "it-crash";
    const clientH = makeClient(dataDirH, session);
    assert.equal(await clientH.ensureReady(), true);
    const keys = ["it:h1", "it:h2", "it:h3"];
    for (const key of keys) {
      const r = await clientH.capture({
        kind: "observation",
        payload: { text: `崩溃事件 ${key}` },
        origin_key: key,
      });
      assert.equal(r.deduped, false);
    }

    // hard-kill the serve.py child (crash, not a graceful shutdown)
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*memloop.serve*' -and $_.CommandLine -like '*crash-${process.pid}*' } | ` +
      "Select-Object -ExpandProperty ProcessId";
    const found = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    assert.equal(found.status, 0, `pid lookup failed: ${found.stderr}`);
    const pid = Number(found.stdout.trim().split(/\s+/)[0]);
    assert.ok(
      Number.isInteger(pid) && pid > 0,
      `sidecar pid not found, got ${JSON.stringify(found.stdout)}`,
    );
    const killed = spawnSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf8" });
    assert.equal(killed.status, 0, `taskkill failed: ${killed.stderr}`);
    await sleep(500);

    // restart on the same journal + db: the client replay path runs
    const clientH2 = makeClient(dataDirH, session);
    assert.equal(await clientH2.ensureReady(), true, "restart must come up");
    const state = await clientH2.getState();
    assert.equal(
      state.watermark_seq,
      3,
      "watermark must advance over the 3 replayed journal entries",
    );
    const stats = await clientH2.stats();
    assert.equal(stats.events, 3, "no loss and no duplicate after crash replay");

    const imp = await clientH2.request("import_events", {
      session_key: session,
      events: keys.map((key, i) => ({
        seq: i + 1,
        kind: "observation",
        payload: { text: `崩溃事件 ${key}` },
        origin_key: key,
      })),
    });
    assert.equal(imp.imported, 0, "re-import must not duplicate");
    assert.equal(imp.deduped, 3, "re-import must dedupe all three");
    const again = await clientH2.capture({
      kind: "observation",
      payload: { text: "崩溃事件 it:h1" },
      origin_key: "it:h1",
    });
    assert.equal(again.deduped, true);
    assert.equal((await clientH2.stats()).events, 3);
    await clientH2.shutdown();
  });

  rmSync(tmpRoot, { recursive: true, force: true });

  const failed = outcomes.filter(([, s]) => s === "FAIL");
  console.log("\n==== integration summary ====");
  for (const [name, s] of outcomes) console.log(`${s}  ${name}`);
  console.log(`${outcomes.length - failed.length}/${outcomes.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL harness:", err);
  process.exit(1);
});
