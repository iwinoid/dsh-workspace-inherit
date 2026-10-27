# dsh-workspace-inherit

> [!WARNING]
> 个人自用项目。仅在我的机器与工作流上验证过，不保证在其他 DSH 版本、平台或环境下可用。请先审阅代码、谨慎使用，风险自负。

让 DSH 里**嵌套的子工作区**继承**母工作区**的 `AGENTS.md` 和 skills。

## 为什么需要它

DSH 的“工作区”在 Web UI 里按路径嵌套展示（`ui-workspace` 的 `owningParentFolder`），但模型上下文并不认“工作区”，只认会话的 cwd：

- **指令**：`dsh-agent-instructions` 从“最近的 `.git` 目录（没有就取 cwd）”读到 cwd，逐层加载 `AGENTS.md → CLAUDE.md → AGENTS.local.md → CLAUDE.local.md`。母工作区如果在项目根之上，完全不在链上，也不会动态补进来。
- **skills**：`dsh-skill-filesystem` 只扫 `<projectRoot>/.dsh/skills` 和 `<projectRoot>/.agents/skills`。母工作区自己的 skills 扫不到；反过来，如果母工作区有 `.git`，子工作区自己的 `.dsh/skills` 还会丢。

本插件补上这两层，不改 dsh 源码，也不接管 core 的两个插件。

## 它做什么

### 1. 指令：一条更宽泛的持久消息 + 运行中刷新

- 用 `ctx.workspaceRegistry.list()` 找出 cwd 的**真祖先工作区**，再减掉 core 已经覆盖的链（项目根 → cwd），只补母工作区那几层，**不重复注入**。
- 按目录由宽到具体读取与 core 相同的候选文件，同一目录内 trim 后内容相同的文件折叠。
- 首次请求注入一条持久 user 消息，格式与 core 一致（`<system-reminder>` + `Instructions from: …`），并明确写出“来自母工作区、比当前工作区更宽泛、更具体的指令优先”。
- **动态刷新**：每次 `agent/pre-step` 重新检查这些文件（stat + 摘要），只在变化时追加一条消息：
  - 新增文件 → `Additional parent-workspace instructions from: …`
  - 内容变化 → `Updated parent-workspace instructions from: …`
  - 文件删除 / 母工作区注销 → `Parent-workspace instructions removed: …`
- 恢复会话时从会话日志里读回最后一次快照，**不会重复注入基线**。
- 字节预算默认 64 KiB：先整份丢弃更宽泛的文件，最后才截断最具体的；超限时发 `Parent-workspace instruction budget …` 提示。
- 快照区分三种投递状态：正常交付、`truncated`（只交付了截断内容）、`omitted`（预算丢弃、模型从未看到）。后两种会在内容变化或预算变化时补全；从未投递的文件按“新增”通知，删除从未投递的文件不发删除通知。

### 2. skills：第二个 provider，优先级夹在中间

注册一个 `ctx.skills` provider，扫描每个祖先工作区的：

- `.dsh/skills`（rank `210` 起，每远一层 +2，封顶 `248`）
- `.agents/skills`（比同层 `.dsh/skills` 低 1）

深度到 20 层后 rank 共享 `248`，此时由 provider/local order 决定同 rank 的先后（正常嵌套不会到这么深）。

于是同名技能的优先级是：

```
当前工作区 100/200 > 母工作区 210–248 > runtime 250 > custom 300 > 用户级 400/500 > 内置 600
```

越近的母工作区越优先；同一母工作区里 `.dsh/skills` 先于 `.agents/skills`。

- 支持 `<name>/SKILL.md` 目录 bundle 和 `<name>.md` 平铺文件，只扫一层。
- 用 `fs.watch` + “根目录尚不存在时轮询”监听母工作区技能根，新增/删除/改 frontmatter 会在下一轮目录刷新，无需重启。
- 忽略作为用户级根被 core 扫过的 `~/.dsh/skills`、`~/.agents/skills`，避免把全局技能抬到母工作区优先级。

## 配置

行 id 是 `workspace-inherit`，默认配置已经够用：

```yaml
- id: workspace-inherit
  name: dsh-workspace-inherit
  config:
    enabled: true
    includeInstructions: true
    includeSkills: true
    maxBytes: 65536
    maxSourceBytes: 1048576
    instructionFileCandidates: [AGENTS.md, CLAUDE.md]
    localInstructionFileCandidates: [AGENTS.local.md, CLAUDE.local.md]
    projectRootMarkers: [.git]
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `includeInstructions` | `true` | 是否注入母工作区指令 |
| `includeSkills` | `true` | 是否注册母工作区技能 provider |
| `maxBytes` | `65536` | 一条指令消息的 UTF-8 字节预算 |
| `maxSourceBytes` | `1048576` | 单个指令文件的大小上限，超过直接跳过 |
| `instructionFileCandidates` | `[AGENTS.md, CLAUDE.md]` | 每个目录的基础候选 |
| `localInstructionFileCandidates` | `[AGENTS.local.md, CLAUDE.local.md]` | 每个目录的本地覆盖候选 |
| `projectRootMarkers` | `[.git]` | 用于判定 core 项目根的标记 |

## 生效条件

- 必须存在 `ctx.workspaceRegistry`（Web / Desktop 的 profile 有，纯 headless 没有）。没有时插件静默降级：不注入、不扫描。
- 母工作区必须**显式注册过**（在 Web UI 里建过工作区），不是“文件夹碰巧在上一层”。
- 指令读取用本机文件系统；远程/沙箱后端的工作区不覆盖。

## 限制与取舍

- 只沿**注册过的**祖先工作区这条路径链补；链上未单独注册的中间目录也会被读（core 的项目链同样按目录逐层读），不在这条链上的兄弟目录不会。
- 父级 `AGENTS.md` 的刷新是每步重新读取并算 trim 后摘要，不是文件监听；代价是每步读这几个小文件，收益是没有 watcher 泄漏与抖动。技能根是监听式的。
- 技能的 frontmatter 解析覆盖 `name`、`description`、`whenToUse`、`disable-model-invocation`、`user-invocable`，支持块标量（`|`/`>`，含 `-`/`+` 标记）、引号+行内注释、`on`/`off` 布尔和常见转义；非法布尔、缩进围栏、重复键、旧式驼峰字段按 core 规则判为无效并跳过。它不是通用 YAML，嵌套对象等复杂结构忽略；父级技能的资源目录照常可用（`resourceBase` 指向该技能目录）。
- 技能条目的符号链接会被跟随；会话 cwd 在计算前先做 realpath，避免注册表里的规范路径与 cwd 拼写不一致（symlink）导致匹配失败。
- watcher 每个 provider 最多跟踪 512 个根/技能目录，缺失根每 3 秒探测一次；超出上限只记日志、不再新增监听。
- 会话被压缩（compaction）且替换范围遮蔽了本插件注入的消息时，下一步会重新注入基线，避免模型在压缩后静默失去母工作区指令。
- 运行中的 Host 只会加载启动时的模块版本；安装或更新本插件后重启 `dsh web` 才会用到最新代码（插件本身是 profile 里的链接目录）。磁盘读取走 Node 文件系统，适用于本机工作区；远程/沙箱后端未适配。
- 与 core 一样，本插件注入的指令也不覆盖 system/developer/直接用户指令。

## 验证

```bash
cd dsh-workspace-inherit
npm test          # 63 个用例：配置、指令链、渲染预算、快照/差异、技能解析、优先级、watcher、装配
npm run check     # node --check 全部 lib/*.js
```

端到端（已在运行中的 0.2.1-rc.3 Web Host 里实测，用一个 cwd 在嵌套子目录里的真实子会话）：

- 首轮：子会话上下文里出现父级 `AGENTS.md` 的 system-reminder，`skill` 工具能加载父级 `.dsh/skills` 里的技能；
- 修改父级 `AGENTS.md` 后，同一会话的下一次请求同时看到旧的 `V1` 与新的 `V2`（`Updated parent-workspace instructions from:`）；
- 在父级 `.dsh/skills` 下新增第二个技能后，同一会话下一次请求即可通过 `skill` 工具加载它（watcher 已失效目录缓存）。

自己在 Web UI 里复现：分别把父目录和它里面的子目录建成两个工作区，在父目录放 `AGENTS.md` 与 `.dsh/skills/demo/SKILL.md`，然后在子工作区开一个新会话。

## 卸载

在“设置 → 插件”里移除 `dsh-workspace-inherit`，或执行 `plugin_manager remove_bundle`（包名 `dsh-workspace-inherit`）。移除后已注入的消息仍在历史里，但不会再刷新。
