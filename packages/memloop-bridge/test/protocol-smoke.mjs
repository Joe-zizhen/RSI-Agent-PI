/**
 * Protocol smoke test for sidecar.ts against test/fake-sidecar.mjs.
 *
 * This is a mock protocol test: it proves the client envelope round-trip and
 * journal watermark replay logic. Real sidecar connectivity is covered in the
 * integration stage against memloop serve.py.
 *
 * Run: node test/protocol-smoke.mjs
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MemloopSidecar } from "../src/sidecar.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeSidecar = path.join(here, "fake-sidecar.mjs");
const tmpRoot = path.join(here, ".tmp");

function freshDir(name) {
  const dir = path.join(tmpRoot, `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function journalLines(journalPath) {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

async function testRoundTrip() {
  const dataDir = freshDir("rt");
  const logPath = path.join(dataDir, "fake.log");
  process.env.FAKE_LOG = logPath;
  process.env.FAKE_WATERMARK = "0";

  const client = new MemloopSidecar({
    projectRoot: here,
    sessionKey: "smoke-rt",
    extensionDir: here,
    dataDir,
    sidecarCommand: process.execPath,
    sidecarArgs: [fakeSidecar],
  });

  const ready = await client.ensureReady();
  assert.equal(ready, true, "sidecar must start");

  const pong = await client.ping();
  assert.deepEqual(pong, { pong: true });

  const captured = await client.capture({
    kind: "FAILURE_FIX",
    payload: { text: "命令失败：pytest", verify_cmd: "pytest", failed_cmd: "pytest" },
    origin_key: "pi:smoke-rt:1",
  });
  assert.ok(captured.event_id !== undefined, "capture must return event_id");

  const journal = journalLines(client.journalPath);
  assert.equal(journal.length, 1, "capture must journal before send");
  assert.equal(journal[0].seq, 1);
  assert.equal(journal[0].op, "capture");
  assert.equal(journal[0].origin_key, "pi:smoke-rt:1");

  await client.cardify({
    event_id: captured.event_id,
    key: "pytest",
    claim_kind: "experience",
    match_pattern: "pytest",
  });

  const retrieved = await client.retrieve({ context: "怎么跑测试" });
  assert.equal(retrieved.picked.length, 1);
  assert.equal(retrieved.picked[0].key, "test_cmd");
  assert.equal(retrieved.picked[0].confidence, 0.83);
  assert.equal(retrieved.picked[0].verify_cmd, "pytest tests/qa -q");

  const guardNone = await client.guard({
    tool_name: "read",
    args: { path: "a.ts" },
    call_key: "read:a.ts",
  });
  assert.equal(guardNone.level, "none");

  const guardL2 = await client.guard({
    tool_name: "bash",
    args: { command: "rm -rf /" },
    call_key: "bash:rm -rf /",
  });
  assert.equal(guardL2.level, "l2");
  assert.equal(guardL2.blocked, true);
  assert.ok(
    typeof guardL2.message === "string" && guardL2.message.length > 0,
    "L2 must carry a message",
  );

  const guardL1 = await client.guard({
    tool_name: "bash",
    args: { command: "remind me" },
    call_key: "bash:remind me",
  });
  assert.equal(guardL1.level, "l1");
  assert.equal(guardL1.blocked, false);

  const signal = await client.classifySignal({ text: "不对，测试命令改了" });
  assert.equal(signal.signal, "correction");

  const episode = await client.beginTask({ prompt: "修 bug" });
  assert.equal(episode.episode_id, "ep-1");

  const closed = await client.closeEpisode({});
  assert.equal(closed.verdict, "unknown");
  assert.deepEqual(closed.claim_ids, ["c1"]);

  const dream = await client.runDream({ force: true });
  assert.equal(dream.ran, true);
  assert.equal(dream.changed, true);

  const imported = await client.importEvents([
    { seq: 10, kind: "OBSERVATION", payload: { text: "外部事件" }, origin_key: "pi:smoke-rt:10" },
  ]);
  assert.equal(imported.imported, 1);

  await client.shutdown();
  console.log("PASS round-trip: envelope, id matching, guard levels, journal write-ahead");
}

async function testJournalReplay() {
  const dataDir = freshDir("replay");
  const logPath = path.join(dataDir, "fake.log");
  process.env.FAKE_LOG = logPath;
  // Sidecar has processed only seq 1; journal holds 1..3 → replay 2 and 3.
  process.env.FAKE_WATERMARK = "1";

  // The journal must exist before the client is constructed so the seq
  // counter picks up the pre-seeded maximum.
  const journalPath = path.join(dataDir, "journal", "smoke-replay.jsonl");
  mkdirSync(path.dirname(journalPath), { recursive: true });
  for (const seq of [1, 2, 3]) {
    appendFileSync(
      journalPath,
      `${JSON.stringify({
        seq,
        op: "capture",
        args: {
          kind: "EXPLICIT_INSTRUCTION",
          payload: { text: `事件 ${seq}` },
          ts: "2026-10-10T00:00:00.000Z",
          origin_key: `pi:smoke-replay:${seq}`,
        },
      })}\n`,
      "utf8",
    );
  }

  const client = new MemloopSidecar({
    projectRoot: here,
    sessionKey: "smoke-replay",
    extensionDir: here,
    dataDir,
    sidecarCommand: process.execPath,
    sidecarArgs: [fakeSidecar],
  });
  assert.equal(client.journalPath, journalPath);

  const ready = await client.ensureReady();
  assert.equal(ready, true, "sidecar must start for replay");

  const log = readLog(logPath);
  const importReq = log.find((e) => e.dir === "in" && e.op === "import_events");
  assert.ok(importReq !== undefined, "replay must send import_events for unacked journal entries");
  assert.equal(importReq.args.session_key, "smoke-replay");
  assert.deepEqual(
    importReq.args.events.map((e) => e.seq),
    [2, 3],
    "only entries above the watermark are replayed",
  );
  assert.deepEqual(
    importReq.args.events.map((e) => e.origin_key),
    ["pi:smoke-replay:2", "pi:smoke-replay:3"],
    "origin_key must survive replay for idempotent re-import",
  );

  // New captures continue the journal seq above the pre-seeded maximum.
  const captured = await client.capture({
    kind: "OBSERVATION",
    payload: { text: "新事件" },
    origin_key: "pi:smoke-replay:4",
  });
  assert.ok(captured.event_id !== undefined);
  const journal = journalLines(client.journalPath);
  assert.equal(journal.length, 4, "one new journal line appended after replay");
  assert.equal(journal[3].seq, 4, "seq continues after the journal maximum");

  await client.shutdown();
  console.log(
    "PASS journal replay: watermark filter (2,3 of 1..3), origin_key kept, seq continues at 4",
  );
}

async function testForgetShow() {
  const dataDir = freshDir("forget");
  const logPath = path.join(dataDir, "fake.log");
  process.env.FAKE_LOG = logPath;
  process.env.FAKE_WATERMARK = "0";

  const client = new MemloopSidecar({
    projectRoot: here,
    sessionKey: "smoke-forget",
    extensionDir: here,
    dataDir,
    sidecarCommand: process.execPath,
    sidecarArgs: [fakeSidecar],
  });
  const ready = await client.ensureReady();
  assert.equal(ready, true);

  // show: get_claim returns the card; unknown ids return null (not a search hit).
  const shown = await client.getClaim({ claim_id: "c1" });
  assert.ok(shown.claim !== null, "get_claim must return the claim");
  assert.equal(shown.claim.key, "test_cmd");
  const missing = await client.getClaim({ claim_id: "nope" });
  assert.equal(missing.claim, null, "get_claim must return null for unknown ids");

  // forget: delete_claim removes it; repeats and unknown ids report deleted=false.
  const deleted = await client.deleteClaim({ claim_id: "c1" });
  assert.equal(deleted.deleted, true);
  const again = await client.deleteClaim({ claim_id: "c1" });
  assert.equal(again.deleted, false);
  const gone = await client.getClaim({ claim_id: "c1" });
  assert.equal(gone.claim, null, "deleted claim must be gone");

  await client.shutdown();
  console.log(
    "PASS forget/show: get_claim hit+miss, delete_claim true/false, claim gone after delete",
  );
}

async function main() {
  await testRoundTrip();
  await testJournalReplay();
  await testForgetShow();
  rmSync(tmpRoot, { recursive: true, force: true });
  console.log(
    "ALL PASS (mock protocol self-test; real sidecar connectivity is integration-stage work)",
  );
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
