import { useState } from "react";
import { SettingsGroup, SettingsRow } from "./settings-utils";
import { PI_RUNTIME_PINNED_VERSION } from "../../../contracts/ipc";

/** Settings → 更新: manual update check plus the pinned pi runtime version. */
export function SettingsUpdateSection() {
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
    <SettingsGroup title="更新">
      <SettingsRow
        title="检查更新"
        description="立即查询本应用的新版本。发现新版本后可前往下载页。"
      >
        <div className="settings-row__control">
          <button
            className="button button--secondary"
            disabled={checking}
            type="button"
            onClick={handleCheck}
          >
            {checking ? "检查中…" : "检查更新…"}
          </button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="pi 运行时"
        description="内置 pi 运行时版本。随本应用发版升级，不会自动更新。"
      >
        <span className="settings-row__value">{PI_RUNTIME_PINNED_VERSION}（已锁定）</span>
      </SettingsRow>
    </SettingsGroup>
  );
}
