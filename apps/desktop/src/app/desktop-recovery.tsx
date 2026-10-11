import { Component, Fragment, type ReactNode } from "react";
import type { DesktopAppView, StateHydrationFailure } from "./desktop-app-state";
import { t, useLocale } from "../t";

export type DesktopStartupSurfaceState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly failure: StateHydrationFailure;
      readonly retrying: boolean;
    }
  | { readonly kind: "crashed" };

export interface DesktopStartupCopy {
  readonly title: string;
  readonly body: string;
  readonly status: "loading" | "failed" | "crashed";
}

const LOADING_COPY: DesktopStartupCopy = {
  get title() {
    return t("Loading sessions", "正在加载会话记录");
  },
  get body() {
    return t(
      "The desktop shell is restoring folder and thread state from the main process.",
      "桌面外壳正在从主进程恢复文件夹和会话状态。",
    );
  },
  status: "loading",
};

const STATE_FAILED_COPY: DesktopStartupCopy = {
  get title() {
    return t("Couldn't restore sessions", "无法恢复会话记录");
  },
  get body() {
    return t(
      "The desktop shell couldn't read folder and thread state. Retry, or relaunch the app.",
      "桌面外壳无法读取文件夹和会话状态。请重试，或重新启动应用。",
    );
  },
  status: "failed",
};

const BRIDGE_FAILED_COPY: DesktopStartupCopy = {
  get title() {
    return t("Couldn't restore sessions", "无法恢复会话记录");
  },
  get body() {
    return t(
      "The desktop shell isn't connected. Quit RSI-Agent-PI and reopen it.",
      "桌面外壳未连接。请退出 RSI-Agent-PI 并重新打开。",
    );
  },
  status: "failed",
};

const CRASHED_COPY: DesktopStartupCopy = {
  get title() {
    return t("Something went wrong", "出现问题");
  },
  get body() {
    return t(
      "The desktop window hit an unexpected error. Retry to remount, or relaunch the app.",
      "桌面窗口遇到意外错误。请重试以重新挂载，或重新启动应用。",
    );
  },
  status: "crashed",
};

export function startupSurfaceCopy(state: DesktopStartupSurfaceState): DesktopStartupCopy {
  if (state.kind === "loading") {
    return LOADING_COPY;
  }
  if (state.kind === "crashed") {
    return CRASHED_COPY;
  }
  if (state.failure.code === "bridge-unavailable") {
    return BRIDGE_FAILED_COPY;
  }
  return STATE_FAILED_COPY;
}

export function rendererBoundaryCopy(): DesktopStartupCopy {
  return CRASHED_COPY;
}

interface DesktopStartupSurfaceProps {
  readonly state: DesktopStartupSurfaceState;
  readonly onRetry: () => void;
  readonly onRelaunch?: () => void;
}

export function DesktopStartupSurface({ state, onRetry, onRelaunch }: DesktopStartupSurfaceProps) {
  useLocale();
  const copy = startupSurfaceCopy(state);
  const retrying = state.kind === "failed" ? state.retrying : false;
  const showActions = copy.status !== "loading";
  const showRelaunch =
    Boolean(onRelaunch) &&
    (state.kind === "crashed" ||
      (state.kind === "failed" && state.failure.code !== "bridge-unavailable"));

  return (
    <div className="shell shell--loading">
      <main
        className="loading-card"
        data-testid="shell-status-card"
        data-status={copy.status}
        data-retrying={retrying ? "true" : "false"}
        data-failure={state.kind === "failed" ? state.failure.code : undefined}
      >
        <div className="loading-card__eyebrow">RSI-Agent-PI</div>
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        {showActions ? (
          <div className="loading-card__actions">
            <button
              className="button button--primary"
              data-testid="hydrate-retry"
              type="button"
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? t("Retrying…", "正在重试…") : t("Retry", "重试")}
            </button>
            {showRelaunch ? (
              <button
                className="button button--ghost"
                data-testid="hydrate-relaunch"
                type="button"
                onClick={onRelaunch}
              >
                {t("Relaunch RSI-Agent-PI", "重新启动 RSI-Agent-PI")}
              </button>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

interface RendererErrorBoundaryProps {
  readonly children: ReactNode;
  readonly onRelaunch?: () => void;
}

interface RendererErrorBoundaryState {
  readonly hasError: boolean;
  readonly remountKey: number;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { hasError: false, remountKey: 0 };

  static getDerivedStateFromError(): Pick<RendererErrorBoundaryState, "hasError"> {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("[renderer] render tree failed", error);
  }

  private readonly handleRetry = (): void => {
    this.setState((current) => ({
      hasError: false,
      remountKey: current.remountKey + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <DesktopStartupSurface
          state={{ kind: "crashed" }}
          onRetry={this.handleRetry}
          onRelaunch={this.props.onRelaunch}
        />
      );
    }
    return <Fragment key={this.state.remountKey}>{this.props.children}</Fragment>;
  }
}

export function toStartupSurfaceState(view: DesktopAppView): DesktopStartupSurfaceState {
  if (view.kind === "failed") {
    return view;
  }
  return { kind: "loading" };
}
