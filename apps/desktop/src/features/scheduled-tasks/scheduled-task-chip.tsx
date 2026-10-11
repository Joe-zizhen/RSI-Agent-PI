import type { ScheduledTaskRecord } from "../../../contracts/desktop-state";
import { formatScheduledTaskRowMeta } from "../../../contracts/scheduled-tasks";
import { t, useLocale } from "../../t";

interface ScheduledTaskChipProps {
  readonly task: ScheduledTaskRecord;
  readonly onOpen: () => void;
}

export function ScheduledTaskChip({ task, onOpen }: ScheduledTaskChipProps) {
  useLocale();
  return (
    <div className="scheduled-task-chip" data-testid="scheduled-task-chip">
      <span>{formatScheduledTaskRowMeta(task)}</span>
      <button className="button button--secondary" type="button" onClick={onOpen}>
        {t("Open", "打开")}
      </button>
    </div>
  );
}
