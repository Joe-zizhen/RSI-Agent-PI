import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  stubNextOpenDialog,
} from "../helpers/electron-app";

/** 0.85.1 Settings rows use the catalog display name, not the provider id. */
const OPENAI_CATALOG_TITLE = /^OpenAI$/;

test("settings lets the user save an API key for a built-in provider", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-api-key-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["openai/gpt-5", "openai/gpt-4o"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "提供商", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("提供商");

    const availableProviders = window.getByTestId("settings-available-providers");
    await window.getByLabel("搜索提供商").fill("openai");
    const openAiRow = availableProviders.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    });
    // Pi 0.99 added ChatGPT sign-in to OpenAI; the row offers it beside the API key.
    await expect(openAiRow).toContainText("OAuth 或 API key");
    await expect(openAiRow.getByRole("button", { name: "登录" })).toBeVisible();
    await openAiRow.getByRole("button", { name: "设置 API key" }).click();

    const dialog = window.getByTestId("provider-api-key-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("OpenAI API key").fill("test-openai-key");
    await dialog.getByRole("button", { name: "设置 API key" }).click();
    await expect(dialog).toHaveCount(0);

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "已连接" }),
    });
    await expect(connectedProviders).toContainText("OpenAI");
    await expect(connectedProviders).toContainText("API key");
    await expect(connectedProviders.getByRole("button", { name: "管理" })).toBeVisible();

    await window.getByRole("button", { name: "模型", exact: true }).click();
    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "启用的模型" }),
    });
    await expect(
      enabledModels.getByRole("switch", { name: "启用 openai/gpt-5", exact: true }),
    ).toBeChecked();
    await expect(
      enabledModels.getByRole("switch", { name: "启用 openai/gpt-4o", exact: true }),
    ).toBeChecked();
  } finally {
    await harness.close();
  }
});

test("settings shows environment-configured providers as managed externally", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-env-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["openai/gpt-5"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: { OPENAI_API_KEY: "test-openai-env-key" },
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "提供商", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("提供商");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "已连接" }),
    });
    const openAiRow = connectedProviders.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    });
    await expect(openAiRow).toContainText("环境变量");
    await expect(openAiRow.getByRole("button")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("settings keeps models.json provider overrides in the external-config state", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-models-json-workspace");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["openai/gpt-5"],
  });
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          openai: {
            apiKey: "test-openai-models-json-key",
            baseUrl: "https://api.openai.com/v1",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "提供商", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("提供商");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "已连接" }),
    });
    const openAiRow = connectedProviders.locator(".settings-row", {
      has: window.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    });
    await expect(openAiRow).toContainText("外部配置");
    await expect(openAiRow.getByRole("button")).toHaveCount(0);

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "自定义端点" }),
    });
    await expect(customEndpoints).toContainText("暂无自定义端点。");
    await expect(
      customEndpoints.locator(".settings-row", {
        has: window.locator(".settings-row__title", { hasText: /^openai$/ }),
      }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("opening the first workspace from the empty state hydrates provider and model settings without refresh", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-first-workspace");
  await seedAgentDir(agentDir, {
    enabledModels: ["openai/gpt-5", "openai/gpt-4o"],
  });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const emptyState = window.getByTestId("empty-state");
    await expect(emptyState).toBeVisible();

    await stubNextOpenDialog(harness, [workspacePath]);
    await emptyState.getByRole("button", { name: "打开第一个文件夹" }).click();

    await expect(emptyState).toHaveCount(0);
    await expect(window.getByTestId("workspace-list")).toContainText(
      "provider-settings-first-workspace",
    );
    await expect(window.getByTestId("new-thread-composer")).toBeVisible();

    await window.keyboard.press(desktopShortcut(","));
    const settingsSurface = window.getByTestId("settings-surface");
    await expect(settingsSurface).toBeVisible();
    await expect(settingsSurface.getByRole("button", { name: /^(Refresh|刷新)$/ })).toHaveCount(0);

    await window.getByRole("button", { name: "提供商", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("提供商");

    const connectedProviders = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "已连接" }),
    });
    await expect(connectedProviders).toContainText("OpenAI");
    await expect(connectedProviders).toContainText("API key");

    await window.getByRole("button", { name: "模型", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("模型");

    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "启用的模型" }),
    });
    await expect(
      enabledModels.getByRole("switch", { name: "启用 openai/gpt-5", exact: true }),
    ).toBeChecked();
    await expect(
      enabledModels.getByRole("switch", { name: "启用 openai/gpt-4o", exact: true }),
    ).toBeChecked();
  } finally {
    await harness.close();
  }
});

test("providers flags the default model's provider when it is not connected", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("provider-settings-attention-workspace");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "模型", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("模型");
    const unconnected = window.getByTestId("settings-unconnected-model-list");
    await expect(unconnected).toHaveCount(0);
    await window.getByLabel("搜索模型").fill("gpt-4o");
    await expect(
      unconnected.locator(".model-row", { hasText: "openai/gpt-4o" }).first(),
    ).toBeVisible();
    await expect(unconnected.getByRole("switch")).toHaveCount(0);

    await window.getByRole("button", { name: "连接提供商" }).click();
    await expect(window.locator(".view-header__title")).toHaveText("提供商");
    const available = window.getByTestId("settings-available-providers");
    await expect(available.locator(".settings-row")).toHaveCount(8);
    await expect(available.locator(".settings-row").first()).toContainText("OAuth");
    await window.getByRole("button", { name: /^(Show ?\d+ ?more|再显示\d+ ?个)$/ }).click();
    await expect.poll(() => available.locator(".settings-row").count()).toBeGreaterThan(8);

    const attention = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "需要处理" }),
    });
    await expect(
      attention.locator(".settings-row__title", { hasText: OPENAI_CATALOG_TITLE }),
    ).toHaveCount(1);
    await window.getByLabel("搜索提供商").fill("openai");
    await expect(
      window
        .getByTestId("settings-available-providers")
        .locator(".settings-row__title", { hasText: new RegExp(`^${OPENAI_CATALOG_TITLE}$`) }),
    ).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
