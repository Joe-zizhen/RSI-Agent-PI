import { expect, test } from "@playwright/test";
import { decodePersistedUiState } from "../../electron/persistence/app-store-persistence";
import { getLocale, setLocale, t } from "../../src/t";

test.describe("renderer locale helper", () => {
  test.describe.configure({ mode: "serial" });

  test("locale store defaults to zh and t returns the Chinese string", () => {
    expect(getLocale()).toBe("zh");
    expect(t("Language", "语言")).toBe("语言");
  });

  test("writing en is read back and t returns the English string", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("Language", "语言")).toBe("Language");
  });

  test("switching back to zh restores Chinese output", () => {
    setLocale("en");
    setLocale("zh");
    expect(getLocale()).toBe("zh");
    expect(t("Language", "语言")).toBe("语言");
  });

  test("persisted ui-state keeps the locale field and rejects unknown values", () => {
    expect(decodePersistedUiState({ locale: "en" }).locale).toBe("en");
    expect(decodePersistedUiState({ locale: "zh" }).locale).toBe("zh");
    expect(() => decodePersistedUiState({ locale: "fr" })).toThrow(/locale/);
    expect(decodePersistedUiState({}).locale).toBeUndefined();
  });
});
