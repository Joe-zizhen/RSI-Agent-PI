import type { RuntimeSkillRecord } from "@rsi-agent-pi/session-driver/runtime-types";
import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { titleCase } from "../../lib/string-utils";
import { SkillIcon } from "../../ui/icons";
import { SettingsGroup, SettingsRow } from "../settings/settings-utils";
import { sourceScopeGroupLabel } from "./extension-display";
import { displayPath, ResourceDetail } from "./resource-detail";
import { ResourceEmptyState, ResourceList, type ResourceListGroup } from "./resource-list";
import { t, useLocale } from "../../t";

const groupOrder = (): readonly string[] => [
  sourceScopeGroupLabel("project"),
  sourceScopeGroupLabel("user"),
  sourceScopeGroupLabel("temporary"),
];

interface SkillsTabProps {
  readonly workspace: WorkspaceRecord;
  readonly skills: readonly RuntimeSkillRecord[];
  readonly searching: boolean;
  /** The skill whose detail page is open, looked up in the unfiltered list. */
  readonly selected?: RuntimeSkillRecord;
  readonly onSelect: (filePath: string | undefined) => void;
  readonly onToggleSkill: (filePath: string, enabled: boolean) => void;
  readonly onOpenSkillFolder: (filePath: string) => void;
  readonly onTrySkill: (skill: RuntimeSkillRecord) => void;
}

export function SkillsTab({
  workspace,
  skills,
  searching,
  selected,
  onSelect,
  onToggleSkill,
  onOpenSkillFolder,
  onTrySkill,
}: SkillsTabProps) {
  useLocale();
  // The list stays mounted under an open detail so expanded groups, scroll and focus survive.
  const list =
    skills.length === 0 ? (
      <ResourceEmptyState
        title={
          searching ? t("No skills match", "没有匹配的技能") : t("No skills yet", "还没有技能")
        }
        body={
          searching
            ? t(
                "Try another name, description or slash command.",
                "换一个名称、描述或斜杠命令再试。",
              )
            : t(
                "Skills are discovered in this workspace and your user skill folders. Create one, or refresh after adding one.",
                "技能会在此项目和你的用户技能文件夹中被发现。创建一个，或在添加后刷新。",
              )
        }
      />
    ) : (
      <ResourceList
        expanded={searching}
        groups={groupSkills(skills, onToggleSkill)}
        icon={<SkillIcon />}
        testId="skills-list"
        onOpen={onSelect}
      />
    );

  return (
    <>
      {selected ? (
        <ResourceDetail
          actions={
            <>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => onOpenSkillFolder(selected.filePath)}
              >
                {t("Open folder", "打开文件夹")}
              </button>
              <button
                className="button button--primary"
                type="button"
                onClick={() => onTrySkill(selected)}
              >
                {t("Try it", "试用")}
              </button>
            </>
          }
          backLabel={t("All skills", "全部技能")}
          enabled={selected.enabled}
          icon={<SkillIcon />}
          subtitle={selected.slashCommand}
          title={titleCase(selected.name)}
          onBack={() => onSelect(undefined)}
          onToggle={(enabled) => onToggleSkill(selected.filePath, enabled)}
        >
          <p className="resource-detail__description">{selected.description}</p>
          <SettingsGroup>
            <SettingsRow
              title={t("Slash command", "斜杠命令")}
              description={t(
                "Type it in the composer to run the skill.",
                "在输入框中输入它来运行技能。",
              )}
            >
              <code className="resource-detail__code">{selected.slashCommand}</code>
            </SettingsRow>
            <SettingsRow
              title={t("Model invocation", "模型调用")}
              description={
                selected.disableModelInvocation
                  ? t("Only runs when you type its slash command.", "仅在你输入其斜杠命令时运行。")
                  : t(
                      "pi can also choose this skill on its own when it fits the task.",
                      "当技能符合任务时，pi 也可以自行选用它。",
                    )
              }
            >
              <span className="settings-row__value">
                {selected.disableModelInvocation
                  ? t("Slash commands only", "仅斜杠命令")
                  : t("Automatic", "自动")}
              </span>
            </SettingsRow>
            <SettingsRow
              title={t("Location", "位置")}
              description={sourceScopeGroupLabel(selected.scope)}
            >
              <code className="resource-detail__code" title={selected.filePath}>
                {displayPath(selected.filePath, workspace.path)}
              </code>
            </SettingsRow>
          </SettingsGroup>
        </ResourceDetail>
      ) : null}
      <div hidden={Boolean(selected)}>{list}</div>
    </>
  );
}

function groupSkills(
  skills: readonly RuntimeSkillRecord[],
  onToggleSkill: (filePath: string, enabled: boolean) => void,
): readonly ResourceListGroup[] {
  return groupOrder()
    .map((label) => ({
      label,
      items: skills
        .filter((skill) => sourceScopeGroupLabel(skill.scope) === label)
        .map((skill) => ({
          id: skill.filePath,
          title: titleCase(skill.name),
          description: skill.description,
          enabled: skill.enabled,
          onToggle: (enabled: boolean) => onToggleSkill(skill.filePath, enabled),
        })),
    }))
    .filter((group) => group.items.length > 0);
}
