import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);
const proofDir = process.env.PI_APP_CHANGED_FILES_PROOF_DIR;

test("preserves an exact changed-file path through diff and stage actions", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("changed-file-path");
  // NTFS rejects control characters and <>:"/\|?*, and trailing dots or spaces.
  // The names stay weird: edge whitespace, a long mixed-script tail, and punctuation.
  // displayCollisionPath differs from filePath only in invisible leading whitespace.
  const filePath =
    " leading 『quoted』 → destination 测试-文件名 длинное-имя spaces-and-symbols ~!#&'()+,;=@[]{}%-tail-0123456789.txt";
  const displayCollisionPath =
    "\u00a0leading 『quoted』 → destination 测试-文件名 длинное-имя spaces-and-symbols ~!#&'()+,;=@[]{}%-tail-0123456789.txt";
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, filePath), "exact path contents\n", "utf8");
  await writeFile(join(workspacePath, displayCollisionPath), "distinct path contents\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Changed path test");
    await selectSidePanel(window, "审查");

    const diffPanel = window.locator(".diff-panel");
    const changedRows = diffPanel.locator(".diff-panel__file");
    await expect(changedRows).toHaveCount(2);
    const rowPaths = await changedRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-file-path")),
    );
    const changedRow = changedRows.nth(rowPaths.indexOf(filePath));
    await expect(changedRow).toHaveAttribute("data-file-path", filePath);
    expect(await changedRow.locator(".diff-panel__file-path").textContent()).toBe(
      JSON.stringify(filePath),
    );
    expect(await changedRows.locator(".diff-panel__file-path").allTextContents()).toEqual(
      expect.arrayContaining([JSON.stringify(filePath), JSON.stringify(displayCollisionPath)]),
    );

    await changedRow.locator(".diff-panel__file-name").click();
    await expect(
      diffPanel.getByRole("region", { name: "差异", exact: true }).locator(".diff-inline"),
    ).toContainText("exact path contents");

    await changedRow.getByRole("button", { name: "暂存", exact: true }).click();
    await expect(changedRow.getByRole("button", { name: "取消暂存", exact: true })).toBeEnabled();
    await expect(changedRow.getByRole("button", { name: "暂存", exact: true })).toHaveCount(0);

    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "--name-only", "-z", "--", filePath],
      { cwd: workspacePath },
    );
    expect(stdout).toBe(`${filePath}\0`);

    await saveProof(window, "exact-path-staged.png");
  } finally {
    await harness.close();
  }
});

test("shows Git status as unavailable without losing reviewed files", async () => {
  test.setTimeout(30_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("changed-files-reviewed");
  const filePath = "reviewed.txt";
  const gitPath = join(workspacePath, ".git");
  const unavailableGitPath = join(workspacePath, "..", ".git-changed-files-reviewed");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await writeFile(join(workspacePath, filePath), "review this\n", "utf8");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let gitMoved = false;

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Reviewed unavailable status test");
    await selectSidePanel(window, "审查");
    const diffPanel = window.locator(".diff-panel");
    await diffPanel.getByTestId(`diff-panel-reviewed-${filePath}`).click();
    await expect(diffPanel.getByTestId(`diff-panel-reviewed-${filePath}`)).toBeChecked();

    await rename(gitPath, unavailableGitPath);
    gitMoved = true;
    await diffPanel.getByRole("button", { name: /^(Refresh|刷新)$/ }).click();
    await expect(diffPanel.getByTestId("changed-files-unavailable")).toContainText(
      /not a git repository|unavailable/i,
    );
    await expect(diffPanel.getByText("无变更", { exact: true })).toHaveCount(0);
    await saveProof(window, "git-status-unavailable.png");
    await rename(unavailableGitPath, gitPath);
    gitMoved = false;
    await diffPanel
      .getByTestId("changed-files-unavailable")
      .getByRole("button", { name: /^(Retry|重试)$/ })
      .click();
    await expect(diffPanel.getByTestId(`diff-panel-reviewed-${filePath}`)).toBeChecked();
    await expect(diffPanel.getByTestId("diff-panel-counter")).toHaveText(
      /^(Reviewed|已审查)\s*1\s*\/\s*1$/,
    );
  } finally {
    await harness.close();
    if (gitMoved) {
      await rename(unavailableGitPath, gitPath);
    }
  }
});

async function saveProof(window: Page, fileName: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, fileName) });
}
