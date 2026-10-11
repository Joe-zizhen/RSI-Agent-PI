import { useEffect, useState } from "react";
import { t } from "../../../t";

export function useRunningLabel(startedAt: string | undefined) {
  const [label, setLabel] = useState(() => formatRunningLabel(startedAt));

  useEffect(() => {
    setLabel(formatRunningLabel(startedAt));
    if (!startedAt) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setLabel(formatRunningLabel(startedAt));
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [startedAt]);

  return label;
}

function formatRunningLabel(startedAt: string | undefined): string {
  if (!startedAt) {
    return t("Working…", "工作中…");
  }

  const diffMs = Math.max(0, Date.now() - Date.parse(startedAt));
  const seconds = Math.max(1, Math.floor(diffMs / 1000));
  if (seconds < 60) {
    return t(`Working for ${seconds}s`, `已工作 ${seconds}s`);
  }

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0
    ? t(`Working for ${minutes}m`, `已工作 ${minutes}m`)
    : t(`Working for ${minutes}m ${remaining}s`, `已工作 ${minutes}m ${remaining}s`);
}
