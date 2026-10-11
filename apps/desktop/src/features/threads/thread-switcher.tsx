import { useEffect, useRef } from "react";
import type { ThreadSwitcherState } from "./hooks/use-thread-switcher";
import { sessionThreadKey } from "./thread-groups";

interface ThreadSwitcherProps {
  readonly state: ThreadSwitcherState;
  readonly onChoose: (index: number) => void;
}

export function ThreadSwitcher({ state, onChoose }: ThreadSwitcherProps) {
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [state.index]);

  return (
    <div className="thread-switcher" data-testid="thread-switcher">
      <div className="thread-switcher__panel">
        <div className="thread-switcher__title">切换会话</div>
        <ul aria-label="最近会话" className="thread-switcher__list" ref={listRef} role="listbox">
          {state.entries.map((entry, index) => (
            <li
              aria-selected={index === state.index}
              className={`thread-switcher__item${index === state.index ? " thread-switcher__item--selected" : ""}`}
              key={sessionThreadKey(entry)}
              role="option"
              onMouseDown={(event) => {
                // Control-click opens the context menu on macOS; act on press instead.
                event.preventDefault();
                onChoose(index);
              }}
            >
              <span className="thread-switcher__item-title">{entry.session.title}</span>
              <span className="thread-switcher__item-context">{entry.contextLabel}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
