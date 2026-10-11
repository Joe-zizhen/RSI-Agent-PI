/**
 * Real pi session integration for the memloop extension.
 *
 * Runs the installed `pi` CLI in RPC mode with two extensions loaded:
 *   test/faux-model-ext.ts  - scripted model (no network, no API key)
 *   ../memloop.ts           - the extension under test
 *
 * The agent loop, hooks, tools and extension commands are the real pi
 * runtime; only the LLM response is scripted (pi's own test approach).
 *
 * Scenarios:
 *   P1 "一次真实任务": before_agent_start memory block injection (CJK card),
 *      turn_end hint "本次引用了 N 条记忆", /memory list, /memory forget,
 *      /dreaming.
 *   P2 "L2 拦截": scripted bash tool call `pytest` trips the L2 guard; the
 *      block reason must carry the verify path and the override channel.
 *
 * Run: node test/pi-session.mjs   (from packages/memloop-bridge)
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MemloopSidecar } from "../src/sidecar.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const memloopRoot = packageRoot;
const PY =
  process.env.MEMLOOP_PYTHON ??
  path.join(repoRoot, "apps", "desktop", "runtime", "python", "python.exe");
process.env.MEMLOOP_PYTHON = PY;
// The vendored memloop package: resolveServeLaunch finds <home>/memloop/serve.py.
process.env.MEMLOOP_HOME = path.join(packageRoot, "python");

const dataDir = path.join(process.env.USERPROFILE ?? process.env.HOME, ".pi", "agent", "memloop");
const dataDirPreexisted = existsSync(dataDir);
const policyPath = path.join(dataDir, "policy.json");
const policyPreexisted = existsSync(policyPath);

const tmpRoot = path.join(here, ".tmp-pi");
rmSync(tmpRoot, { recursive: true, force: true });
const projectRoot = path.join(tmpRoot, "project");
const sessionDir = path.join(tmpRoot, "sessions");
mkdirSync(projectRoot, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

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

// ---------------------------------------------------------------------------
// minimal pi RPC client (JSONL on stdin/stdout, see pi docs/rpc.md)
// ---------------------------------------------------------------------------

class PiRpc {
  constructor(proc) {
    this.proc = proc;
    this.records = [];
    this.pending = new Map();
    this.buf = "";
    this.exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.feed(chunk));
    proc.stderr.setEncoding("utf8");
    this.stderr = "";
    proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  feed(chunk) {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() === "") continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this.records.push(rec);
      if (rec.type === "response" && rec.id !== undefined && this.pending.has(rec.id)) {
        const { resolve, reject, timer } = this.pending.get(rec.id);
        this.pending.delete(rec.id);
        clearTimeout(timer);
        if (rec.success === true) resolve(rec);
        else reject(new Error(`rpc ${rec.command}: ${rec.error}`));
      }
    }
  }

  send(command, timeoutMs = 30_000) {
    const id = command.id ?? `cmd-${this.pending.size + 1}-${Date.now()}`;
    const line = `${JSON.stringify({ ...command, id })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(line);
    });
  }

  waitFor(predicate, what, timeoutMs = 60_000) {
    const existing = this.records.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${what}`));
      }, timeoutMs);
      const iv = setInterval(() => {
        const hit = this.records.find(predicate);
        if (hit !== undefined) {
          clearInterval(iv);
          clearTimeout(timer);
          resolve(hit);
        }
      }, 50);
    });
  }

  async prompt(message) {
    const res = await this.send({ type: "prompt", message });
    if (res.data?.disposition === "started") {
      await this.waitFor((r) => r.type === "agent_settled", "agent_settled");
    }
    return res;
  }

  async shutdown() {
    this.proc.stdin.end();
    const code = await Promise.race([
      this.exited,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    if (code === "timeout") this.proc.kill();
    return code;
  }
}

function resolvePiCli() {
  const candidates = [
    process.env.MEMLOOP_PI_CLI,
    path.join(
      process.env.APPDATA ?? "",
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
    path.join(
      process.env.USERPROFILE ?? "",
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) {
      return { command: process.execPath, prefix: [candidate] };
    }
  }
  return { command: "pi", prefix: [] };
}

function startPi(env) {
  const cli = resolvePiCli();
  const args = [
    ...cli.prefix,
    "--mode",
    "rpc",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-ne",
    "-e",
    path.join(here, "faux-model-ext.ts"),
    "-e",
    path.join(packageRoot, "src", "memloop.ts"),
    "--model",
    "faux/faux-1",
    "--session-dir",
    sessionDir,
  ];
  const proc = spawn(cli.command, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      MEMLOOP_PYTHON: PY,
      MEMLOOP_HOME: memloopRoot,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new PiRpc(proc);
}

function dumpText(dumpPath) {
  return existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : "";
}

function sessionText() {
  let out = "";
  for (const name of readdirSync(sessionDir)) {
    out += readFileSync(path.join(sessionDir, name), "utf8");
  }
  return out;
}

function allRecordsText(rpc) {
  return JSON.stringify(rpc.records);
}

// ---------------------------------------------------------------------------
// seed: same data dir and project root the memloop.ts client will use
// ---------------------------------------------------------------------------

const seed = new MemloopSidecar({
  projectRoot,
  sessionKey: "pi-session-seed",
  extensionDir: path.join(packageRoot, "src"),
});

let testCmdId = "";
let guardId = "";

await step("seed memory store for the pi session", async () => {
  assert.equal(await seed.ensureReady(), true, "seed sidecar must start");

  const text = "全量测试命令是 pytest tests/qa -q";
  const ev1 = await seed.capture({
    kind: "observation",
    payload: { text },
    origin_key: "pi-seed:test_cmd",
  });
  const card1 = await seed.cardify({
    event_id: ev1.event_id,
    key: "test_cmd",
    text,
    verify_cmd: "echo memloop-verify-path",
  });
  testCmdId = card1.claim.id;

  const gtext = "禁止直接跑 pytest 危险命令会破坏环境";
  const ev2 = await seed.capture({
    kind: "observation",
    payload: { text: gtext },
    origin_key: "pi-seed:guard",
  });
  const card2 = await seed.cardify({
    event_id: ev2.event_id,
    key: "guard_card",
    text: gtext,
    verify_cmd: "echo memloop-verify-path",
    match_pattern: "pytest ",
  });
  guardId = card2.claim.id;
  for (let i = 0; i < 3; i++) {
    await seed.beginTask({ prompt: "seed" });
    await seed.retrieve({ context: "危险命令 pytest", limit: 1 });
    const closed = await seed.closeEpisode({ verdict_cmd: "exit 0" });
    assert.equal(closed.verdict, "win");
  }
  const guard = await seed.guard({
    tool_name: "bash",
    args: { command: "pytest" },
    call_key: "seed-probe",
  });
  assert.equal(guard.blocked, true, "seeded card must be L2-capable before the pi run");
});

// ---------------------------------------------------------------------------
// P1: injection + turn hint + /memory + /dreaming
// ---------------------------------------------------------------------------

await step("P1. pi session: L0 injection, turn hint, /memory, /dreaming", async () => {
  const dumpPath = path.join(tmpRoot, "faux-p1.txt");
  const rpc = startPi({ MEMLOOP_FAUX_SCENARIO: "text", MEMLOOP_FAUX_DUMP: dumpPath });

  // -- real task with a Chinese prompt ---------------------------------
  const run = await rpc.prompt("跑全量测试");
  assert.ok(
    ["started", "queued"].includes(run.data?.disposition),
    `prompt must start a run, got ${JSON.stringify(run.data)}`,
  );

  // (2) memory block reached the model's system prompt
  const dump = dumpText(dumpPath);
  assert.ok(dump.includes("长期记忆卡"), "system prompt must carry the memloop block");
  assert.ok(dump.includes("test_cmd"), "memory block must name the picked card");
  assert.ok(/0\.5\d/.test(dump), "memory block must carry confidence");
  assert.ok(dump.includes("echo memloop-verify-path"), "memory block must carry the verify path");

  // (8) /memory list
  const listRes = await rpc.prompt("/memory list");
  assert.equal(
    listRes.data?.disposition,
    "handled",
    "/memory list must be handled by the extension",
  );
  await rpc.waitFor(
    (r) =>
      r.type === "extension_ui_request" &&
      r.method === "notify" &&
      JSON.stringify(r).includes("本会话用卡"),
    "/memory list notify",
  );

  // (8) /dreaming audit report
  const dreamRes = await rpc.prompt("/dreaming");
  assert.equal(dreamRes.data?.disposition, "handled", "/dreaming must be handled by the extension");
  await rpc.waitFor(
    (r) =>
      r.type === "extension_ui_request" &&
      r.method === "notify" &&
      JSON.stringify(r).includes("/dreaming 审计报告"),
    "/dreaming notify",
  );

  // (8) /memory forget <id>: the card is physically deleted
  const forgetRes = await rpc.prompt(`/memory forget ${testCmdId}`);
  assert.equal(
    forgetRes.data?.disposition,
    "handled",
    "/memory forget must be handled by the extension",
  );
  await rpc.waitFor(
    (r) =>
      r.type === "extension_ui_request" &&
      r.method === "notify" &&
      JSON.stringify(r).includes("已物理删除"),
    "/memory forget notify",
  );

  // (9) turn_end hint entry: {type: "custom", customType: "memloop-hint", data: {count}}
  const entries = await rpc.send({ type: "get_entries" });
  const everything = `${allRecordsText(rpc)}${JSON.stringify(entries)}${sessionText()}`;
  assert.ok(everything.includes("memloop-hint"), "turn_end must append the memloop-hint entry");

  await rpc.shutdown();
});

await step("P1b. forgotten card is gone from the store", async () => {
  const gone = await seed.getClaim({ claim_id: testCmdId });
  assert.equal(gone.claim, null, "forgotten claim must be deleted");
  const kept = await seed.getClaim({ claim_id: guardId });
  assert.ok(kept.claim !== null, "guard card must survive");
});

// ---------------------------------------------------------------------------
// P1c: the hint entry renders as 「本次引用了 N 条记忆」
//
// The session entry itself is proven in P1. HTML export drops custom entries
// and tmux is unavailable on this host, so the rendered string is proven by
// executing the real registered entry renderer (extension-level check).
// ---------------------------------------------------------------------------

await step("P1c. hint entry renders 本次引用了 N 条记忆 (registered renderer)", async () => {
  const { createRequire } = await import("node:module");
  const piRoot = path.join(
    process.env.APPDATA ?? "",
    "npm",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const requireFromPi = createRequire(path.join(piRoot, "package.json"));
  const { createJiti } = requireFromPi("jiti");
  // Same alias map pi's extension loader builds (loader.ts getAliases).
  const piAiRoot = path.join(piRoot, "node_modules", "@earendil-works");
  const jiti = createJiti(import.meta.url, {
    alias: {
      "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
      "@earendil-works/pi-agent-core": path.join(piAiRoot, "pi-agent-core", "dist", "index.js"),
      "@earendil-works/pi-tui": path.join(piAiRoot, "pi-tui", "dist", "index.js"),
      "@earendil-works/pi-ai": path.join(piAiRoot, "pi-ai", "dist", "compat.js"),
      typebox: requireFromPi.resolve("typebox"),
    },
  });
  const mod = await jiti.import(path.join(packageRoot, "src", "memloop.ts"));
  const renderers = new Map();
  const stubPi = {
    on: () => () => {},
    registerTool: () => {},
    registerCommand: () => {},
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
  };
  (mod.default ?? mod)(stubPi);
  const renderer = renderers.get("memloop-hint");
  assert.ok(
    typeof renderer === "function",
    "memloop.ts must register the memloop-hint entry renderer",
  );
  const themeStub = { fg: (_name, text) => text };
  const out = renderer(
    { type: "custom", customType: "memloop-hint", data: { count: 2 } },
    {},
    themeStub,
  );
  const text = out?.text ?? String(out);
  assert.ok(
    text.includes("本次引用了 2 条记忆"),
    `renderer must produce the hint line, got: ${text}`,
  );
});

await step("P2. pi session: tool_call L2 block with verify path + override channel", async () => {
  const dumpPath = path.join(tmpRoot, "faux-p2.txt");
  const rpc = startPi({ MEMLOOP_FAUX_SCENARIO: "tool", MEMLOOP_FAUX_DUMP: dumpPath });

  const run = await rpc.prompt("处理危险命令 pytest 的任务");
  assert.ok(
    ["started", "queued"].includes(run.data?.disposition),
    `prompt must start a run, got ${JSON.stringify(run.data)}`,
  );

  // (3) the block reason must reach the model (and thus the transcript)
  const dump = dumpText(dumpPath);
  assert.ok(dump.includes("memloop 硬拦截"), "L2 block message must appear in the transcript");
  assert.ok(dump.includes("echo memloop-verify-path"), "block message must carry the verify path");
  assert.ok(dump.includes("memory_override"), "block message must carry the override channel");
  assert.ok(
    dump.includes(`claim_id="${guardId}"`) || dump.includes(guardId),
    "block message must name the claim id",
  );

  // the blocked bash call must not have executed
  const everything = `${allRecordsText(rpc)}${sessionText()}`;
  assert.ok(
    !everything.includes("no tests ran"),
    "bash must not have run (blocked before execution)",
  );

  await rpc.shutdown();
});

// ---------------------------------------------------------------------------
// P3: T2 order. A correction sent after agent_settled must book the PREVIOUS
// episode's attribution set (the plan's T2 back-fill), not the new task that
// the same input will start afterwards. Card A is task 1's pick; card B is
// picked only by the correction turn, so a wrongly-ordered signal would book B
// (or nothing) instead of A.
// ---------------------------------------------------------------------------

function outcomesOf(dbPath, claimId) {
  const code =
    "import json,sqlite3,sys\n" +
    'row=sqlite3.connect(sys.argv[1]).execute("SELECT outcomes FROM claims WHERE id=?",(sys.argv[2],)).fetchone()\n' +
    "print(json.dumps(json.loads(row[0]) if row else None))\n";
  const res = spawnSync(PY, ["-c", code, dbPath, claimId], { encoding: "utf8" });
  assert.equal(res.status, 0, `outcome peek failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

await step("P3. T2 order: correction after settle books the previous episode", async () => {
  const textA = "夏季构建端口是 8080";
  const evA = await seed.capture({
    kind: "observation",
    payload: { text: textA },
    origin_key: "pi-seed:t2-a",
  });
  const cardA = await seed.cardify({
    event_id: evA.event_id,
    key: "t2_summer_port",
    text: textA,
    verify_cmd: "echo memloop-verify-path",
  });
  const idA = cardA.claim.id;
  const textB = "冬季浇花时间是九点";
  const evB = await seed.capture({
    kind: "observation",
    payload: { text: textB },
    origin_key: "pi-seed:t2-b",
  });
  const cardB = await seed.cardify({
    event_id: evB.event_id,
    key: "t2_winter_plant",
    text: textB,
    verify_cmd: "echo memloop-verify-path",
  });
  const idB = cardB.claim.id;

  const dumpPath = path.join(tmpRoot, "faux-p3.txt");
  const rpc = startPi({ MEMLOOP_FAUX_SCENARIO: "text", MEMLOOP_FAUX_DUMP: dumpPath });

  // Task 1: retrieves card A (shared CJK tokens), settles with no verdict cmd.
  await rpc.prompt("夏季构建端口是多少");
  const confA0 = (await seed.getClaim({ claim_id: idA })).claim.confidence;

  // Task 2: a correction whose own retrieval matches card B only.
  await rpc.prompt("不对，冬季浇花时间其实是十点");

  const outsA = outcomesOf(seed.dbPath, idA);
  assert.equal(outsA.length, 1, "card A must book exactly one outcome from the T2 correction");
  assert.equal(outsA[0][1], false, "correction must book a loss");
  assert.equal(outsA[0][2], 1.0, "t2a correction weight must be 1.0");
  const confA1 = (await seed.getClaim({ claim_id: idA })).claim.confidence;
  assert.ok(confA1 < confA0, `correction must lower card A confidence ${confA0} -> ${confA1}`);
  const outsB = outcomesOf(seed.dbPath, idB);
  assert.equal(
    outsB.length,
    0,
    "card B is the new task's pick and must not book: the signal belongs to the previous episode",
  );

  await rpc.shutdown();
});

// ---------------------------------------------------------------------------
// P4: failure -> success pairing (memloop.ts tool_result hook). Within one
// task, bash fails X and later succeeds Y != X: the card must pair the two,
// with verify_cmd=Y (the demonstrated fix) and match_pattern=X. A failed
// command must never become a verify target.
// ---------------------------------------------------------------------------

function claimByMatchPattern(dbPath, pattern) {
  const code =
    "import json,sqlite3,sys\n" +
    'rows=sqlite3.connect(sys.argv[1]).execute("SELECT id, key, text, kind, verify_cmd, match_pattern FROM claims WHERE match_pattern=?",(sys.argv[2],)).fetchall()\n' +
    "print(json.dumps(rows))\n";
  const res = spawnSync(PY, ["-c", code, dbPath, pattern], { encoding: "utf8" });
  assert.equal(res.status, 0, `claim peek failed: ${res.stderr}`);
  const rows = JSON.parse(res.stdout.trim());
  return rows.length > 0 ? rows[0] : undefined;
}

await step(
  "P4. failure->success pairing: verify_cmd is the fix, match_pattern the failure",
  async () => {
    const X = "memloop-pairing-missing-cmd";
    const Y = "echo memloop-pairing-fixed";
    const dumpPath = path.join(tmpRoot, "faux-p4.txt");
    const rpc = startPi({ MEMLOOP_FAUX_SCENARIO: "fail-fix", MEMLOOP_FAUX_DUMP: dumpPath });
    await rpc.prompt("执行配对验证任务");

    // row = [id, key, text, kind, verify_cmd, match_pattern]
    const row = claimByMatchPattern(seed.dbPath, X);
    assert.ok(row !== undefined, `paired card must exist for failed command ${X}`);
    assert.equal(row[4], Y, "verify_cmd must be the successful fix, never the failed command");
    assert.equal(row[5], X, "match_pattern must be the failed command");
    assert.ok(
      row[2].includes(X) && row[2].includes(Y),
      `card text must name both commands, got: ${row[2]}`,
    );
    assert.equal(row[3], "experience", "paired card must be an experience card");

    await rpc.shutdown();
  },
);

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

function killStraySidecars() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*memloop.serve*' -and $_.CommandLine -like '*tmp-pi*' } | " +
    "Select-Object -ExpandProperty ProcessId";
  const found = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  for (const pid of (found.stdout ?? "").trim().split(/\s+/)) {
    if (pid !== "") spawnSync("taskkill", ["/F", "/PID", pid], { encoding: "utf8" });
  }
}

async function rmrfWithRetry(target) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      killStraySidecars();
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

await seed.shutdown();
killStraySidecars();
const failed = outcomes.filter(([, s]) => s === "FAIL");
if (failed.length === 0) {
  await rmrfWithRetry(tmpRoot);
} else {
  console.log(`artifacts kept for inspection: ${tmpRoot}`);
}
if (!dataDirPreexisted) {
  await rmrfWithRetry(dataDir);
} else {
  rmSync(path.join(dataDir, `${seed.dbPath.split(path.sep).pop()}`), { force: true });
  rmSync(path.join(dataDir, "journal", "pi-session-seed.jsonl"), { force: true });
  if (!policyPreexisted) rmSync(policyPath, { force: true });
}

console.log("\n==== pi session summary ====");
for (const [name, s] of outcomes) console.log(`${s}  ${name}`);
console.log(`${outcomes.length - failed.length}/${outcomes.length} passed`);
if (failed.length > 0) process.exit(1);
