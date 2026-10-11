import { useState } from "react";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { PI_RUNTIME_PINNED_VERSION } from "../../../contracts/ipc";
import { t, useLocale } from "../../t";

/** Settings → 更新: manual update check plus the pinned pi runtime version. */
export function SettingsUpdateSection() {
  useLocale();
  const [checking, setChecking] = useState(false);

  const handleCheck = () => {
    const api = window.piApp;
    if (!api || checking) return;
    setChecking(true);
    void api
      .checkForUpdates()
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  return (
    <SettingsGroup title={t("Update", "更新")}>
      <SettingsRow
        title={t("Check for updates", "检查更新")}
        description={t(
          "Check now for a new version of this app. If one is found, go to the download page.",
          "立即查询本应用的新版本。发现新版本后可前往下载页。",
        )}
      >
        <div className="settings-row__control">
          <button
            className="button button--secondary"
            disabled={checking}
            type="button"
            onClick={handleCheck}
          >
            {checking ? t("Checking…", "检查中…") : t("Checking for updates…", "检查更新…")}
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        title={t("pi runtime", "pi 运行时")}
        description={t(
          "The built-in pi runtime version. It upgrades with app releases and does not auto-update.",
          "内置 pi 运行时版本。随本应用发版升级，不会自动更新。",
        )}
      >
        <span className="settings-row__value">
          {PI_RUNTIME_PINNED_VERSION}
          {t("(pinned)", "（已锁定）")}
        </span>
      </SettingsRow>
    </SettingsGroup>
  );
}
