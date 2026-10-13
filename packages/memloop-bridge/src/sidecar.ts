/**
 * memloop sidecar client: Python process management, stdio JSONL protocol,
 * and journal-based at-least-once event delivery.
 *
 * The protocol contract lives with the Python side (`serve.py` docstring).
 * This module stays free of Pi imports so Node can run it directly in the
 * protocol smoke test without module mapping.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

// ============================================================================
// Protocol types (mirror the memloop serve.py JSONL contract)
// ============================================================================

export type GuardLevel = "none" | "l1" | "l2";
export type SignalKind = "correction" | "affirmation" | "none";

export interface CaptureArgs {
  kind: string;
  payload: Record<string, unknown>;
  /** Epoch seconds (number); ISO strings from legacy journals are converted on send. */
  ts?: number | string | undefined;
  origin_key?: string | undefined;
  session?: string | undefined;
}

export interface CaptureResult {
  event_id: string | number;
  deduped?: boolean;
}

export interface CardifyArgs {
  event_id: string | number;
  key: string;
  text?: string;
  claim_kind?: string;
  verify_cmd?: string;
  match_pattern?: string;
}

export interface RetrievedClaim {
  id?: string | number;
  key: string;
  text: string;
  confidence?: number;
  verify_cmd?: string | null;
  claim_kind?: string;
  hearsay?: boolean;
  status?: string;
  match_pattern?: string | null;
  source_event_ids?: Array<string | number>;
  /** Promoted contract path from claim_lineage; null until promotion records one. */
  skill_path?: string | null;
}

export interface ConflictEntry {
  key: string;
  claim_ids?: Array<string | number>;
}

export interface RetrieveResult {
  picked: RetrievedClaim[];
  conflicts?: ConflictEntry[];
  injected?: unknown;
  /** Deliverable notice rows flushed for the current episode (plan 4.1). */
  notices?: NoticeRow[];
}

/** One row of the notices table (plan 4.1). kind carries ":audit" for audit rows. */
export interface NoticeRow {
  id?: number | string | undefined;
  claim_id?: string | number | undefined;
  lineage_anchor?: string | null | undefined;
  kind: string;
  text: string;
  episode_id?: string | null | undefined;
  created_at?: number | undefined;
  delivered_at?: number | null | undefined;
}

export interface NoticesFlushResult {
  notices: NoticeRow[];
}

export interface GuardArgs {
  tool_name: string;
  args: Record<string, unknown>;
  call_key: string;
}

export interface GuardResult {
  level: GuardLevel;
  claim_id?: string | number | null;
  message?: string;
  blocked?: boolean;
}

export interface OverrideResult {
  claim_id?: string | number;
  ok?: boolean;
  claim?: RetrievedClaim;
}

/** Four-way verify read (protocol 2): ok / falsified / unknown (timeout) / hearsay. */
export type VerifyStatus = "ok" | "falsified" | "unknown" | "hearsay";

export interface VerifyResult {
  ok: boolean;
  falsified: boolean;
  status?: VerifyStatus | undefined;
}

export interface GetClaimResult {
  claim: RetrievedClaim | null;
}

export interface DeleteClaimArgs {
  claim_id: string | number;
  purge_events?: boolean;
}

export interface DeleteClaimResult {
  deleted: boolean;
}

export interface SearchArgs {
  query: string;
  k?: number | undefined;
  /** Query embedding for the semantic channel (plan 3.5); absent = lexical. */
  ctx_embedding?: number[] | undefined;
  ctx_model?: string | undefined;
}

export interface SearchResult {
  claims: RetrievedClaim[];
}

export interface SetEmbeddingArgs {
  claim_id: string | number;
  vector: number[];
  model: string;
}

export interface SetEmbeddingResult {
  stored: boolean;
}

export interface CardifyResult {
  claim: RetrievedClaim | null;
}

export interface ClassifySignalResult {
  signal: SignalKind;
}

export interface MemorySignalArgs {
  signal: "correction" | "affirmation";
  /** The user's exact words (the stashed input line): the card body source. */
  text: string;
  /** Model wording: audit trace only, never claim text (plan 8, I1). */
  reason?: string | undefined;
  /** Explicit accounting target; default is the most recent closed episode. */
  episode_id?: string | undefined;
}

export interface MemorySignalResult {
  /** True when (episode, signal) was already processed by either channel. */
  skipped: boolean;
  applied?: boolean;
  claim_ids?: Array<string | number>;
  /** Correction only: the new card built from the user's exact words. */
  claim?: RetrievedClaim | null;
}

export interface BeginTaskResult {
  episode_id: string;
}

export interface CloseEpisodeArgs {
  verdict_cmd?: string | undefined;
}

export interface CloseEpisodeResult {
  verdict: string;
  claim_ids: Array<string | number>;
  applied: boolean;
}

// --- P3 promote confirm flow + visibility (plan 5.1/5.3) -------------------

export interface PromoteCandidate {
  id: string | number;
  lineage?:
    | {
        anchor?: string | number | null | undefined;
        skill_path?: string | null | undefined;
        last_version?: number | undefined;
      }
    | null
    | undefined;
  /** Suggested action: "auto" (auto_ok) or "confirm". */
  suggest?: string | undefined;
  evidence?:
    | {
        rows?: number | undefined;
        wins?: number | undefined;
        losses?: number | undefined;
        veto?: string[] | undefined;
      }
    | undefined;
}

export interface PromoteCandidatesResult {
  candidates: PromoteCandidate[];
}

/** The confirm-path draft (plan 4.5): commands 全文 + content_hash are the
 * security gate the approval binds to. */
export interface PromoteDraft {
  claim_id: string | number;
  decision?: string | undefined;
  suggest?: string | undefined;
  override: boolean;
  veto: string[];
  slug?: string | undefined;
  anchor?: string | number | undefined;
  version?: number | undefined;
  path?: string | undefined;
  /** Full command list (plan 4.4 extraction), never auto-executed. */
  commands: string[];
  /** sha256 of the exact contract bytes the approval binds to. */
  content_hash: string | null;
}

export interface PromoteRequestResult {
  draft: PromoteDraft;
}

export interface PromoteCommitResult {
  claim_id: string | number;
  decision?: string | undefined;
  override: boolean;
  veto: string[];
  state: "approved" | "rejected";
  path: string | null;
  commands: string[];
  content_hash: string | null;
  claim?: RetrievedClaim | null | undefined;
}

/** plan 5.3 /memory audit rows: trace set differences, no re-scoring. */
export interface AuditMissRow {
  claim_id: string | number;
  key: string | null;
  count: number;
}

export interface AuditFalseTriggerRow {
  claim_id: string | number;
  key: string | null;
  episode_id: string | null;
}

export interface AuditResult {
  missed: AuditMissRow[];
  false_triggers: AuditFalseTriggerRow[];
}

export interface ClaimDetailResult {
  claim: RetrievedClaim | null;
  lineage?:
    | {
        anchor?: string | number | null | undefined;
        skill_path?: string | null | undefined;
        last_version?: number | undefined;
      }
    | null
    | undefined;
  /** Every claim sharing the anchor, oldest first. */
  chain: Array<{
    id: string | number;
    key?: string | undefined;
    status?: string | undefined;
    status_reason?: string | undefined;
    created_at?: number | undefined;
  }>;
  /** Located SKILL.md (live or _retired/ archive) with its frontmatter status. */
  contract?: { path: string; status?: string | null | undefined } | null | undefined;
  evidence: EvidenceRow[];
  notices: NoticeRow[];
}

export interface RunDreamResult {
  /** Dream results carry policy field dicts under several agreed names. */
  [key: string]: unknown;
  ran: boolean;
  winner?: unknown;
  scores?: unknown;
  changed?: unknown;
}

export interface ImportEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  ts?: number | string | undefined;
  origin_key?: string | undefined;
}

export interface ImportEventsArgs {
  session_key: string;
  events: ImportEvent[];
}

export interface ImportEventsResult {
  imported?: number;
}

export interface GetStateResult {
  watermark_seq: number;
  /** Protocol generation advertised by the sidecar (serve.py get_state). */
  protocol?: number | undefined;
}

export interface EvidenceArgs {
  claim_id: string | number;
}

/** One claim_evidence row: rubric_pass and outcome are merged independently. */
export interface EvidenceRow {
  episode_id: string;
  rubric_pass?: boolean | null;
  outcome?: boolean | null;
  rubric_updated_at?: number | null;
  outcome_updated_at?: number | null;
  created_at?: number;
}

export interface EvidenceResult {
  evidence: EvidenceRow[];
}

/** Error envelope (protocol 2): code is optional and machine-readable. */
export interface ErrorEnvelope {
  ok: false;
  error: string;
  code?: string | undefined;
}

export interface StatsResult {
  [key: string]: unknown;
}

// ============================================================================
// Session claim bookkeeping (used by /memory display and the turn hint)
// ============================================================================

export interface UsedClaim {
  claim_id: string | number | undefined;
  key: string;
  text: string;
  confidence: number | undefined;
  verify_cmd: string | undefined;
}

export interface ClaimRegistry {
  record(claim: RetrievedClaim): void;
  recordGuardHit(guard: GuardResult): void;
  list(): UsedClaim[];
  find(idOrKey: string): UsedClaim | undefined;
}

export function createClaimRegistry(): ClaimRegistry {
  const byKey = new Map<string, UsedClaim>();
  return {
    record(claim: RetrievedClaim): void {
      const entry: UsedClaim = {
        claim_id: claim.id,
        key: claim.key,
        text: claim.text,
        confidence: claim.confidence,
        verify_cmd: claim.verify_cmd ?? undefined,
      };
      byKey.set(claim.key, entry);
      if (claim.id !== undefined) byKey.set(String(claim.id), entry);
    },
    // Guard hits only carry claim_id and message; keep them as minimal
    // entries so /memory list covers blocked and reminded calls too.
    recordGuardHit(guard: GuardResult): void {
      const id = guard.claim_id;
      if (id === undefined || id === null) return;
      const key = String(id);
      if (byKey.has(key)) return;
      byKey.set(key, {
        claim_id: id,
        key,
        text: guard.message ?? "",
        confidence: undefined,
        verify_cmd: undefined,
      });
    },
    list(): UsedClaim[] {
      const seen = new Set<UsedClaim>();
      const out: UsedClaim[] = [];
      for (const entry of byKey.values()) {
        if (!seen.has(entry)) {
          seen.add(entry);
          out.push(entry);
        }
      }
      return out;
    },
    find(idOrKey: string): UsedClaim | undefined {
      return byKey.get(idOrKey);
    },
  };
}

// ============================================================================
// Journal
// ============================================================================

export type JournalOp = "capture" | "import_events";

export interface JournalEntry {
  seq: number;
  op: JournalOp;
  args: Record<string, unknown>;
  origin_key?: string | undefined;
  ts?: number | string | undefined;
}

function readJournal(journalPath: string): JournalEntry[] {
  if (!existsSync(journalPath)) return [];
  const entries: JournalEntry[] = [];
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as Partial<JournalEntry>;
      // A torn tail line from a crash is skipped. Its event is still
      // covered by at-least-once replay only if a full line was written,
      // which is why appends are single writeFileSync calls.
      if (typeof parsed.seq === "number" && parsed.op !== undefined && parsed.args !== undefined) {
        entries.push({
          seq: parsed.seq,
          op: parsed.op,
          args: parsed.args,
          origin_key: parsed.origin_key,
          ts: parsed.ts,
        });
      }
    } catch {
      // skip corrupt line
    }
  }
  return entries;
}

function appendJournal(journalPath: string, entry: JournalEntry): void {
  mkdirSync(path.dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
}

// ============================================================================
// Paths
// ============================================================================

export function projectSlug(projectRoot: string): string {
  const base = path.basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash = createHash("sha1").update(projectRoot).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

function defaultDataDir(): string {
  // USERPROFILE is the reliable home on Windows Git Bash environments.
  const home = os.platform() === "win32" ? (process.env.USERPROFILE ?? os.homedir()) : os.homedir();
  return path.join(home, ".pi", "agent", "memloop");
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
}

// ============================================================================
// Python discovery
// ============================================================================

export interface PythonCandidate {
  command: string;
}

/** The packaged runtime root: `<app resources>/runtime`, empty outside Electron. */
function packagedRuntimeDir(): string | undefined {
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  if (typeof resources !== "string" || resources === "") return undefined;
  return path.join(resources, "runtime");
}

/** The packaged memloop package root: `<app resources>/runtime/memloop-py`. */
export function packagedMemloopPythonPath(): string | undefined {
  const runtime = packagedRuntimeDir();
  if (runtime === undefined) return undefined;
  return path.join(runtime, "memloop-py");
}

function parsePythonVersion(output: string): { major: number; minor: number } | undefined {
  const m = /Python\s+(\d+)\.(\d+)/.exec(output);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function candidateCommands(): string[] {
  const candidates: string[] = [];
  const runtime = packagedRuntimeDir();
  if (runtime !== undefined) {
    // The bundled python-build-standalone runtime ships next to the app resources.
    candidates.push(
      path.join(runtime, "python", "python.exe"),
      path.join(runtime, "python", "bin", "python3"),
    );
  }
  const fromEnv = process.env.MEMLOOP_PYTHON;
  if (fromEnv !== undefined && fromEnv.trim() !== "") candidates.push(fromEnv.trim());
  candidates.push("py", "python3", "python");
  return candidates;
}

export function discoverPython(): PythonCandidate | undefined {
  for (const command of candidateCommands()) {
    try {
      const res = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 });
      if (res.status !== 0) continue;
      const version = parsePythonVersion(`${res.stdout ?? ""}${res.stderr ?? ""}`);
      if (version && (version.major > 3 || (version.major === 3 && version.minor >= 11))) {
        return { command };
      }
    } catch {
      // candidate not executable, try the next one
    }
  }
  return undefined;
}

interface ServeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * PYTHONPATH resolution: the packaged memloop-py first (zero-setup installs),
 * then MEMLOOP_HOME / a sibling memloop checkout for development runs.
 */
function resolveMemloopPythonPath(extensionDir: string): string {
  const packaged = packagedMemloopPythonPath();
  if (packaged !== undefined && existsSync(packaged)) return packaged;
  // MEMLOOP_HOME points at the memloop repo root; otherwise the extension
  // sits at <memloop-root>/pi-bridge, so the root is its parent directory.
  // The product bridge (<bridge-root>/src or /dist) vendors the package at
  // <bridge-root>/python, so that layout is probed too.
  const home = process.env.MEMLOOP_HOME ?? path.dirname(extensionDir);
  const srcLayout = path.join(home, "src", "memloop", "serve.py");
  const flatLayout = path.join(home, "memloop", "serve.py");
  const vendoredLayout = path.join(home, "python", "memloop", "serve.py");
  return existsSync(srcLayout)
    ? path.join(home, "src")
    : existsSync(flatLayout)
      ? home
      : existsSync(vendoredLayout)
        ? path.join(home, "python")
        : path.join(home, "src");
}

function resolveServeLaunch(
  python: PythonCandidate,
  extensionDir: string,
  dbPath: string,
  projectRoot: string,
  verdictCmd: string | undefined,
): ServeLaunch {
  const pythonPath = resolveMemloopPythonPath(extensionDir);
  const args = ["-m", "memloop.serve", "--db", dbPath, "--project", projectRoot];
  if (verdictCmd !== undefined) args.push("--verdict-cmd", verdictCmd);
  const prior = process.env.PYTHONPATH;
  const env: Record<string, string> = {
    ...process.env,
    PYTHONPATH:
      prior !== undefined && prior !== "" ? `${pythonPath}${path.delimiter}${prior}` : pythonPath,
    // serve.py must flush each JSONL response as it is produced.
    PYTHONUNBUFFERED: "1",
  };
  return { command: python.command, args, env };
}

// ============================================================================
// Client
// ============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MemloopSidecarOptions {
  projectRoot: string;
  sessionKey: string;
  /** Directory containing the extension entry (memloop.ts). */
  extensionDir: string;
  verdictCmd?: string | undefined;
  dataDir?: string | undefined;
  /** Test seam: run a stand-in process instead of the Python sidecar. */
  sidecarCommand?: string | undefined;
  sidecarArgs?: string[] | undefined;
  onDiagnostic?: ((line: string) => void) | undefined;
}

class TransportError extends Error {
  readonly transport = true;
}

function isTransportError(err: unknown): boolean {
  return err instanceof TransportError;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CLOSE_EPISODE_TIMEOUT_MS = 180_000;
const SHUTDOWN_GRACE_MS = 3_000;

export class MemloopSidecar {
  readonly projectRoot: string;
  readonly sessionKey: string;
  readonly extensionDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly journalPath: string;
  readonly policyPath: string;
  readonly verdictCmd: string | undefined;

  private readonly sidecarCommand: string | undefined;
  private readonly sidecarArgs: string[] | undefined;
  private readonly onDiagnostic: ((line: string) => void) | undefined;

  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<boolean> | undefined;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private journalSeq = 0;
  private watermark = 0;
  private stderrTail: string[] = [];

  constructor(options: MemloopSidecarOptions) {
    this.projectRoot = options.projectRoot;
    this.sessionKey = options.sessionKey;
    this.extensionDir = options.extensionDir;
    this.verdictCmd = options.verdictCmd;
    this.sidecarCommand = options.sidecarCommand;
    this.sidecarArgs = options.sidecarArgs;
    this.onDiagnostic = options.onDiagnostic;
    const dataDir = options.dataDir ?? defaultDataDir();
    this.dataDir = dataDir;
    // serve.py opens the sqlite file inside dataDir on startup; the
    // directory must exist before the handshake (the journal writer
    // creates only its own subdirectory).
    mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, `${projectSlug(options.projectRoot)}.db`);
    this.journalPath = path.join(dataDir, "journal", `${safeFileName(options.sessionKey)}.jsonl`);
    this.policyPath = path.join(dataDir, "policy.json");
    for (const entry of readJournal(this.journalPath)) {
      if (entry.seq > this.journalSeq) this.journalSeq = entry.seq;
    }
  }

  // -------------------------------------------------------------- lifecycle

  async ensureReady(): Promise<boolean> {
    if (this.child !== undefined) return true;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(): Promise<boolean> {
    let command: string;
    let args: string[];
    let env: Record<string, string>;
    if (this.sidecarCommand !== undefined) {
      command = this.sidecarCommand;
      args = this.sidecarArgs ?? [];
      env = { ...process.env } as Record<string, string>;
    } else {
      const python = discoverPython();
      if (python === undefined) return false;
      const launch = resolveServeLaunch(
        python,
        this.extensionDir,
        this.dbPath,
        this.projectRoot,
        this.verdictCmd,
      );
      command = launch.command;
      args = launch.args;
      env = launch.env;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: this.projectRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.diagnostic(`memloop sidecar spawn failed: ${String(err)}`);
      return false;
    }
    this.child = child;
    this.stderrTail = [];
    child.on("error", (err) => {
      this.diagnostic(`memloop sidecar error: ${String(err)}`);
      this.dropChild(new TransportError(`memloop sidecar error: ${String(err)}`));
    });
    child.on("exit", (code, signal) => {
      this.diagnostic(`memloop sidecar exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      this.dropChild(
        new TransportError(
          `memloop sidecar exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        this.diagnostic(line);
      }
    });
    child.stdout.setEncoding("utf8");
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line: string) => this.handleLine(line));
    // Handshake: adopt the sidecar watermark, then replay unacknowledged
    // journal entries. Duplicates are absorbed by origin_key idempotency.
    try {
      const state = await this.requestOnce<GetStateResult>("get_state", {
        session_key: this.sessionKey,
      });
      this.watermark = typeof state.watermark_seq === "number" ? state.watermark_seq : 0;
      await this.replayJournal();
      return true;
    } catch (err) {
      this.diagnostic(`memloop sidecar handshake failed: ${String(err)}`);
      this.dropChild();
      return false;
    }
  }

  private dropChild(err?: Error): void {
    const child = this.child;
    this.child = undefined;
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(err ?? new TransportError("memloop sidecar unavailable"));
      this.pending.delete(id);
    }
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  private diagnostic(line: string): void {
    if (this.onDiagnostic !== undefined) this.onDiagnostic(line);
  }

  // --------------------------------------------------------------- requests

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      this.diagnostic(`memloop sidecar sent unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof parsed.id !== "number") return;
    const req = this.pending.get(parsed.id);
    if (req === undefined) return;
    this.pending.delete(parsed.id);
    clearTimeout(req.timer);
    if (parsed.ok === true) {
      req.resolve(parsed.result);
    } else {
      req.reject(
        new Error(typeof parsed.error === "string" ? parsed.error : "memloop sidecar error"),
      );
    }
  }

  private async requestOnce<T>(
    op: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const child = this.child;
    if (child === undefined) throw new TransportError("memloop sidecar unavailable");
    const id = ++this.requestId;
    const line = `${JSON.stringify({ id, op, args })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`memloop sidecar timeout: ${op}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new TransportError(`memloop sidecar write failed: ${String(err)}`));
        }
      });
    });
  }

  async request<T>(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ready = await this.ensureReady();
      // Non-transport failure (no Python, spawn refused): retrying start
      // would only repeat the same discovery result.
      if (!ready) throw new Error("memloop sidecar unavailable");
      try {
        return await this.requestOnce<T>(op, args, timeoutMs);
      } catch (err) {
        if (attempt === 1 || !isTransportError(err)) throw err;
        this.dropChild();
      }
    }
    throw new Error("memloop sidecar request failed");
  }

  // ------------------------------------------------------------- operations

  async ping(): Promise<unknown> {
    return this.request<unknown>("ping", {});
  }

  async capture(args: CaptureArgs): Promise<CaptureResult> {
    const seq = ++this.journalSeq;
    const full: Record<string, unknown> = {
      kind: args.kind,
      payload: args.payload,
      // Numeric epoch seconds on the wire: the store keeps a float ts
      // column, so ISO strings would mix types in sqlite.
      ts: toEpochSeconds(args.ts) ?? Date.now() / 1000,
      origin_key: args.origin_key,
      session: args.session ?? this.sessionKey,
    };
    appendJournal(this.journalPath, {
      seq,
      op: "capture",
      args: full,
      origin_key: args.origin_key,
      ts: typeof full.ts === "number" ? full.ts : undefined,
    });
    const result = await this.requestOnce<CaptureResult>("capture", full);
    this.ack(seq);
    return result;
  }

  async cardify(args: CardifyArgs): Promise<CardifyResult> {
    const record: Record<string, unknown> = {
      event_id: args.event_id,
      key: args.key,
    };
    if (args.text !== undefined) record.text = args.text;
    if (args.claim_kind !== undefined) record.claim_kind = args.claim_kind;
    if (args.verify_cmd !== undefined) record.verify_cmd = args.verify_cmd;
    if (args.match_pattern !== undefined) record.match_pattern = args.match_pattern;
    const raw = await this.request<unknown>("cardify", record);
    const rec = asRecord(raw);
    return { claim: normalizeClaim(rec.claim) ?? null };
  }

  async retrieve(args: {
    context: string;
    limit?: number | undefined;
    ctx_embedding?: number[] | undefined;
    ctx_model?: string | undefined;
  }): Promise<RetrieveResult> {
    const record: Record<string, unknown> = { context: args.context };
    if (args.limit !== undefined) record.limit = args.limit;
    if (args.ctx_embedding !== undefined) record.ctx_embedding = args.ctx_embedding;
    if (args.ctx_model !== undefined) record.ctx_model = args.ctx_model;
    const raw = await this.request<unknown>("retrieve", record);
    return normalizeRetrieve(raw);
  }

  async guard(args: GuardArgs): Promise<GuardResult> {
    const raw = await this.request<unknown>("guard", {
      tool_name: args.tool_name,
      args: args.args,
      call_key: args.call_key,
    });
    return normalizeGuard(raw);
  }

  async override(args: {
    claim_id: string | number;
    reason: string;
    call_key?: string | undefined;
  }): Promise<OverrideResult> {
    const record: Record<string, unknown> = { claim_id: args.claim_id, reason: args.reason };
    if (args.call_key !== undefined) record.call_key = args.call_key;
    return this.request<OverrideResult>("override", record);
  }

  async verify(args: { claim_id: string | number }): Promise<VerifyResult> {
    const raw = await this.request<unknown>("verify", { claim_id: args.claim_id });
    const rec = asRecord(raw);
    return {
      ok: rec.ok === true,
      falsified: rec.falsified === true,
      status: normalizeVerifyStatus(rec.status),
    };
  }

  async getClaim(args: { claim_id: string | number }): Promise<GetClaimResult> {
    const raw = await this.request<unknown>("get_claim", { claim_id: args.claim_id });
    const rec = asRecord(raw);
    const claim = normalizeClaim(rec.claim);
    return { claim: claim !== undefined ? claim : null };
  }

  async deleteClaim(args: DeleteClaimArgs): Promise<DeleteClaimResult> {
    const record: Record<string, unknown> = { claim_id: args.claim_id };
    if (args.purge_events !== undefined) record.purge_events = args.purge_events;
    const raw = await this.request<unknown>("delete_claim", record);
    const rec = asRecord(raw);
    return { deleted: rec.deleted === true };
  }

  async noticesFlush(args: { episode_id?: string | undefined }): Promise<NoticesFlushResult> {
    const record: Record<string, unknown> = {};
    if (args.episode_id !== undefined) record.episode_id = args.episode_id;
    const raw = await this.request<unknown>("notices_flush", record);
    const rec = asRecord(raw);
    return { notices: Array.isArray(rec.notices) ? normalizeNotices(rec.notices) : [] };
  }

  async search(args: SearchArgs): Promise<SearchResult> {
    const record: Record<string, unknown> = { query: args.query };
    if (args.k !== undefined) record.k = args.k;
    if (args.ctx_embedding !== undefined) record.ctx_embedding = args.ctx_embedding;
    if (args.ctx_model !== undefined) record.ctx_model = args.ctx_model;
    const raw = await this.request<unknown>("search", record);
    return { claims: normalizeClaims(raw) };
  }

  async setEmbedding(args: SetEmbeddingArgs): Promise<SetEmbeddingResult> {
    const raw = await this.request<unknown>("set_embedding", {
      claim_id: args.claim_id,
      vector: args.vector,
      model: args.model,
    });
    const rec = asRecord(raw);
    return { stored: rec.stored === true };
  }

  async classifySignal(args: { text: string }): Promise<ClassifySignalResult> {
    const raw = await this.request<unknown>("classify_signal", { text: args.text });
    const rec = asRecord(raw);
    const signal = rec.signal;
    if (signal === "correction" || signal === "affirmation" || signal === "none") return { signal };
    return { signal: "none" };
  }

  async beginTask(args: {
    prompt: string;
    session?: string | undefined;
  }): Promise<BeginTaskResult> {
    const record: Record<string, unknown> = { prompt: args.prompt };
    record.session = args.session ?? this.sessionKey;
    const raw = await this.request<BeginTaskResult>("begin_task", record);
    const rec = asRecord(raw);
    return {
      episode_id:
        typeof rec.episode_id === "string" ? rec.episode_id : String(rec.episode_id ?? ""),
    };
  }

  async closeEpisode(args: CloseEpisodeArgs): Promise<CloseEpisodeResult> {
    const record: Record<string, unknown> = {};
    if (args.verdict_cmd !== undefined) record.verdict_cmd = args.verdict_cmd;
    const raw = await this.request<unknown>("close_episode", record, CLOSE_EPISODE_TIMEOUT_MS);
    const rec = asRecord(raw);
    const claimIds = Array.isArray(rec.claim_ids) ? (rec.claim_ids as Array<string | number>) : [];
    return {
      verdict: typeof rec.verdict === "string" ? rec.verdict : String(rec.verdict ?? "unknown"),
      claim_ids: claimIds,
      applied: rec.applied === true,
    };
  }

  async episodeSignal(args: { signal: "correction" | "affirmation" }): Promise<unknown> {
    return this.request<unknown>("episode_signal", { signal: args.signal });
  }

  /** Model-labeled feedback (plan 8): shares the episode_signal books. */
  async memorySignal(args: MemorySignalArgs): Promise<MemorySignalResult> {
    const record: Record<string, unknown> = { signal: args.signal, text: args.text };
    if (args.reason !== undefined) record.reason = args.reason;
    if (args.episode_id !== undefined) record.episode_id = args.episode_id;
    const raw = await this.request<unknown>("memory_signal", record);
    const rec = asRecord(raw);
    const result: MemorySignalResult = { skipped: rec.skipped === true };
    if (typeof rec.applied === "boolean") result.applied = rec.applied;
    if (Array.isArray(rec.claim_ids)) result.claim_ids = toIds(rec.claim_ids);
    if (rec.claim !== undefined) result.claim = normalizeClaim(rec.claim) ?? null;
    return result;
  }

  async consolidate(): Promise<unknown> {
    return this.request<unknown>("consolidate", {});
  }

  /** P3 promote confirm flow (plan 5.1): live candidate listing. */
  async promoteCandidates(): Promise<PromoteCandidatesResult> {
    const raw = await this.request<unknown>("promote_candidates", {});
    const rec = asRecord(raw);
    const list = Array.isArray(rec.candidates) ? rec.candidates : [];
    return { candidates: list.map(normalizePromoteCandidate) };
  }

  /** The contract draft behind the confirm path: commands 全文 + hash. */
  async promoteRequest(args: { claim_id: string | number }): Promise<PromoteRequestResult> {
    const raw = await this.request<unknown>("promote_request", {
      claim_id: args.claim_id,
    });
    return { draft: normalizePromoteDraft(asRecord(raw).draft) };
  }

  /** The single skill-write port: forwards the user's approve/reject.
   * content_hash binds a commands-carrying commit to the draft's exact
   * bytes (the server refuses a stale one with code hash_mismatch). */
  async promoteCommit(args: {
    claim_id: string | number;
    approved: boolean;
    content_hash?: string | null | undefined;
  }): Promise<PromoteCommitResult> {
    const raw = await this.request<unknown>("promote_commit", {
      claim_id: args.claim_id,
      approved: args.approved,
      content_hash: args.content_hash ?? null,
    });
    const rec = asRecord(raw);
    return {
      claim_id: rec.claim_id as string | number,
      decision: typeof rec.decision === "string" ? rec.decision : undefined,
      override: rec.override === true,
      veto: Array.isArray(rec.veto) ? (rec.veto as string[]) : [],
      state: rec.state === "rejected" ? "rejected" : "approved",
      path: typeof rec.path === "string" ? rec.path : null,
      commands: Array.isArray(rec.commands) ? (rec.commands as string[]) : [],
      content_hash: typeof rec.content_hash === "string" ? rec.content_hash : null,
      claim: normalizeClaim(rec.claim) ?? null,
    };
  }

  /** P3 /memory audit (plan 5.3): trace set differences, no re-scoring. */
  async audit(): Promise<AuditResult> {
    const raw = await this.request<unknown>("audit", {});
    const rec = asRecord(raw);
    return {
      missed: (Array.isArray(rec.missed) ? rec.missed : []).map((item) => {
        const r = asRecord(item);
        return {
          claim_id: r.claim_id as string | number,
          key: typeof r.key === "string" ? r.key : null,
          count: typeof r.count === "number" ? r.count : 0,
        };
      }),
      false_triggers: (Array.isArray(rec.false_triggers) ? rec.false_triggers : []).map((item) => {
        const r = asRecord(item);
        return {
          claim_id: r.claim_id as string | number,
          key: typeof r.key === "string" ? r.key : null,
          episode_id: typeof r.episode_id === "string" ? r.episode_id : null,
        };
      }),
    };
  }

  /** P3 /memory show backing (plan 5.3): one claim's full disclosure. */
  async claimDetail(args: { claim_id: string | number }): Promise<ClaimDetailResult> {
    const raw = await this.request<unknown>("claim_detail", {
      claim_id: args.claim_id,
    });
    const rec = asRecord(raw);
    const lineage = asRecord(rec.lineage);
    return {
      claim: normalizeClaim(rec.claim) ?? null,
      lineage: Object.keys(lineage).length > 0 ? lineage : null,
      chain: (Array.isArray(rec.chain) ? rec.chain : []).map((item) => {
        const r = asRecord(item);
        return {
          id: r.id as string | number,
          key: typeof r.key === "string" ? r.key : undefined,
          status: typeof r.status === "string" ? r.status : undefined,
          status_reason: typeof r.status_reason === "string" ? r.status_reason : undefined,
          created_at: typeof r.created_at === "number" ? r.created_at : undefined,
        };
      }),
      contract: normalizeContract(rec.contract),
      evidence: Array.isArray(rec.evidence) ? (rec.evidence as EvidenceRow[]) : [],
      notices: Array.isArray(rec.notices) ? normalizeNotices(rec.notices) : [],
    };
  }

  async runDream(args: {
    force?: boolean | undefined;
    rollback?: boolean | undefined;
  }): Promise<RunDreamResult> {
    const record: Record<string, unknown> = {};
    if (args.force !== undefined) record.force = args.force;
    if (args.rollback !== undefined) record.rollback = args.rollback;
    const raw = await this.request<unknown>("run_dream", record, CLOSE_EPISODE_TIMEOUT_MS);
    const rec = asRecord(raw);
    // Keep every field: /dreaming renders policy diffs from them.
    return { ...rec, ran: rec.ran === true };
  }

  async stats(): Promise<StatsResult> {
    const raw = await this.request<unknown>("stats", {});
    return asRecord(raw);
  }

  async getState(): Promise<GetStateResult> {
    const raw = await this.request<unknown>("get_state", { session_key: this.sessionKey });
    const rec = asRecord(raw);
    return {
      watermark_seq: typeof rec.watermark_seq === "number" ? rec.watermark_seq : 0,
      protocol: typeof rec.protocol === "number" ? rec.protocol : undefined,
    };
  }

  // Journal-first import: the batch is journaled before it is sent so a crash
  // between send and ack is replayed later, exactly like capture().
  async importEvents(events: ImportEvent[]): Promise<ImportEventsResult> {
    const ready = await this.ensureReady();
    if (!ready) throw new Error("memloop sidecar unavailable");
    const journaled: ImportEvent[] = [];
    for (const event of events) {
      const seq = event.seq > 0 ? event.seq : ++this.journalSeq;
      if (seq > this.journalSeq) this.journalSeq = seq;
      const ts = toEpochSeconds(event.ts);
      const args: Record<string, unknown> = {
        seq,
        kind: event.kind,
        payload: event.payload,
        ts,
        origin_key: event.origin_key,
      };
      appendJournal(this.journalPath, {
        seq,
        op: "import_events",
        args,
        origin_key: event.origin_key,
        ts,
      });
      journaled.push({ ...event, seq, ts });
    }
    return this.sendImportBatch(journaled);
  }

  private async sendImportBatch(events: ImportEvent[]): Promise<ImportEventsResult> {
    if (events.length === 0) return { imported: 0 };
    // requestOnce, not request: this also runs during start() replay, where
    // awaiting ensureReady() would deadlock on the in-flight start promise.
    const raw = await this.requestOnce<unknown>("import_events", {
      session_key: this.sessionKey,
      events,
    });
    const rec = asRecord(raw);
    let maxSeq = this.watermark;
    for (const event of events) {
      if (event.seq > maxSeq) maxSeq = event.seq;
    }
    this.ack(maxSeq);
    return { imported: typeof rec.imported === "number" ? rec.imported : events.length };
  }

  private ack(seq: number): void {
    if (seq > this.watermark) this.watermark = seq;
  }

  // Recovery source is this journal alone. The session JSONL is deliberately
  // not replayed on resume: it would introduce a second event key space next
  // to origin_key, while the journal is written before every send and already
  // gives at-least-once delivery with idempotent re-import.
  private async replayJournal(): Promise<void> {
    const entries = readJournal(this.journalPath).filter((entry) => entry.seq > this.watermark);
    if (entries.length === 0) return;
    const events: ImportEvent[] = [];
    for (const entry of entries) {
      const args = entry.args;
      const kind = typeof args.kind === "string" ? args.kind : "UNKNOWN";
      const payload = asRecord(args.payload);
      events.push({
        seq: entry.seq,
        kind,
        payload,
        ts: toEpochSeconds(args.ts !== undefined ? args.ts : entry.ts),
        origin_key: typeof args.origin_key === "string" ? args.origin_key : entry.origin_key,
      });
    }
    // Batched to bound request size; each batch advances the watermark.
    const BATCH = 200;
    for (let i = 0; i < events.length; i += BATCH) {
      await this.sendImportBatch(events.slice(i, i + BATCH));
    }
  }

  /** Drain pending work, then let serve.py exit on stdin EOF. */
  async shutdown(): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    child.stdin.end();
    try {
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
    } catch {
      // exit listener errors are not actionable
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

// ============================================================================
// Normalization helpers (tolerant readers at the protocol boundary)
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

/** Wire ts is numeric epoch seconds; ISO strings from legacy journals convert. */
function toEpochSeconds(ts: unknown): number | undefined {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed / 1000;
    const asNum = Number(ts);
    if (Number.isFinite(asNum)) return asNum;
  }
  return undefined;
}

function normalizeClaim(value: unknown): RetrievedClaim | undefined {
  const rec = asRecord(value);
  if (typeof rec.key !== "string" || typeof rec.text !== "string") return undefined;
  const claim: RetrievedClaim = { key: rec.key, text: rec.text };
  if (typeof rec.id === "string" || typeof rec.id === "number") claim.id = rec.id;
  if (typeof rec.confidence === "number") claim.confidence = rec.confidence;
  if (typeof rec.verify_cmd === "string") claim.verify_cmd = rec.verify_cmd;
  if (rec.verify_cmd === null) claim.verify_cmd = null;
  if (typeof rec.claim_kind === "string") claim.claim_kind = rec.claim_kind;
  if (typeof rec.hearsay === "boolean") claim.hearsay = rec.hearsay;
  if (typeof rec.status === "string") claim.status = rec.status;
  if (typeof rec.match_pattern === "string") claim.match_pattern = rec.match_pattern;
  if (rec.match_pattern === null) claim.match_pattern = null;
  if (Array.isArray(rec.source_event_ids)) claim.source_event_ids = toIds(rec.source_event_ids);
  if (typeof rec.skill_path === "string") claim.skill_path = rec.skill_path;
  if (rec.skill_path === null) claim.skill_path = null;
  return claim;
}

function toIds(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) return [];
  const out: Array<string | number> = [];
  for (const id of value) {
    if (typeof id === "string" || typeof id === "number") out.push(id);
  }
  return out;
}

function normalizeClaims(value: unknown): RetrievedClaim[] {
  const list = Array.isArray(value)
    ? value
    : (asRecord(value).claims ?? asRecord(value).results ?? asRecord(value).picked);
  if (!Array.isArray(list)) return [];
  const claims: RetrievedClaim[] = [];
  for (const item of list) {
    const claim = normalizeClaim(item);
    if (claim !== undefined) claims.push(claim);
  }
  return claims;
}

// serve.retrieve reports conflicts as a dict {key: [claim_id,...]}; an array
// of entries is accepted too. Both become enumerable {key, claim_ids} entries
// so the renderer can flag every conflicted key and show both sides.
function normalizeConflicts(value: unknown): ConflictEntry[] {
  if (Array.isArray(value)) {
    const entries: ConflictEntry[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        entries.push({ key: item });
        continue;
      }
      const rec = asRecord(item);
      if (typeof rec.key !== "string") continue;
      entries.push({ key: rec.key, claim_ids: toIds(rec.claim_ids) });
    }
    return entries;
  }
  const rec = asRecord(value);
  const entries: ConflictEntry[] = [];
  for (const [key, ids] of Object.entries(rec)) {
    entries.push({ key, claim_ids: toIds(ids) });
  }
  return entries;
}

function normalizeRetrieve(raw: unknown): RetrieveResult {
  const rec = asRecord(raw);
  const result: RetrieveResult = { picked: normalizeClaims(rec.picked) };
  if (rec.conflicts !== undefined) result.conflicts = normalizeConflicts(rec.conflicts);
  if (rec.injected !== undefined) result.injected = rec.injected;
  if (Array.isArray(rec.notices)) result.notices = normalizeNotices(rec.notices);
  return result;
}

function normalizeNotices(value: unknown[]): NoticeRow[] {
  const out: NoticeRow[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (typeof rec.kind !== "string" || typeof rec.text !== "string") continue;
    const row: NoticeRow = { kind: rec.kind, text: rec.text };
    if (typeof rec.id === "number" || typeof rec.id === "string") row.id = rec.id;
    if (typeof rec.claim_id === "string" || typeof rec.claim_id === "number")
      row.claim_id = rec.claim_id;
    if (typeof rec.lineage_anchor === "string") row.lineage_anchor = rec.lineage_anchor;
    if (typeof rec.episode_id === "string") row.episode_id = rec.episode_id;
    if (rec.episode_id === null) row.episode_id = null;
    if (typeof rec.created_at === "number") row.created_at = rec.created_at;
    out.push(row);
  }
  return out;
}

function normalizeVerifyStatus(value: unknown): VerifyStatus | undefined {
  return value === "ok" || value === "falsified" || value === "unknown" || value === "hearsay"
    ? value
    : undefined;
}

function normalizeGuard(raw: unknown): GuardResult {
  const rec = asRecord(raw);
  const level = rec.level;
  const result: GuardResult = {
    level: level === "l1" || level === "l2" ? level : "none",
  };
  if (typeof rec.claim_id === "string" || typeof rec.claim_id === "number")
    result.claim_id = rec.claim_id;
  if (rec.claim_id === null) result.claim_id = null;
  if (typeof rec.message === "string") result.message = rec.message;
  result.blocked = rec.blocked === true;
  return result;
}

function normalizePromoteCandidate(value: unknown): PromoteCandidate {
  const rec = asRecord(value);
  const out: PromoteCandidate = { id: rec.id as string | number };
  if (rec.lineage !== undefined && rec.lineage !== null) {
    const line = asRecord(rec.lineage);
    out.lineage = {
      anchor: (line.anchor ?? null) as string | number | null,
      skill_path: typeof line.skill_path === "string" ? line.skill_path : null,
      last_version: typeof line.last_version === "number" ? line.last_version : 0,
    };
  }
  if (typeof rec.suggest === "string") out.suggest = rec.suggest;
  if (rec.evidence !== undefined && rec.evidence !== null) {
    const ev = asRecord(rec.evidence);
    out.evidence = {
      rows: typeof ev.rows === "number" ? ev.rows : 0,
      wins: typeof ev.wins === "number" ? ev.wins : 0,
      losses: typeof ev.losses === "number" ? ev.losses : 0,
      veto: Array.isArray(ev.veto) ? (ev.veto as string[]) : [],
    };
  }
  return out;
}

function normalizePromoteDraft(value: unknown): PromoteDraft {
  const rec = asRecord(value);
  return {
    claim_id: rec.claim_id as string | number,
    decision: typeof rec.decision === "string" ? rec.decision : undefined,
    suggest: typeof rec.suggest === "string" ? rec.suggest : undefined,
    override: rec.override === true,
    veto: Array.isArray(rec.veto) ? (rec.veto as string[]) : [],
    slug: typeof rec.slug === "string" ? rec.slug : undefined,
    anchor: (rec.anchor ?? undefined) as string | number | undefined,
    version: typeof rec.version === "number" ? rec.version : undefined,
    path: typeof rec.path === "string" ? rec.path : undefined,
    commands: Array.isArray(rec.commands) ? (rec.commands as string[]) : [],
    content_hash: typeof rec.content_hash === "string" ? rec.content_hash : null,
  };
}

function normalizeContract(value: unknown): { path: string; status?: string | null } | null {
  const rec = asRecord(value);
  if (typeof rec.path !== "string") return null;
  return {
    path: rec.path,
    status: typeof rec.status === "string" ? rec.status : null,
  };
}
