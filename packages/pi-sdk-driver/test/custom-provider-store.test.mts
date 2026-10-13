import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CustomProviderStore } from "../dist/custom-provider-store.js";

const endpoint = {
  providerId: "local-endpoint",
  baseUrl: "http://localhost:8080/v1",
  models: [{ id: "test-model" }],
};

async function withStore(
  run: (store: CustomProviderStore, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-provider-"));
  // Retain synthetic fixtures for failure inspection, per repository policy.
  const path = join(dir, "models.json");
  await run(new CustomProviderStore(path), path);
}

for (const providers of [[], ["saved-value"], null, false, 0, "saved-value"]) {
  await test(`rejects malformed providers ${JSON.stringify(providers)} without changing bytes`, async () => {
    await withStore(async (store, path) => {
      const original = `${JSON.stringify({ providers, futureSetting: { retained: true } }, null, 4)}\n`;
      await writeFile(path, original);
      for (const operation of [
        () => store.list(),
        () => store.set(endpoint),
        () => store.delete(endpoint.providerId),
      ]) {
        await assert.rejects(operation, /JSON object for providers/);
        assert.equal(await readFile(path, "utf8"), original);
      }
    });
  });
}

await test("missing file or providers supports saving and reopening an endpoint", async () => {
  for (const initial of [undefined, "", '{"futureSetting":{"retained":true}}']) {
    await withStore(async (store, path) => {
      if (initial !== undefined) await writeFile(path, initial);
      assert.deepEqual(await store.list(), []);
      assert.equal(await store.delete(endpoint.providerId), false);
      await store.set(endpoint);
      assert.deepEqual(await new CustomProviderStore(path).list(), [endpoint]);
      if (initial) {
        const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        assert.deepEqual(saved.futureSetting, {
          retained: true,
        });
      }
      assert.equal(await store.delete(endpoint.providerId), true);
      assert.deepEqual(await store.list(), []);
    });
  }
});

await test("set and delete preserve unrelated upstream fields and providers", async () => {
  await withStore(async (store, path) => {
    const original = {
      futureSetting: { retained: true },
      providers: {
        upstream: { api: "future-api", customField: ["preserved"] },
      },
    };
    await writeFile(path, JSON.stringify(original));
    await store.set(endpoint);
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      futureSetting: unknown;
      providers: Record<string, unknown>;
    };
    assert.deepEqual(saved.futureSetting, original.futureSetting);
    assert.deepEqual(saved.providers.upstream, original.providers.upstream);
    assert.equal(await store.delete(endpoint.providerId), true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
  });
});

await test("malformed existing target configs are never overwritten", async () => {
  for (const config of [null, false, 0, "saved-value", [], {}]) {
    await withStore(async (store, path) => {
      const original = JSON.stringify({ providers: { [endpoint.providerId]: config } });
      await writeFile(path, original);
      await assert.rejects(() => store.set(endpoint), /not managed by pi-gui/);
      assert.equal(await store.delete(endpoint.providerId), false);
      assert.equal(await readFile(path, "utf8"), original);
    });
  }
});

await test("the queue recovers once malformed saved data is repaired externally", async () => {
  await withStore(async (store, path) => {
    await writeFile(path, '{"providers":[]}');
    await assert.rejects(() => store.set(endpoint), /JSON object for providers/);
    await writeFile(path, '{"providers":{}}');
    await store.set(endpoint);
    assert.deepEqual(await store.list(), [endpoint]);
  });
});

await test("model capability fields round-trip through models.json", async () => {
  await withStore(async (store, path) => {
    await store.set({
      providerId: "capable-endpoint",
      baseUrl: "http://localhost:8080/v1",
      models: [
        {
          id: "vision-model",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
        { id: "plain-model" },
      ],
    });
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, { models: unknown[] }>;
    };
    assert.deepEqual(saved.providers["capable-endpoint"].models, [
      {
        id: "vision-model",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
      { id: "plain-model" },
    ]);
    assert.deepEqual(await store.list(), [
      {
        providerId: "capable-endpoint",
        baseUrl: "http://localhost:8080/v1",
        models: [
          {
            id: "vision-model",
            input: ["text", "image"],
            reasoning: true,
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
          { id: "plain-model" },
        ],
      },
    ]);
  });
});

await test("entries without capability fields read back as id-only", async () => {
  await withStore(async (store, path) => {
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          "legacy-endpoint": {
            baseUrl: "http://localhost:8080/v1",
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "legacy-model" }, { id: "junk-kinds", input: ["video", "audio"] }],
          },
        },
      }),
    );
    assert.deepEqual(await store.list(), [
      {
        providerId: "legacy-endpoint",
        baseUrl: "http://localhost:8080/v1",
        models: [{ id: "legacy-model" }, { id: "junk-kinds" }],
        warnings: [
          'Model "junk-kinds": unsupported input values: video, audio. Saving this endpoint removes them.',
        ],
      },
    ]);
  });
});

await test("rejects invalid model capability values without changing bytes", async () => {
  await withStore(async (store, path) => {
    const original = '{"providers":{"kept":{"future":"value"}}}';
    await writeFile(path, original);
    for (const model of [
      { id: "m", input: ["video"] },
      { id: "m", input: "text" },
      { id: "m", reasoning: "yes" },
      { id: "m", maxTokens: "4096" },
      { id: "m", contextWindow: 0 },
      { id: "m", contextWindow: -1 },
      { id: "m", contextWindow: 1.5 },
      { id: "m", maxTokens: 0 },
      { id: "m", maxTokens: -1 },
      { id: "m", maxTokens: 2.5 },
    ]) {
      await assert.rejects(
        () =>
          store.set({
            providerId: "bad-caps",
            baseUrl: "http://localhost:8080/v1",
            models: [model],
          }),
        /Model m /,
      );
    }
    assert.equal(await readFile(path, "utf8"), original);
  });
});

await test("saving without a new apiKey keeps the stored key", async () => {
  await withStore(async (store, path) => {
    await store.set({ ...endpoint, apiKey: "sk-original" });
    for (const apiKey of [undefined, "", "   "]) {
      await store.set({ ...endpoint, apiKey });
      const saved = JSON.parse(await readFile(path, "utf8")) as {
        providers: Record<string, { apiKey: string }>;
      };
      assert.equal(saved.providers[endpoint.providerId].apiKey, "sk-original");
    }
    await store.set({ ...endpoint, apiKey: "sk-replaced" });
    const replaced = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, { apiKey: string }>;
    };
    assert.equal(replaced.providers[endpoint.providerId].apiKey, "sk-replaced");
  });
});

await test("saving a new endpoint without an apiKey still writes the placeholder", async () => {
  await withStore(async (store, path) => {
    await store.set({ ...endpoint, apiKey: undefined });
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      providers: Record<string, { apiKey: string }>;
    };
    assert.equal(saved.providers[endpoint.providerId].apiKey, "unused");
    assert.deepEqual(await store.list(), [endpoint]);
  });
});
