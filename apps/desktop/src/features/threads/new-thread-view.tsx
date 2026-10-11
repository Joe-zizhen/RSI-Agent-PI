import {
  useEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { RuntimeSnapshot } from "@rsi-agent-pi/session-driver/runtime-types";
import type { ExtensionFlagValues } from "@rsi-agent-pi/session-driver";
import type {
  ComposerAttachment,
  NewThreadEnvironment,
  WorkspaceRecord,
} from "../../../contracts/desktop-state";
import type { MentionOption } from "../conversation/hooks/use-mention-menu";
import { ArrowUpIcon, PiLogoMark, PlusIcon } from "../../ui/icons";
import {
  modelOptionsEmptyTitle,
  type ComposerSlashCommand,
  type ComposerSlashCommandSection,
  type ComposerSlashOption,
  type ComposerSlashOptionEmptyState,
} from "../conversation/composer-commands";
import { ComposerSurface } from "../conversation/composer-surface";
import { ModelOnboardingNoticeBanner } from "../settings/model-onboarding-notice";
import type {
  ModelOnboardingState,
  ModelOnboardingSettingsSection,
} from "../settings/model-onboarding";
import { ModelSelector } from "../conversation/model-selector";
import { ExtensionFlagsSelector } from "./extension-flags-selector";
import { t, useLocale } from "../../t";

interface NewThreadViewProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly prompt: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly lastError?: string;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly modelOnboarding: ModelOnboardingState;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly slashOptionEmptyState?: ComposerSlashOptionEmptyState;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly MentionOption[];
  readonly selectedMentionIndex: number;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly extensionFlags: ExtensionFlagValues;
  readonly onSetExtensionFlag: (name: string, value: boolean | string) => void;
  readonly onOpenModelSettings: (section: ModelOnboardingSettingsSection) => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onClearSlashCommand: () => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSelectMention: (option: MentionOption) => void;
  readonly onEnableMentionExtension: (
    option: Extract<MentionOption, { kind: "extension" }>,
  ) => void;
  readonly onAddAttachments: (files: File[]) => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onSubmit: () => void;
}

export function NewThreadView({
  workspaces,
  selectedWorkspaceId,
  runtime,
  environment,
  prompt,
  attachments,
  lastError,
  provider,
  modelId,
  thinkingLevel,
  modelOnboarding,
  composerRef,
  activeSlashCommand,
  activeSlashCommandMeta,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  slashOptionEmptyState,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onChangePrompt,
  onSelectEnvironment,
  onSelectWorkspace,
  onSetModel,
  onSetThinking,
  extensionFlags,
  onSetExtensionFlag,
  onOpenModelSettings,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onClearSlashCommand,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSelectMention,
  onEnableMentionExtension,
  onAddAttachments,
  onRemoveAttachment,
  onSubmit,
}: NewThreadViewProps) {
  useLocale();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspace = workspaces.find((entry) => entry.id === selectedWorkspaceId);

  useEffect(() => {
    composerRef.current?.focus();
  }, [composerRef]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }

    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 260)}px`;
  }, [composerRef, prompt]);

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">{t("New thread", "新建会话")}</div>
          <h1>{t("Open a folder first", "先打开一个文件夹")}</h1>
          <p>
            {t(
              "Select a repository from the sidebar first, then start a local or worktree-backed thread.",
              "请先从侧边栏选择一个仓库，然后启动本地会话或基于工作树的会话。",
            )}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas canvas--new-thread">
      <div className="new-thread">
        <div className="new-thread__hero">
          <div className="new-thread__logo" data-testid="new-thread-logo">
            <PiLogoMark />
          </div>
          <div className="new-thread__eyebrow">{t("New thread", "新建会话")}</div>
          <h1 className="new-thread__title">{t("Start building", "开始构建")}</h1>
          <label className="new-thread__workspace-picker">
            <span className="sr-only">{t("Project", "项目")}</span>
            <select
              className="new-thread__workspace"
              value={workspace.id}
              onChange={(event) => onSelectWorkspace(event.target.value)}
            >
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="new-thread__composer composer">
          <div className="conversation conversation--composer">
            <ComposerSurface
              lastError={lastError}
              activeSlashCommand={activeSlashCommand}
              activeSlashCommandMeta={activeSlashCommandMeta}
              topNotice={
                <ModelOnboardingNoticeBanner
                  notice={modelOnboarding.notice}
                  onOpenSettings={onOpenModelSettings}
                />
              }
              queuedMessages={[]}
              composerDraft={prompt}
              setComposerDraft={onChangePrompt}
              composerRef={composerRef}
              attachments={attachments}
              slashSections={slashSections}
              slashOptions={slashOptions}
              selectedSlashCommand={selectedSlashCommand}
              selectedSlashOption={selectedSlashOption}
              showSlashMenu={showSlashMenu}
              showSlashOptionMenu={showSlashOptionMenu}
              slashOptionEmptyState={slashOptionEmptyState}
              onClearSlashCommand={onClearSlashCommand}
              onComposerKeyDown={onComposerKeyDown}
              onComposerPaste={onComposerPaste}
              onComposerDrop={onComposerDrop}
              onEditQueuedMessage={() => undefined}
              onCancelQueuedEdit={() => undefined}
              onRemoveQueuedMessage={() => undefined}
              onSteerQueuedMessage={() => undefined}
              onRemoveAttachment={onRemoveAttachment}
              onSelectSlashCommand={onSelectSlashCommand}
              onSelectSlashOption={onSelectSlashOption}
              showMentionMenu={showMentionMenu}
              mentionOptions={mentionOptions}
              selectedMentionIndex={selectedMentionIndex}
              onSelectMention={onSelectMention}
              onEnableMentionExtension={onEnableMentionExtension}
              textareaLabel={t("New thread prompt", "新建会话输入")}
              textareaTestId="new-thread-composer"
              textareaClassName="new-thread__textarea"
              textareaPlaceholder={t(
                "Ask pi anything, use / for commands and skills",
                "向 pi 提问任何问题，输入 / 可使用命令与技能",
              )}
              footer={
                <NewThreadComposerFooter
                  runtime={runtime}
                  environment={environment}
                  provider={provider}
                  modelId={modelId}
                  thinkingLevel={thinkingLevel}
                  modelOnboarding={modelOnboarding}
                  hasContent={Boolean(prompt.trim() || attachments.length > 0)}
                  fileInputRef={fileInputRef}
                  onSelectEnvironment={onSelectEnvironment}
                  onSetModel={onSetModel}
                  onSetThinking={onSetThinking}
                  extensionFlags={extensionFlags}
                  onSetExtensionFlag={onSetExtensionFlag}
                  onAddAttachments={onAddAttachments}
                  onSubmit={onSubmit}
                />
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}

interface NewThreadComposerFooterProps {
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly modelOnboarding: ModelOnboardingState;
  readonly hasContent: boolean;
  readonly fileInputRef: RefObject<HTMLInputElement | null>;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly extensionFlags: ExtensionFlagValues;
  readonly onSetExtensionFlag: (name: string, value: boolean | string) => void;
  readonly onAddAttachments: (files: File[]) => void;
  readonly onSubmit: () => void;
}

function NewThreadComposerFooter({
  runtime,
  environment,
  provider,
  modelId,
  thinkingLevel,
  modelOnboarding,
  hasContent,
  fileInputRef,
  onSelectEnvironment,
  onSetModel,
  onSetThinking,
  extensionFlags,
  onSetExtensionFlag,
  onAddAttachments,
  onSubmit,
}: NewThreadComposerFooterProps) {
  useLocale();
  return (
    <>
      <div className="composer__footer">
        <div className="composer__footer-row">
          <div className="composer__hint new-thread__hint">
            <div className="new-thread__environment-group">
              <button
                className={`new-thread__environment ${environment === "local" ? "new-thread__environment--active" : ""}`}
                type="button"
                onClick={() => onSelectEnvironment("local")}
              >
                <span>{t("Local", "本地")}</span>
              </button>
              <button
                className={`new-thread__environment ${environment === "worktree" ? "new-thread__environment--active" : ""}`}
                type="button"
                onClick={() => onSelectEnvironment("worktree")}
              >
                <span>{t("Worktree", "工作树")}</span>
              </button>
            </div>
            <span className="new-thread__hint-separator">·</span>
            <ModelSelector
              runtime={runtime}
              provider={provider}
              modelId={modelId}
              thinkingLevel={thinkingLevel}
              dropdownPlacement="below"
              showEmptyModelControl
              unselectedModelLabel={modelOnboarding.unselectedModelLabel}
              emptyModelLabel={modelOptionsEmptyTitle()}
              emptyModelTitle={modelOnboarding.emptyModelTitle}
              onSetModel={onSetModel}
              onSetThinking={onSetThinking}
            />
            <ExtensionFlagsSelector
              runtime={runtime}
              values={extensionFlags}
              onSetFlag={onSetExtensionFlag}
            />
          </div>

          <div className="composer__actions">
            <input
              ref={fileInputRef}
              hidden
              type="file"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) {
                  onAddAttachments(files);
                }
                event.currentTarget.value = "";
              }}
            />
            <button
              aria-label={t("Attach files", "添加文件")}
              className="icon-button composer__attach"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            <button
              aria-label={t("Start thread", "开始会话")}
              className="button button--primary button--cta-icon"
              type="button"
              disabled={!hasContent || modelOnboarding.requiresModelSelection}
              onClick={onSubmit}
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
