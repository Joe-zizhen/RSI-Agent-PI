/**
 * Step 4.3 pi loading probe (P2 decision gate).
 *
 * Measures how the real pi skill loader treats contract-shaped SKILL.md files.
 * The run uses the real pi CLI in RPC mode with the faux model provider
 * (test/faux-model-ext.ts), the same harness style as test/pi-session.mjs.
 * The skill loader is pi core code. The model is scripted. No network is used.
 *
 * Probes:
 *   (a) custom frontmatter fields (version/status/source_claim/lineage_anchor)
 *       on a SKILL.md. Does the skill enter the usable skill set?
 *   (b) a contract body with a `## commands` section. Does the skill load?
 *   (c) exclusion. Does the loader drop `_retired/` directories and does it
 *       drop frontmatter `status: superseded`?
 *   (d) the 4.1 retraction mechanism (plan 4.3 decision): after
 *       `.pi/skills/.ignore` gains `_retired/`, is the archived contract
 *       gone from the usable skill set while a live one still loads? Unlike
 *       (a)-(c) this probe asserts its outcome: rule A's retraction is only
 *       effective when the loader honors the ignore file.
 *
 * Observables per fixture:
 *   - RPC `get_commands` entries with source "skill" (the usable skill set)
 *   - the `<available_skills>` block in the model system prompt (faux dump)
 *
 * The probe asserts only probe machinery (fixtures written, pi answers,
 * dump captured). Loader outcomes are not asserted. Outcomes are facts for
 * the 4.3 decision gate and are printed in the report.
 *
 * Run: node test/pi-skill-load-probe.mjs   (from packages/memloop-bridge)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const tmpRoot = path.join(here, ".tmp-skill-probe");
rmSync(tmpRoot, { recursive: true, force: true });
const projectRoot = path.join(tmpRoot, "project");
const sessionDir = path.join(tmpRoot, "sessions");
const agentDir = path.join(tmpRoot, "agent");
const skillsDir = path.join(projectRoot, ".pi", "skills");
mkdirSync(projectRoot, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });

// ---------------------------------------------------------------------------
// fixtures. Contract shape follows plan 4.4: custom frontmatter fields plus
// procedure body sections. Probe A omits `## commands` to isolate (a) from (b).
// Probe C1 models the 4.1 rule A archive path `.pi/skills/_retired/<slug>-v<n>/`.
// Probe C2 models the legacy fallback: in-place `status: superseded` marking.
// Values avoid ASCII ": " so the YAML frontmatter stays plain scalars.
// ---------------------------------------------------------------------------

function writeSkill(relDir, frontmatter, body) {
  const dir = path.join(skillsDir, ...relDir.split("/"));
  mkdirSync(dir, { recursive: true });
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    fmLines.push(`${key}: ${value}`);
  }
  fmLines.push("---");
  const file = path.join(dir, "SKILL.md");
  writeFileSync(file, `${fmLines.join("\n")}\n\n${body}\n`, "utf8");
  return file;
}

const BODY_WITHOUT_COMMANDS = [
  "## procedure",
  "探测步骤一。",
  "",
  "## when-not",
  "无",
  "",
  "## verify",
  "无",
  "",
  "## provenance",
  "- successes: 3",
].join("\n");

const BODY_WITH_COMMANDS = [
  "## procedure",
  "探测步骤一。",
  "",
  "## when-not",
  "无",
  "",
  "## verify",
  "无",
  "",
  "## commands",
  "```sh",
  "pytest tests/qa -q",
  "```",
  "",
  "## provenance",
  "- successes: 3",
].join("\n");

const FIXTURES = [
  {
    tag: "A",
    name: "exp-p43-load",
    relDir: "exp-p43-load",
    what: "custom frontmatter (version/status/source_claim/lineage_anchor)",
    frontmatter: {
      name: "exp-p43-load",
      title: "加载探针 A",
      description:
        "加载探测用契约 A。用于验证 pi 是否接受自定义 frontmatter。何时用：仅测试。何时不要用：生产。",
      version: 1,
      status: "active",
      source_claim: "probe-claim-a",
      lineage_anchor: "probe-anchor-a",
    },
    body: BODY_WITHOUT_COMMANDS,
  },
  {
    tag: "B",
    name: "exp-p43-cmds",
    relDir: "exp-p43-cmds",
    what: "custom frontmatter + ## commands section",
    frontmatter: {
      name: "exp-p43-cmds",
      title: "加载探针 B",
      description:
        "加载探测用契约 B。用于验证含命令清单段的契约能否加载。何时用：仅测试。何时不要用：生产。",
      version: 1,
      status: "active",
      source_claim: "probe-claim-b",
      lineage_anchor: "probe-anchor-b",
    },
    body: BODY_WITH_COMMANDS,
  },
  {
    tag: "C1",
    name: "exp-p43-retired",
    relDir: "_retired/exp-p43-retired-v1",
    what: "_retired/ archive dir + status: superseded",
    frontmatter: {
      name: "exp-p43-retired",
      title: "加载探针 C1",
      description: "加载探测用契约 C1。模拟撤下归档契约。何时用：仅测试。何时不要用：生产。",
      version: 1,
      status: "superseded",
      source_claim: "probe-claim-c1",
      lineage_anchor: "probe-anchor-c",
    },
    body: BODY_WITHOUT_COMMANDS,
  },
  {
    tag: "C2",
    name: "exp-p43-superseded",
    relDir: "exp-p43-superseded",
    what: "live dir + status: superseded (in-place marking)",
    frontmatter: {
      name: "exp-p43-superseded",
      title: "加载探针 C2",
      description:
        "加载探测用契约 C2。模拟原地打作废标记的契约。何时用：仅测试。何时不要用：生产。",
      version: 2,
      status: "superseded",
      source_claim: "probe-claim-c2",
      lineage_anchor: "probe-anchor-c",
    },
    body: BODY_WITHOUT_COMMANDS,
  },
];

for (const fixture of FIXTURES) {
  fixture.file = writeSkill(fixture.relDir, fixture.frontmatter, fixture.body);
}

// ---------------------------------------------------------------------------
// minimal pi RPC client (JSONL on stdin/stdout, see pi docs/rpc.md).
// Trimmed copy of the client in test/pi-session.mjs.
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

// Skills discovery is ON (no --no-skills). `--approve` sets project trust so
// `<cwd>/.pi/skills` is loaded in RPC mode (no interactive trust prompt).
// PI_CODING_AGENT_DIR keeps user-scope skills and settings out of the probe.
function startPi(dumpPath) {
  const cli = resolvePiCli();
  const args = [
    ...cli.prefix,
    "--mode",
    "rpc",
    "--no-mcp",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "-ne",
    "--approve",
    "-e",
    path.join(here, "faux-model-ext.ts"),
    "--model",
    "faux/faux-1",
    "--session-dir",
    sessionDir,
  ];
  const proc = spawn(cli.command, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      MEMLOOP_FAUX_SCENARIO: "text",
      MEMLOOP_FAUX_DUMP: dumpPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new PiRpc(proc);
}

// ---------------------------------------------------------------------------
// probe run
// ---------------------------------------------------------------------------

const dumpPath = path.join(tmpRoot, "faux-dump.txt");
let machineryOk = true;
const facts = new Map();

try {
  for (const fixture of FIXTURES) {
    assert.ok(existsSync(fixture.file), `fixture must exist: ${fixture.file}`);
  }

  const rpc = startPi(dumpPath);

  // Observable 1: the usable skill set as pi reports it over RPC.
  const commandsRes = await rpc.send({ type: "get_commands" });
  const commands = commandsRes.data?.commands;
  assert.ok(
    Array.isArray(commands),
    `get_commands must return commands, got ${JSON.stringify(commandsRes.data)}`,
  );
  const skillEntries = commands.filter((c) => c.source === "skill");
  const viaCommands = new Map(skillEntries.map((c) => [c.name.replace(/^skill:/, ""), c]));

  // Observable 2: the skill list placed in the model system prompt.
  await rpc.prompt("ping");
  const dump = existsSync(dumpPath) ? readFileSync(dumpPath, "utf8") : "";
  assert.ok(dump.length > 0, "faux dump must capture the request transcript");

  for (const fixture of FIXTURES) {
    facts.set(fixture.tag, {
      viaCommands: viaCommands.has(fixture.name),
      viaPrompt: dump.includes(`<name>${fixture.name}</name>`),
    });
  }

  // ---- report -------------------------------------------------------------
  console.log("==== pi skill load probe ====");
  console.log(`project skills dir: ${skillsDir}`);
  console.log("get_commands skill entries (source=skill):");
  if (skillEntries.length === 0) {
    console.log("  (none)");
  } else {
    for (const entry of skillEntries) {
      console.log(`  ${entry.name}  path=${entry.sourceInfo?.path ?? "?"}`);
    }
  }
  const promptNames = [...dump.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
  console.log("system prompt <available_skills> names:");
  if (promptNames.length === 0) {
    console.log("  (none)");
  } else {
    for (const name of promptNames) console.log(`  ${name}`);
  }
  console.log("fixture facts (loaded = in usable skill set):");
  for (const fixture of FIXTURES) {
    const fact = facts.get(fixture.tag);
    const verdict = fact.viaCommands && fact.viaPrompt ? "LOADED" : "NOT LOADED";
    console.log(
      `  ${fixture.tag} ${fixture.name}  [${fixture.what}]  get_commands=${fact.viaCommands ? "YES" : "NO"}  prompt=${fact.viaPrompt ? "YES" : "NO"}  -> ${verdict}`,
    );
  }
  console.log("4.3 answers:");
  const a = facts.get("A");
  const b = facts.get("B");
  const c1 = facts.get("C1");
  const c2 = facts.get("C2");
  console.log(`  (a) custom frontmatter loads: ${a.viaCommands && a.viaPrompt ? "YES" : "NO"}`);
  console.log(`  (b) ## commands section loads: ${b.viaCommands && b.viaPrompt ? "YES" : "NO"}`);
  console.log(
    `  (c) _retired/ excluded by loader: ${c1.viaCommands || c1.viaPrompt ? "NO" : "YES"}`,
  );
  console.log(
    `  (c) status:superseded excluded by loader: ${c2.viaCommands || c2.viaPrompt ? "NO" : "YES"}`,
  );
  if (rpc.stderr.trim() !== "") {
    console.log("pi stderr:");
    console.log(rpc.stderr.trim());
  }

  await rpc.shutdown();

  // ---- probe (d): the .ignore mechanism rule A relies on (plan 4.3) ----
  // Same fixtures, one change: .pi/skills/.ignore gains _retired/. The
  // archived contract must drop out of the usable skill set while a live
  // contract keeps loading. Asserted: 4.1's retraction move is only
  // effective when the loader honors the ignore file.
  writeFileSync(path.join(skillsDir, ".ignore"), "_retired/\n", "utf8");
  const dumpPath2 = path.join(tmpRoot, "faux-dump-ignore.txt");
  const rpc2 = startPi(dumpPath2);
  const commandsRes2 = await rpc2.send({ type: "get_commands" });
  const commands2 = commandsRes2.data?.commands;
  assert.ok(
    Array.isArray(commands2),
    `phase 2 get_commands must return commands, got ${JSON.stringify(commandsRes2.data)}`,
  );
  const viaCommands2 = new Map(
    commands2.filter((c) => c.source === "skill").map((c) => [c.name.replace(/^skill:/, ""), c]),
  );
  await rpc2.prompt("ping");
  const dump2 = existsSync(dumpPath2) ? readFileSync(dumpPath2, "utf8") : "";
  assert.ok(dump2.length > 0, "phase 2 faux dump must capture the request transcript");
  const ignoreFacts = {
    archived: viaCommands2.has("exp-p43-retired") && dump2.includes("<name>exp-p43-retired</name>"),
    live: viaCommands2.has("exp-p43-load") && dump2.includes("<name>exp-p43-load</name>"),
  };
  console.log("probe (d) after .pi/skills/.ignore gains _retired/:");
  console.log(`  archived exp-p43-retired  -> ${ignoreFacts.archived ? "LOADED" : "NOT LOADED"}`);
  console.log(`  live exp-p43-load (control)  -> ${ignoreFacts.live ? "LOADED" : "NOT LOADED"}`);
  console.log(
    `  (d) .ignore excludes the archived contract: ${!ignoreFacts.archived && ignoreFacts.live ? "YES" : "NO"}`,
  );
  assert.equal(
    ignoreFacts.archived,
    false,
    ".ignore must exclude the _retired/ contract (rule A effectiveness)",
  );
  assert.equal(ignoreFacts.live, true, ".ignore must not exclude live contracts");
  await rpc2.shutdown();
} catch (err) {
  machineryOk = false;
  console.log(`PROBE MACHINERY FAILED: ${err instanceof Error ? err.stack : String(err)}`);
}

if (machineryOk) {
  rmSync(tmpRoot, { recursive: true, force: true });
} else {
  console.log(`artifacts kept for inspection: ${tmpRoot}`);
}
process.exit(machineryOk ? 0 : 1);
