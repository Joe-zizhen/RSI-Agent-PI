/**
 * qa2-5 插件零安装 seeding（计划书阶段 C）
 *
 * 断言：6 包 + 2 安全件随包在位；seeding 幂等（二次运行零动作）；写入
 * settings.json 的是本地相对路径形态，不走网络 npm: 源。
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { isDir, read } from "./helpers";
import { seedBundledPlugins } from "../../electron/persistence/plugin-seeding";

const SIX_PLUGINS = [
  "pi-web-access",
  "pi-subagents",
  "@juicesharp/rpiv-todo",
  "@juicesharp/rpiv-ask-user-question",
  "pi-powerline-footer",
  "@narumitw/pi-usage",
];

test("随包 vendor 布局：6 插件 + 2 安全件 + deps 在位", () => {
  for (const name of SIX_PLUGINS) {
    assert.ok(isDir(`vendor/plugins/${name}`), `vendor 缺插件包 ${name}`);
    assert.ok(
      read(`vendor/plugins/${name}/package.json`).includes(name),
      `${name} 的 package.json 名称不匹配`,
    );
  }
  assert.ok(isDir("vendor/plugins/deps"), "vendor 缺 deps 依赖闭包");
  for (const ext of ["permission-gate.ts", "protected-paths.ts"]) {
    assert.ok(isDir("vendor/extensions"), "vendor 缺 extensions");
    assert.ok(read(`vendor/extensions/${ext}`).length > 0, `安全扩展 ${ext} 缺失`);
  }
  assert.ok(isDir("vendor/plugins/@juicesharp/rpiv-i18n"), "rpiv i18n SDK 未随包（rpiv 插件依赖）");
});

test("seeding 幂等：第二次运行零复制、零追加、settings 不再写", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa2-seed-"));
  try {
    const vendorDir = join(root, "vendor");
    const agentDir = join(root, "agent");
    const writePkg = async (dir: string, name: string): Promise<void> => {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        `${JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./index.ts"] } })}\n`,
      );
      await writeFile(join(dir, "index.ts"), "export default function () {}\n");
    };
    await writePkg(join(vendorDir, "plugins", "pi-web-access"), "pi-web-access");
    await writePkg(join(vendorDir, "plugins", "pi-subagents"), "pi-subagents");
    await writePkg(join(vendorDir, "plugins", "@juicesharp", "rpiv-todo"), "@juicesharp/rpiv-todo");
    await writePkg(join(vendorDir, "plugins", "deps", "jiti"), "jiti");
    await mkdir(join(vendorDir, "extensions"), { recursive: true });
    await writeFile(
      join(vendorDir, "extensions", "permission-gate.ts"),
      "export default () => {};\n",
    );
    await writeFile(
      join(vendorDir, "extensions", "protected-paths.ts"),
      "export default () => {};\n",
    );

    const first = await seedBundledPlugins({ vendorDir, agentDir });
    assert.ok(
      first.seededPackageDirs.length >= 3,
      `首轮应复制包: ${first.seededPackageDirs.length}`,
    );
    assert.ok(first.settingsWritten, "首轮应写 settings.json");
    assert.equal(first.addedPackagesEntries.length, 3, "只应给 3 个插件包追加 packages 条目");
    assert.equal(first.seededExtensionFiles.length, 2, "应落 2 个安全扩展");

    for (const entry of first.addedPackagesEntries) {
      assert.ok(!entry.startsWith("npm:"), `packages 条目不得是 npm: 源: ${entry}`);
      assert.ok(!entry.includes("http"), `packages 条目不得是 URL: ${entry}`);
      assert.ok(
        !entry.startsWith("/") && !/^[A-Za-z]:/.test(entry),
        `条目必须是相对路径: ${entry}`,
      );
    }

    const settingsAfterFirst = await readFile(join(agentDir, "settings.json"), "utf8");
    const second = await seedBundledPlugins({ vendorDir, agentDir });
    assert.deepEqual(second.seededPackageDirs, [], "二次运行又复制了包（不幂等）");
    assert.deepEqual(second.seededExtensionFiles, [], "二次运行又复制了扩展（不幂等）");
    assert.deepEqual(second.addedPackagesEntries, [], "二次运行又追加了 packages 条目");
    assert.equal(second.settingsWritten, false, "二次运行重写了 settings.json");

    const settingsAfterSecond = await readFile(join(agentDir, "settings.json"), "utf8");
    assert.equal(settingsAfterFirst, settingsAfterSecond, "两次运行之间 settings.json 发生变化");

    const settings = JSON.parse(settingsAfterSecond) as { packages: string[] };
    assert.equal(settings.packages.length, 3, `packages 条目数不对: ${settings.packages.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seeding 不覆盖用户已有 packages 条目，不产生重复加载", async () => {
  const root = await mkdtemp(join(tmpdir(), "qa2-seed2-"));
  try {
    const vendorDir = join(root, "vendor");
    const agentDir = join(root, "agent");
    await mkdir(join(vendorDir, "plugins", "pi-web-access"), { recursive: true });
    await writeFile(
      join(vendorDir, "plugins", "pi-web-access", "package.json"),
      JSON.stringify({ name: "pi-web-access", version: "1.0.0" }),
    );
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-web-access@0.38.0"] }),
    );

    const result = await seedBundledPlugins({ vendorDir, agentDir });
    assert.deepEqual(
      result.addedPackagesEntries,
      [],
      "已有 npm: 条目时仍追加了本地条目（会让 pi 双载）",
    );
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      packages: string[];
    };
    assert.deepEqual(settings.packages, ["npm:pi-web-access@0.38.0"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("seeding 只把 6 个插件写进 packages，deps 只作库分发", () => {
  const source = read("apps/desktop/electron/persistence/plugin-seeding.ts");
  const block = source.match(/BUNDLED_PLUGIN_ENTRIES[\s\S]*?\];/);
  assert.ok(block, "BUNDLED_PLUGIN_ENTRIES 不存在");
  const blockSource: string = block[0];
  for (const name of SIX_PLUGINS) {
    assert.ok(blockSource.includes(`"${name}"`), `BUNDLED_PLUGIN_ENTRIES 缺 ${name}`);
  }
  assert.ok(
    !blockSource.includes('"jiti"') && !blockSource.includes("deps"),
    "deps 不应成为 packages 条目",
  );
  assert.ok(source.includes('if (name === "deps") continue;'), "deps 目录未被跳过");
  // 6 个不多不少
  const names = [...blockSource.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual(names.sort(), [...SIX_PLUGINS].sort(), "插件清单与计划的 6 包不一致");
});
