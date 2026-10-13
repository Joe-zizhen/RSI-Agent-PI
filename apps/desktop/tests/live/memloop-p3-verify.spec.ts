/**
 * P3 real-Electron verification drive (plan 5.1/5.3 真机手测).
 * Evidence harness, retained: not a regression spec, kept as the checked-in
 * driver for real-surface proof runs (see memloop/docs/v2-scope.md section 10).
 *
 * Covers on the real renderer: /memory audit and /memory show presentation,
 * and (live auth) the memory_promote confirm draft showing the full command
 * list + content hash, plus approve-to-disk.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  createSessionViaIpc,
  getRealAuthConfig,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForSessionByTitle,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { MemloopSidecar } from "../../../../packages/memloop-bridge/src/sidecar.ts";

const here = __dirname;
const packageRoot = path.resolve(here, "..", "..", "..", "..", "packages", "memloop-bridge");
const evidenceDir = path.resolve(packageRoot, "test", ".tmp-p3-verify");
const PY =
  process.env.MEMLOOP_PYTHON ??
  path.join(packageRoot, "..", "..", "apps", "desktop", "runtime", "python", "python.exe");

test("P3: memory audit/show presentation and promote confirm draft on real Electron", async () => {
  test.setTimeout(600_000);
  process.env.MEMLOOP_PYTHON = PY;
  process.env.MEMLOOP_HOME = path.join(packageRoot, "python");
  const auth = getRealAuthConfig();
  const userDataDir = await makeUserDataDir("memloop-p3-");
  const workspacePath = await makeWorkspace("memloop-p3-verify");
  const dbPath = path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    ".pi",
    "agent",
    "memloop",
    `${path
      .basename(workspacePath)
      .replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      )}-${createHash("sha1").update(workspacePath).digest("hex").slice(0, 10)}.db`,
  );
  rmSync(evidenceDir, { recursive: true, force: true });

  // ---- seed the memloop db the desktop extension will open -------------
  const seeder = new MemloopSidecar({
    projectRoot: workspacePath,
    sessionKey: "p3-seed",
    extensionDir: path.join(packageRoot, "src"),
    dataDir: path.dirname(dbPath),
  });
  assertReady(await seeder.ensureReady(), "seeder sidecar must start");
  const mk = async (key: string, text: string, origin: string, pattern?: string) => {
    const ev = await seeder.capture({ kind: "failure_fix", payload: { text }, origin_key: origin });
    const card = await seeder.cardify({
      event_id: ev.event_id,
      key,
      text,
      claim_kind: "experience",
      verify_cmd: "exit 0",
      match_pattern: pattern,
    });
    return card.claim.id as string;
  };
  const win3 = async (text: string) => {
    for (let i = 0; i < 3; i++) {
      await seeder.beginTask({ prompt: "p3 seed" });
      await seeder.retrieve({ context: text, limit: 5 });
      await seeder.closeEpisode({ verdict_cmd: "exit 0" });
    }
  };
  const showId = await mk("p3_show", "用 `make test` 回归验证", "p3:s1");
  await win3("make test 回归验证");
  // a loss episode with injection -> one false trigger; a limited retrieve
  // over two candidates -> the unpicked one is the missed row (candidates - picked)
  const other = await mk("p3_other", "make test 端口配置说明 p3 other", "p3:s2");
  await seeder.beginTask({ prompt: "p3 loss" });
  await seeder.retrieve({ context: "make test 回归验证", limit: 1 });
  await seeder.closeEpisode({ verdict_cmd: "exit 1" });
  // promote + correct showId: contract retire and notices for /memory show.
  // The commit binds to the draft's content hash (D-A): forward it.
  const showDraft = (await seeder.promoteRequest({ claim_id: showId })).draft;
  await seeder.promoteCommit({
    claim_id: showId,
    approved: true,
    content_hash: showDraft.content_hash,
  });
  const corr = await seeder.capture({
    kind: "user_correction",
    payload: { text: "不对，改用新验证流程" },
    origin_key: "p3:s3",
  });
  await seeder.cardify({ event_id: corr.event_id, key: "p3_show", text: "改用新验证流程" });
  // the live promote candidate for the confirm-UI drive
  const promoId = await mk("p3_promo", "打包前执行 `npm run verify` 全量检查", "p3:s4", "npm run ");
  await win3("npm run verify 打包检查");
  await seeder.shutdown();

  // The app installs the copied settings `npm:` packages at startup by
  // spawning npm from the Electron GUI process, which fails on this host
  // (exit 3221225794, STATUS_DLL_INIT_FAILED) and blocks workspace refresh.
  // Install the same specs from the test process first so the drive can run.
  if (auth.enabled) {
    const settings = JSON.parse(
      readFileSync(path.join(auth.sourceDir, "settings.json"), "utf8"),
    ) as { packages?: unknown[] };
    const specs = (settings.packages ?? [])
      .map((entry) =>
        typeof entry === "string" ? entry : String((entry as { source?: string }).source ?? ""),
      )
      .filter((source) => source.startsWith("npm:"))
      .map((source) => source.slice("npm:".length));
    if (specs.length > 0) {
      const npmRoot = path.join(userDataDir, "agent", "npm");
      mkdirSync(npmRoot, { recursive: true });
      execFileSync(
        "cmd.exe",
        ["/c", "npm", "install", ...specs, "--prefix", npmRoot, "--legacy-peer-deps"],
        { stdio: "inherit", timeout: 120_000 },
      );
    }
  }

  // ---- launch the real Electron app ------------------------------------
  // Real-auth runs drive the live confirm conversation through the user's
  // provider. Credential-free runs use the fixture provider that
  // seedAgentDir writes (fake api_key, provider "openai"), which is enough
  // to dispatch the local /memory commands from the composer.
  const provider =
    process.env.PI_GUI_PROVIDER?.trim() || (auth.enabled ? "openai-codex" : "openai");
  const model = process.env.PI_GUI_MODEL?.trim() || (auth.enabled ? "gpt-5.6-luna" : "gpt-5");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    enabledModels: [`${provider}/${model}`],
    ...(auth.enabled ? { realAuthSourceDir: auth.sourceDir } : {}),
  });
  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "P3 verify");
    await selectSession(window, "P3 verify");
    await waitForSessionByTitle(window, workspace.id, "P3 verify");
    const composer = window.getByTestId("composer");
    const notices = window.getByTestId("extension-notices");

    await composer.fill("/memory audit");
    await composer.press("Enter");
    await expect(notices).toContainText("漏召", { timeout: 30_000 });
    await expect(notices).toContainText("误触发");
    await expect(notices).toContainText("p3_other");
    await expect(notices).toContainText("p3_show");
    await window.screenshot({ path: path.join(evidenceDir, "01-memory-audit.png") });

    await composer.fill(`/memory show ${showId}`);
    await composer.press("Enter");
    await expect(notices).toContainText("证据摘要", { timeout: 30_000 });
    await expect(notices).toContainText("谱系链");
    await expect(notices).toContainText("契约");
    await expect(notices).toContainText("通告保留区");
    await expect(notices).toContainText("superseded");
    await window.screenshot({ path: path.join(evidenceDir, "02-memory-show.png") });

    if (!auth.enabled) {
      console.log("P3-DRIVE: no real auth; promote confirm UI not driven");
      return;
    }
    // Live conversation in the D-A shape: the model only calls memory_promote
    // with claim_id. The tool pops ctx.ui.confirm carrying the draft (full
    // command list + content hash); the user approves in the dialog and the
    // TS bridge alone commits, bound to that hash. The model has no approve
    // parameter and cannot self-approve.
    await composer.fill(
      `请调用 memory_promote_list 工具列出记忆升格候选。然后对其中 key 为 p3_promo 的候选调用 memory_promote 工具，claim_id 传 ${promoId}，只传 claim_id 这一个参数。` +
        `memory_promote 会弹出用户确认对话框，批准或拒绝由我在对话框里操作，你不要也无法代替我决定。` +
        `两个工具都调用完成后，只回复一行文字：P3-PROMO-DONE`,
    );
    await composer.press("Enter");
    await expect(window.locator(".timeline-tool").nth(0)).toBeVisible({ timeout: 180_000 });

    // the draft is shown in the confirm dialog before anything is written
    const dialog = window.getByTestId("extension-dialog");
    await expect(dialog).toBeVisible({ timeout: 180_000 });
    await expect(dialog).toContainText("升格草案");
    await expect(dialog).toContainText("命令清单（全文）");
    await expect(dialog).toContainText("npm run verify");
    await expect(window.getByText("命令清单（全文）").first()).toBeVisible();
    await expect(window.getByText("hash").first()).toBeVisible();
    await expect(dialog).toContainText("hash");
    const dialogText = await dialog.innerText();
    const draftHash = /(?:内容 hash：|content hash: )([0-9a-f]{64})/.exec(dialogText)?.[1];
    const skillPath = /(?:契约路径：|contract path: )(.+?SKILL\.md)/.exec(dialogText)?.[1]?.trim();
    if (draftHash === undefined || skillPath === undefined) {
      throw new Error(`dialog must show the content hash and contract path: ${dialogText}`);
    }
    await window.screenshot({ path: path.join(evidenceDir, "03-promote-draft.png") });

    // the user approves on the UI surface (确认 = the confirm dialog's approve button)
    await dialog.getByTestId("extension-dialog-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("P3-PROMO-DONE", { timeout: 180_000 });
    const promoteRow = window
      .locator(".timeline-tool")
      .filter({ hasText: /memory_promote(?!_list)/ });
    await expect(promoteRow).toHaveCount(1);
    await waitForTimelineLayout(window);
    await promoteRow.locator(".timeline-tool__header").click();
    await expect(window.getByText("已批准升格").first()).toBeVisible({ timeout: 30_000 });
    await window.screenshot({ path: path.join(evidenceDir, "04-promote-approved.png") });

    // the approved bytes land on disk, bound to the draft's content hash
    const contract = path.join(workspacePath, ".pi", "skills");
    expect(existsSync(contract), `contract dir must exist at ${contract}`).toBe(true);
    expect(existsSync(skillPath), `contract must exist at ${skillPath}`).toBe(true);
    // write_skill writes LF bytes, so the on-disk bytes hash to the approved
    // draft hash directly (no newline normalization).
    const contractBytes = readFileSync(skillPath);
    expect(contractBytes.toString("utf8")).toContain("npm run verify");
    expect(createHash("sha256").update(contractBytes).digest("hex")).toBe(draftHash);
    console.log("P3-DRIVE: promote confirm + approve verified on real renderer");
  } finally {
    await harness.close();
    rmSync(dbPath, { force: true });
  }
});

function assertReady(ready: boolean, message: string): void {
  if (!ready) throw new Error(message);
}
