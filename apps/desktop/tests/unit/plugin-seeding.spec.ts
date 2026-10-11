import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveAgentDir, seedBundledPlugins } from "../../electron/persistence/plugin-seeding";

interface Fixture {
  readonly vendorDir: string;
  readonly agentDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "plugin-seeding-"));
  const vendorDir = join(root, "vendor");
  const agentDir = join(root, "agent");

  await writePackage(join(vendorDir, "plugins", "pi-web-access"), "pi-web-access");
  await writePackage(
    join(vendorDir, "plugins", "@juicesharp", "rpiv-todo"),
    "@juicesharp/rpiv-todo",
  );
  // The rpiv i18n SDK ships with the plugins but is loaded as a library, not as a package entry.
  await writePackage(
    join(vendorDir, "plugins", "@juicesharp", "rpiv-i18n"),
    "@juicesharp/rpiv-i18n",
  );
  await writePackage(join(vendorDir, "plugins", "deps", "jiti"), "jiti");
  await writePackage(
    join(vendorDir, "plugins", "deps", "@js-temporal", "polyfill"),
    "@js-temporal/polyfill",
  );
  await mkdir(join(vendorDir, "extensions"), { recursive: true });
  await writeFile(join(vendorDir, "extensions", "guard.ts"), "export default function () {}\n");
  await writeFile(join(vendorDir, "extensions", "notes.txt"), "not an extension\n");

  return { vendorDir, agentDir };
}

async function writePackage(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./index.ts"] } }, null, 2)}\n`,
  );
  await writeFile(join(dir, "index.ts"), "export default function () {}\n");
}

async function writeSettings(agentDir: string, value: unknown): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function readSettings(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

const EXPECTED_ENTRIES = [
  join("npm", "node_modules", "@juicesharp", "rpiv-todo"),
  join("npm", "node_modules", "pi-web-access"),
];

test("first run seeds packages, shared deps, and extensions into the agent dir", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  await writeSettings(agentDir, { defaultThinkingLevel: "max" });

  const result = await seedBundledPlugins({ vendorDir, agentDir });

  expect(result.addedPackagesEntries).toEqual(EXPECTED_ENTRIES);
  expect(result.settingsWritten).toBe(true);
  expect(result.seededExtensionFiles).toEqual([join(agentDir, "extensions", "guard.ts")]);

  const nodeModules = join(agentDir, "npm", "node_modules");
  for (const name of ["pi-web-access", "jiti"]) {
    await expectFile(join(nodeModules, name, "index.ts"));
  }
  for (const name of ["@juicesharp/rpiv-todo", "@juicesharp/rpiv-i18n", "@js-temporal/polyfill"]) {
    await expectFile(join(nodeModules, ...name.split("/"), "index.ts"));
  }
  await expectFile(join(agentDir, "extensions", "guard.ts"));
  await expectMissing(join(agentDir, "extensions", "notes.txt"));

  const settings = await readSettings(agentDir);
  expect(settings.defaultThinkingLevel).toBe("max");
  expect(settings.packages).toEqual(EXPECTED_ENTRIES);
});

test("second run is a no-op and keeps settings.json byte-identical", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  await seedBundledPlugins({ vendorDir, agentDir });
  const settingsBefore = await readFile(join(agentDir, "settings.json"), "utf8");

  const result = await seedBundledPlugins({ vendorDir, agentDir });

  expect(result.addedPackagesEntries).toEqual([]);
  expect(result.seededPackageDirs).toEqual([]);
  expect(result.seededExtensionFiles).toEqual([]);
  expect(result.settingsWritten).toBe(false);
  expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(settingsBefore);
});

test("an existing npm: entry suppresses the local entry but still seeds files", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  await writeSettings(agentDir, {
    packages: ["npm:pi-web-access", "npm:@juicesharp/rpiv-todo"],
  });

  const result = await seedBundledPlugins({ vendorDir, agentDir });

  expect(result.addedPackagesEntries).toEqual([]);
  expect(result.settingsWritten).toBe(false);
  await expectFile(join(agentDir, "npm", "node_modules", "pi-web-access", "index.ts"));
  expect((await readSettings(agentDir)).packages).toEqual([
    "npm:pi-web-access",
    "npm:@juicesharp/rpiv-todo",
  ]);
});

test("an existing local entry keeps its own install path and is not duplicated", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  const customDir = join(agentDir, "custom", "pi-web-access");
  await mkdir(customDir, { recursive: true });
  await writeFile(join(customDir, "package.json"), JSON.stringify({ name: "pi-web-access" }));
  await writeSettings(agentDir, {
    packages: [
      join("custom", "pi-web-access"),
      join("npm", "node_modules", "@juicesharp", "rpiv-todo"),
    ],
  });

  const result = await seedBundledPlugins({ vendorDir, agentDir });

  expect(result.addedPackagesEntries).toEqual([]);
  expect(result.seededPackageDirs.filter((path) => path.endsWith("pi-web-access"))).toEqual([]);
  // The package is already installed at the entry's own path, so seeding leaves it alone.
  expect(JSON.parse(await readFile(join(customDir, "package.json"), "utf8"))).toEqual({
    name: "pi-web-access",
  });
  await expectMissing(join(agentDir, "npm", "node_modules", "pi-web-access", "index.ts"));
});

test("a corrupt settings.json is left untouched while files still seed", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{ not json ");

  const result = await seedBundledPlugins({ vendorDir, agentDir });

  expect(result.settingsError).toBeTruthy();
  expect(result.settingsWritten).toBe(false);
  expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe("{ not json ");
  await expectFile(join(agentDir, "npm", "node_modules", "pi-web-access", "index.ts"));
});

test("existing settings entries and keys survive a seeding write", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  await writeSettings(agentDir, {
    packages: ["..\\..\\elsewhere\\pi-bridge"],
    defaultThinkingLevel: "max",
    extensions: ["-some-extension.ts"],
  });

  const result = await seedBundledPlugins({ vendorDir, agentDir });

  expect(result.settingsWritten).toBe(true);
  const settings = await readSettings(agentDir);
  expect(settings.defaultThinkingLevel).toBe("max");
  expect(settings.extensions).toEqual(["-some-extension.ts"]);
  expect(settings.packages).toEqual(["..\\..\\elsewhere\\pi-bridge", ...EXPECTED_ENTRIES]);
});

test("PI_APP_SKIP_PLUGIN_SEEDING=1 leaves the agent dir alone", async () => {
  const { vendorDir, agentDir } = await makeFixture();
  process.env.PI_APP_SKIP_PLUGIN_SEEDING = "1";
  try {
    const result = await seedBundledPlugins({ vendorDir, agentDir });
    expect(result.addedPackagesEntries).toEqual([]);
    expect(result.seededPackageDirs).toEqual([]);
    await expectMissing(join(agentDir, "npm", "node_modules", "pi-web-access", "package.json"));
    await expectMissing(join(agentDir, "extensions", "guard.ts"));
  } finally {
    delete process.env.PI_APP_SKIP_PLUGIN_SEEDING;
  }
});

test("resolveAgentDir follows PI_CODING_AGENT_DIR like pi does", () => {
  expect(resolveAgentDir({}, "/home/someone")).toBe(join("/home/someone", ".pi", "agent"));
  expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/someone")).toBe(
    "/tmp/agent",
  );
  expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }, "/home/someone")).toBe(
    join("/home/someone", "custom"),
  );
});

async function expectFile(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  expect(content.length).toBeGreaterThan(0);
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toThrow();
}
