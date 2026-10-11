import { PaneResizeHandle, type PaneWidthBounds } from "../../ui/pane-resize-handle";
import { t, useLocale } from "../../t";

function workbenchBounds(_panel: HTMLElement, main: HTMLElement): PaneWidthBounds {
  const max = Math.floor(Math.min(1200, main.clientWidth * (window.innerWidth <= 980 ? 1 : 0.65)));
  return { min: 320, max };
}

export function WorkbenchResizeHandle({
  onResize,
}: {
  readonly onResize: (width: number) => void;
}) {
  useLocale();
  return (
    <PaneResizeHandle
      className="workbench__resize-handle"
      label={t("Side panel width", "侧边面板宽度")}
      controls="task-workbench"
      edge="left"
      bounds={workbenchBounds}
      onResize={onResize}
    />
  );
}
