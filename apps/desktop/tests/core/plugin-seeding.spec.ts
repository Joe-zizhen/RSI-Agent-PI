import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

/** The bundled plugin packages, including the rpiv i18n SDK seeded as a library. */
const BUNDLED_PACKAGES = [
  "pi-web-access",
  "pi-subagents",
  "@juicesharp/rpiv-todo",
  "@juicesharp/rpiv-ask-user-question",
  "pi-powerline-footer",
  "@narumitw/pi-usage",
  "@juicesharp/rpiv-i18n",
];

/** The six plugins registered in settings; `@juicesharp/rpiv-i18n` stays a library. */
const SETTINGS_PACKAGES = BUNDLED_PACKAGES.filter((name) => name !== "@juicesharp/rpiv-i18n");

test("first launch seeds the bundled pi plugins and a relaunch does not rewrite settings", async () => {
  test.setTimeout(180_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("plugin-seeding-workspace");
  const agentDir = join(userDataDir, "agent");

  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { PI_APP_SKIP_PLUGIN_SEEDING: "" },
  });
  try {
    const window = await first.firstWindow();
    // The Skills and extensions surface lists the seeded extensions with their toggles.
    await window.getByRole("button", { name: "扩展", exact: true }).click();
    const list = window.getByTestId("extensions-list");
    await expect(list.getByRole("switch", { name: /permission-gate/i })).toBeVisible();
    await expect(list.getByRole("switch", { name: /protected-paths/i })).toBeVisible();
  } finally {
    await first.close();
  }

  for (const name of BUNDLED_PACKAGES) {
    const packageJson = join(agentDir, "npm", "node_modules", name, "package.json");
    expect((await readFile(packageJson, "utf8")).length).toBeGreaterThan(0);
  }
  for (const name of ["jiti", "undici", "@juicesharp/rpiv-config"]) {
    const packageJson = join(agentDir, "npm", "node_modules", name, "package.json");
    expect((await readFile(packageJson, "utf8")).length).toBeGreaterThan(0);
  }
  for (const file of ["permission-gate.ts", "protected-paths.ts"]) {
    const extension = join(agentDir, "extensions", file);
    expect((await readFile(extension, "utf8")).length).toBeGreaterThan(0);
  }

  const settingsRaw = await readFile(join(agentDir, "settings.json"), "utf8");
  const settings = JSON.parse(settingsRaw) as { packages?: unknown };
  const packages = (settings.packages ?? []) as string[];
  expect(packages).toHaveLength(SETTINGS_PACKAGES.length);
  for (const name of SETTINGS_PACKAGES) {
    expect(packages.some((entry) => entry.replaceAll("\\", "/").includes(name))).toBe(true);
  }

  const second = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    agentDir,
    envOverrides: { PI_APP_SKIP_PLUGIN_SEEDING: "" },
  });
  try {
    await second.firstWindow();
  } finally {
    await second.close();
  }

  expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(settingsRaw);
});
