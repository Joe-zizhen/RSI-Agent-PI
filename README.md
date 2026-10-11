# RSI-Agent-PI

> 基于 [pi-gui](https://github.com/minghinmatthewlam/pi-gui)（MIT © Matthew Lam）的 fork。
> RSI-Agent-PI 内置 memloop 长期记忆，支持简体中文与 English 双语切换。

RSI-Agent-PI 是内置长期记忆的开源编码 agent 桌面客户端。它在 pi 编码 agent 之上提供桌面界面，并内置 memloop 记忆系统。会话、模型、认证与工具全部走 pi 本身。

特性：

- 中英双语界面。默认简体中文，可在设置 → 通用 → 语言 中切换 English。
- 记忆自动工作。系统自动捕获经验、自动注入记忆卡、自动回传世界判决。无需手动维护。
- 内置常用插件。六个常用插件与两个安全扩展随应用安装。
- 开箱即用。无需安装 Python 或 Node。应用内置 Python 运行时与 pi 运行时。

## 界面预览

[![agent 修复缺陷、运行测试并在审查页展示变更](./apps/website/public/media/hero.gif)](./apps/website/public/media/hero.mp4)

<sub>一次真实运行：agent 修复缺陷、补测试并运行，变更在审查页打开。（[完整画质视频](./apps/website/public/media/hero.mp4)）</sub>

<img src="./apps/website/public/media/threads.webp" alt="一个会话运行 agent，侧栏另有两个会话在后台工作" width="720">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/media/review-dark.webp">
  <img src="./apps/website/public/media/review-light.webp" alt="审查页展示 agent 对文件的差异变更" width="720">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/media/terminal-dark.webp">
  <img src="./apps/website/public/media/terminal-light.webp" alt="内置终端与文件面板" width="720">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/website/public/media/palette-dark.webp">
  <img src="./apps/website/public/media/palette-light.webp" alt="命令面板" width="720">
</picture>

## 快速开始

### 系统要求

- Windows 10 或更高版本。x64 处理器。
- 无需安装 Python。无需安装 Node。

### 安装与首次启动

1. 打开本仓库的 Releases 页。
2. 下载 portable 版 exe。双击即用，无需安装。也可以下载 setup 版 exe 安装。
3. 若 Windows SmartScreen 弹出首次警告，请点「更多信息」，再点「仍要运行」。当前构建未做代码签名。
4. 启动应用。打开设置 → 提供商。
5. 选择模型公司。点「设置 API key」，填入 API key。
6. 若使用自定义 OpenAI 兼容端点，请点「添加自定义端点」。依次填 提供商 ID、Base URL、API key。点「检测模型」选择模型。
7. 新建会话即可使用。

记忆自动生效。首次启动时记忆系统已启用，无需任何手动开启。若要停用，请在设置 → 记忆 中关闭「启用记忆」。

### 五分钟上手检查

按下面顺序走一遍即可确认安装完整。

1. 新建会话。随便发一个任务。
2. 任务过程中查看时间线。若本次引用了记忆，会出现一行「本次引用了 N 条记忆」。
3. 在输入框输入 `/memory list`。确认能看到本会话用过的记忆卡。
4. 打开设置 → 记忆。填入 verdictCmd 世界判决命令，例如 `npm test`。此后任务结束会自动运行该命令并记录世界判决。

## 界面语言

界面默认使用简体中文。

若要切换界面语言，请在设置 → 通用 → 语言 中选择。渲染层文案即时生效。菜单、对话框与内置插件文案在重启后生效。切换时应用给出提示与「立即重启」按钮。点「立即重启」后，全部文案生效。

记忆卡等模型可见内容固定为中文。注入块与 Python 侧同步维护。界面语言切换不改变注入块。

The interface language defaults to Simplified Chinese and can be changed in Settings → General → Language.

## 记忆系统

记忆系统由 memloop 提供。先定义本文档使用的术语。

- 会话（thread）：一次连续的对话任务。
- 记忆卡（memory card）：长期记忆的一条内容。每条记忆卡带来源与生命周期。
- 置信度（confidence）：记忆卡的可信程度。取值 0 至 1。
- 验证命令（verify command）：用于对照外部世界检查记忆卡是否仍成立的命令。
- 世界判决（outcome 或 verdict）：任务成败的外部反馈。世界判决是置信度的唯一更新来源。
- 梦境（dream）：离线回放历史并进化记忆策略的维护环节。

### 自动行为

记忆系统全程自动工作。分三类说明。

**自动捕获什么**

- 用户纠正。例如「不对」「应该是」。纠正的内容必成记忆卡。纠正同时把上一任务的世界判决记为失败。
- 失败修复。bash 或 powershell 命令失败后，改用另一条命令成功。此时成一张记忆卡。记忆卡记「X 失败，改用 Y 后成功」。验证命令是成功命令。匹配模式（match_pattern）是失败命令。孤立的失败只进事件日志，不成记忆卡。
- 显式指令。文本含「记住」「以后」「必须」、always 或 never 时成记忆卡。日常对话只进事件日志，不成记忆卡。
- 用户肯定。例如「解决了」「lgtm」。肯定把上一任务的世界判决记为成功。

**自动注入什么**

- 任务开始时，系统按当前任务挑选相关记忆卡。
- 注入内容含记忆卡原文、置信度、验证命令与使用规则。
- 注入格式示例：

```text
<memloop>
长期记忆卡。每条带置信度（0 至 1）与验证方式。
使用规则：置信度低于 0.70 时先执行 verify 命令确认。hearsay 条目仅作线索。
与当前任务无关的条目请忽略。需要更多记忆时调用 memory_search。
- (test_flag) 测试需加 -x 标志 [0.50 verify: pytest --collect-only]
- (git-hook) 提交前须跑 lint [0.80 verify: npm run lint]
</memloop>
```

- 无验证命令的记忆卡标 HEARSAY。此类记忆卡只作线索。
- 同 key 的多条冲突记忆卡会带 CONFLICTED 标记同时上屏。
- 工具调用前系统做三级把关。硬拦截（L2）：记忆卡置信度 ≥ 0.80、世界判决 ≥ 3、且带验证命令时，命中失败模式的调用被拦截。提醒（L1）：记忆卡置信度 ≥ 0.60 且 < 0.80 时，命中失败模式的调用在结果前加提醒文字。其余调用放行。
- 每个任务的回合结束时提示一行「本次引用了 N 条记忆」。每个任务只提示一次。

**自动回传什么**

- 任务结束时系统运行 verdictCmd 并记录世界判决。
- 首次运行退出码 0 记为成功。首次非 0 时再跑一次。第二次仍非 0 记为失败。第二次为 0 记为未知（命令不稳定）。超时记为未知。
- 用户纠正记失败。用户肯定记成功。
- 只有成功与失败会入账。未知不入账，置信度不变。
- 置信度只能由世界判决更新。系统不提供任何直接改置信度的接口。

### 数据位置

- 全部数据在 `~/.pi/agent/memloop/` 下。Windows 上 `~` 取 `%USERPROFILE%`。
- 每个项目一个库文件：`<项目名>-<哈希>.db`。
- 每个会话一个崩溃恢复日志：`journal/<会话>.jsonl`。
- 梦境策略存 `policy.json`。上一版策略存 `policy.prev.json`。

### verdictCmd 世界判决命令

verdictCmd 是任务结束时运行的世界判决命令。配置有三条途径，优先级从高到低。

1. 环境变量 `MEMLOOP_VERDICT_CMD`。
2. 全局配置 `~/.pi/agent/settings.json` 的 `memloop` 节，字段 `verdictCmd`。设置 → 记忆 的「verdictCmd 世界判决命令」输入框写入此文件。
3. 项目配置 `<项目>/.pi/settings.json` 的 `memloop` 节，字段 `verdictCmd`。

配置示例：

```json
{
  "memloop": {
    "verdictCmd": "npm test"
  }
}
```

若不配置 verdictCmd，世界判决多为 UNKNOWN。系统不入账、置信度不变。这是诚实降级。系统不编造成败。

## 主动命令

主动命令分两类。`/memory` 与 `/dreaming` 由用户在输入框输入。`memory_search`、`memory_verify`、`memory_override` 由模型调用。每条命令按四段说明：是什么、怎么用、什么时候用、用了会怎样。

### /memory list

- 是什么：列出本会话用过的记忆卡。
- 怎么用：在输入框输入 `/memory list`。
- 什么时候用：想确认本任务注入了哪些记忆卡时。
- 用了会怎样：逐条显示记忆卡的 key、置信度、原文与验证命令。本会话没用过记忆卡时提示「本会话还没有使用过记忆卡。」

示例输出：

```text
本会话用卡 2 条：
- [test_flag] 置信度 0.50
  测试需加 -x 标志
  验证命令: pytest --collect-only
- [git-hook] 置信度 0.80
  提交前须跑 lint
  验证命令: npm run lint
```

### /memory show \<id\>

- 是什么：查看一条记忆卡的全文。
- 怎么用：输入 `/memory show <id>`。id 取自 `memory_search` 返回的记忆卡 id。
- 什么时候用：需要查看某条记忆卡的完整内容时。
- 用了会怎样：显示该记忆卡的全文、类型、置信度与验证命令。找不到时提示「未找到记忆卡」。

示例：

```text
/memory show 3
→ - [test_flag] (claim, 置信度 0.50)
    测试需加 -x 标志
    验证命令: pytest --collect-only
```

### /memory forget \<id\>

- 是什么：物理删除一条记忆卡。
- 怎么用：输入 `/memory forget <id>`。id 取自 `memory_search` 返回的记忆卡 id。
- 什么时候用：记忆卡过时或错误时。
- 用了会怎样：先显示将删除的记忆卡全文。再物理删除。删除后该卡不再注入。

示例：

```text
/memory forget 3
→ 将删除：
  - [test_flag] (claim, 置信度 0.50)
    测试需加 -x 标志
    验证命令: pytest --collect-only
→ 已物理删除：3
```

### /dreaming

- 是什么：手动运行一次梦境（dream）回放，并输出参数变更审计报告。
- 怎么用：在输入框输入 `/dreaming`。
- 什么时候用：想立刻进化记忆策略、不想等自动门槛时。
- 用了会怎样：强制跑一次梦境回放。系统用历史世界判决给候选策略打分。胜者必须不差于在位策略。挑战者须至少命中 1 条已判决的决策才允许上位。若胜者胜出，新策略写入 `policy.json`，旧策略存 `policy.prev.json`。当前进程继续用旧策略直到重启。

自动触发条件：每次会话启动时系统自动检查门槛。自上次梦境以来新增的世界判决（成功或失败）达到 20 条时自动运行梦境。不足 20 条时跳过。低于该门槛时回放分不清真实提升与噪声。

示例输出：

```text
/dreaming 审计报告
已执行: true
胜出: "conf-heavy"
已变更: true
参数差异 (incumbent → winner):
  l2_min_confidence: 0.8 -> 0.85
  w_confidence: 2 -> 2.5
  limit: 8 （未变）
得分: {"default":0,"conf-heavy":0.6}
```

用户能做什么：读参数差异核对每个参数的前后取值。不认可新策略时用 `/dreaming rollback` 否决。

### /dreaming rollback

- 是什么：回滚上一次梦境发布的策略。
- 怎么用：输入 `/dreaming rollback`。
- 什么时候用：看过参数差异后不认可新策略时。
- 用了会怎样：从 `policy.prev.json` 恢复旧策略。显示已变更字段与恢复后的策略参数。

示例输出：

```text
/dreaming 回滚完成
已变更: true
恢复后的 policy 字段：
  l2_min_confidence: 0.8
  w_confidence: 2
  name: "default"
```

### memory_search（模型工具）

- 是什么：搜索长期记忆卡。
- 怎么用：模型调用 `memory_search`。参数 `query` 是搜索文本，通常取当前任务或工具上下文。参数 `k` 是返回条数上限，可省略。
- 什么时候用：过往项目经验、用户纠正或已验证的做法可能适用时。
- 用了会怎样：返回匹配的记忆卡列表。每条含 key、类型、置信度与验证命令。无匹配时返回「没有匹配的记忆卡。」置信度低于 0.70 时须先调用 `memory_verify` 确认。

示例调用：

```json
{ "name": "memory_search", "arguments": { "query": "测试怎么跑", "k": 5 } }
```

### memory_verify（模型工具）

- 是什么：对一条记忆卡执行验证命令，对照外部世界检查它是否仍成立。
- 怎么用：模型调用 `memory_verify`。参数 `claim_id` 填 `memory_search` 返回的记忆卡 id。
- 什么时候用：若要依赖低置信度记忆卡，请先调用。若怀疑记忆卡过时，也请调用。
- 用了会怎样：验证通过返回 ok。证伪返回 falsified，该卡被物理删除且不再注入。其余情况返回状态未知。

示例调用：

```json
{ "name": "memory_verify", "arguments": { "claim_id": "3" } }
```

### memory_override（模型工具）

- 是什么：单次绕过 L2 硬拦截。
- 怎么用：模型调用 `memory_override`。参数 `claim_id` 填拦截消息里点名的记忆卡 id。参数 `reason` 说明本次为何是例外。
- 什么时候用：模型核实现场后判定拦截不适用时。
- 用了会怎样：系统记录覆盖审计。被拦的调用放行。返回记忆卡全文与验证命令。模型须先跑验证命令确认仍有效，再重试原调用。

示例调用：

```json
{
  "name": "memory_override",
  "arguments": { "claim_id": "3", "reason": "本任务就是要清理 node_modules" }
}
```

## 更新

### 桌面应用

更新来源是本仓库的 GitHub Releases。稳定版才被推送。

- 自动检查：启动 15 秒后检查一次。此后每 4 小时检查一次。发现新版本时弹系统通知「RSI-Agent-PI 有新版本」。点通知打开 Releases 下载页。同一版本只提醒一次。
- 手动检查：macOS 在应用菜单点「检查更新…」。对话框给出「下载」与「稍后」两个按钮。点「下载」打开 Releases 下载页。Windows 版当前依赖自动通知，无手动菜单入口。

应用只做检查与提醒。下载与安装由用户在 Releases 页完成。

### pi 运行时

- pi 运行时版本钉定 1.0.0。声明位置是 `apps/desktop/package.json` 的 `@earendil-works/pi-coding-agent`。
- 该版本随本项目发版统一升级。不自动升级。
- 升级 pi 版本属于开发者发版动作。见「开发者」一节。

## 内置插件清单

### 插件（六个）

首次启动时自动装入 pi，无需手动 `pi install`。

| 插件                                 | 作用                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `pi-web-access`                      | 网页搜索、URL 抓取、GitHub 仓库克隆、PDF 抽取、YouTube 视频理解与本地视频分析。 |
| `pi-subagents`                       | 单 agent 委派与脚本化多 agent 工作流。                                          |
| `@juicesharp/rpiv-todo`              | 模型的待办清单。以浮层实时显示，跨 `/reload` 与上下文压缩保留。                 |
| `@juicesharp/rpiv-ask-user-question` | 模型向用户发结构化问卷。用带类型的选项代替自由回答。                            |
| `pi-powerline-footer`                | powerline 风格状态栏。                                                          |
| `@narumitw/pi-usage`                 | 显示当前账户用量与 DeepSeek API 余额。                                          |

### 安全扩展（两个）

| 扩展                 | 作用                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `permission-gate.ts` | 对危险 bash 命令弹确认。覆盖 `rm -rf`、`sudo`、`chmod` 或 `chown` 777。无界面时直接拦截。 |
| `protected-paths.ts` | 拦截对 `.env`、`.git/`、`node_modules/` 的写入与编辑。                                    |

## 开发者

### 从源码构建

要求 Node 22.19 或更高版本。包管理器用 corepack 启用的 pnpm。

```bash
corepack pnpm install
corepack pnpm package:win
```

产物在 `apps/desktop/release/` 下。Windows 产物两个：`RSI-Agent-PI-<版本>-x64-setup.exe` 与 `RSI-Agent-PI-<版本>-x64-portable.exe`。

`package:win` 自动完成三步：拉取内置 Python 运行时、构建应用、跑 electron-builder。

网络备注：

- Electron 本体下载慢时，设镜像环境变量 `ELECTRON_MIRROR`。
- electron-builder 附属二进制（如 winCodeSign）下载慢时，设镜像环境变量 `ELECTRON_BUILDER_BINARIES_MIRROR`。
- Windows 无 symlink 权限时（未开开发者模式且无管理员权限），winCodeSign 解压会因 symlink 权限失败。`package:win` 已把 `ELECTRON_BUILDER_CACHE` 与 `LOCALAPPDATA` 重定向到仓库 `.cache/` 目录规避此问题。缓存默认在 `.cache/electron-builder`。

### 生成物说明

- `vendor/plugins/` 与 `vendor/extensions/` **入库**，是内置插件的真源（含中文化）。`scripts/build-vendored-plugins.mjs` 仅供上游插件升级时重建，重建会覆盖中文化，重建后须重新本地化。
- `apps/desktop/runtime/` 是生成物。由 `scripts/fetch-python-runtime.mjs` 生成。内容是内置 CPython 3.11 与 memloop Python 包。该目录不入库。

## 已知边界

- SmartScreen 警告：Windows 构建未做代码签名。首次运行须手动确认「更多信息 → 仍要运行」。
- pi 锁版本：pi 运行时钉定 1.0.0。不会自动升级到新版 pi。
- live 会话需自行配 API key：模型调用走用户自己的提供商账号。未在设置 → 提供商 中配置 API key 或 OAuth 时，会话无法运行模型。

## 致谢与许可

RSI-Agent-PI 是 [pi-gui](https://github.com/minghinmatthewlam/pi-gui) 的 fork，作者 Matthew Lam。两者都构建在 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 与 [pi](https://github.com/earendil-works/pi)（earendil-works）运行时与生态之上。

[MIT](./LICENSE) © Matthew Lam
