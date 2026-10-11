import { SidebarToggleIcon } from "../../ui/icons";
import { t, useLocale } from "../../t";

interface SidebarToggleButtonProps {
  readonly collapsed: boolean;
  readonly shortcutLabel: string;
  readonly onToggle: () => void;
}

export function SidebarToggleButton({
  collapsed,
  shortcutLabel,
  onToggle,
}: SidebarToggleButtonProps) {
  useLocale();
  return (
    <div className="shortcut-tooltip-wrap sidebar-toggle">
      <button
        aria-label={t("Toggle sidebar", "切换侧边栏")}
        aria-pressed={!collapsed}
        className="icon-button sidebar-toggle__button"
        data-testid="sidebar-toggle"
        type="button"
        onClick={onToggle}
      >
        <SidebarToggleIcon />
      </button>
      <span className="shortcut-tooltip sidebar-toggle__tooltip" role="tooltip">
        <span>{t("Toggle sidebar", "切换侧边栏")}</span>
        <kbd>{shortcutLabel}</kbd>
      </span>
    </div>
  );
}
