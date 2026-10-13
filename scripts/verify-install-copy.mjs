import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function main() {
  const [readme, siteMetadata, websitePage] = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "apps", "website", "app", "site.ts"), "utf8"),
    readFile(path.join(repoRoot, "apps", "website", "app", "page.tsx"), "utf8"),
  ]);

  // Download channel: README, site metadata and the website all send users to GitHub Releases.
  assert.match(readme, /打开本仓库的 Releases 页/);
  assert.match(
    siteMetadata,
    /Install it from GitHub Releases on macOS, Linux and Windows, or Homebrew on macOS/,
  );
  assert.match(siteMetadata, /RELEASES_URL = `\$\{GITHUB_URL\}\/releases`/);
  assert.match(
    websitePage,
    /Download the latest build from <a href=\{RELEASES_URL\}>GitHub Releases<\/a>/,
  );

  // Windows install method: README and the website both give the setup exe and the portable exe.
  assert.match(readme, /下载 portable 版 exe/);
  assert.match(readme, /setup 版 exe 安装/);
  assert.match(websitePage, /Download the setup \.exe or the portable \.exe from GitHub Releases/);

  // Signing status: README and the website both warn that builds are unsigned and name SmartScreen.
  assert.match(readme, /SmartScreen/);
  assert.match(readme, /当前构建未做代码签名/);
  assert.match(websitePage, /not code-signed yet, so SmartScreen/);

  // Homebrew command name: site metadata defines it once; the website renders that constant
  // and documents the matching upgrade command.
  const brewInstall = siteMetadata.match(/BREW_INSTALL = "([^"]+)"/)?.[1];
  assert.ok(
    brewInstall?.startsWith("brew install --cask "),
    "site.ts must define the Homebrew install command",
  );
  assert.match(websitePage, /command: BREW_INSTALL/);
  assert.match(websitePage, /brew upgrade --cask /);

  assert.match(websitePage, /Building from source is for contributors/);

  assert.doesNotMatch(readme, /Homebrew installation will be published/);
  assert.doesNotMatch(readme, /brew install --cask/);
  assert.doesNotMatch(siteMetadata, /source-install today/);
  assert.doesNotMatch(websitePage, /Run the beta from source/);

  process.stdout.write("Install copy is aligned across README and website.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
