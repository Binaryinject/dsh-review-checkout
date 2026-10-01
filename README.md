# dsh-review-checkout

[DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）的**会话文件修改审查**插件：把每一轮 `write` / `edit` 的结果变成一张像官方卡片一样的「已编辑」卡片，配一个能定位到行、能按轮撤回的审查视图。

> 起点是 [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review)，本仓库是其加固 + 与官方 UI 对齐后的重构版，Web（`dsh web`）与 Desktop 均可用。

## 亮点

- **每轮一张「已编辑」卡片** —— 与官方 `dsh-client-ui-deliverables` 的卡片同款皮肤（同 token、同 16px 圆角、同图标块、同折叠行），但自带 `撤销` / `审核` 两个官方没有的动作；默认**接管**官方那张卡片，避免一轮出现两张。
- **审查 tab** —— 按轮查看：左文件列表 + 右 diff（**分割线可拖动**改宽度，双击复位），或「列表」模式每文件一张可展开卡片；语法高亮、真实行号、每文件 `+N −M`、单文件 `还原`。
- **三级打开链** —— ① 你选的编辑器（**定位到行**）→ ② 系统默认应用（与官方卡片同一条路）→ ③ 右侧内置预览；每一级失败都会说明原因，不会静默。
- **运行中小胶囊** —— 输入框上方 `N 个文件已更改 ＋X −X`，与卡片同一套主题样式。
- **主题跟随** —— 卡片、胶囊、图标全部使用 DSH 主题 token，深浅自动切换；只有 diff 配色保留插件自己的两套预设。

## 安装

```bash
dsh plugin add dsh-review-checkout          # 或从 DSH 插件市场安装
```

确认 profile 注册了 bundle patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: diff-review
      name: 'dsh-review-checkout'
```

**Host 端（`lib/index.js`）改动需重启 `dsh web` / Desktop；纯客户端（`lib/client.js`）改动刷新页面即可。**

## 功能

### 每轮卡片（对话流）

| 项 | 说明 |
|---|---|
| 外观 | 复刻官方 `ChangedFiles` 卡片：`.5px` 边框 + 16px 圆角、36px 图标块（官方那枚尖括号）、`+N −M` 统计、折叠行；颜色全部来自 DSH 主题 token |
| 内容 | 标题「已编辑 N 个文件」（单文件时直接显示路径）、每行「相对路径 + `+N −M`」、时间戳；超过 3 行折叠为「全部 N 个文件 ⌄」 |
| 动作 | `撤销`（按该轮生成**倒序** `diff_review_revert` op 序列并填入输入框）、`审核`（跳审查 tab）、点某行 → 跳审查 tab 并**只展开该文件** |
| 悬停预览 | 鼠标停在某一行上约 350ms，就在该行上方/下方弹出该文件**本轮的 diff**（官方那个「滑到最底」式的浮层行为：高度上限 420px、贴近视口自动翻转、跟随滚动重定位）。内容是**整文件差异 + 每处改动前后 3 行上下文**，远处不连续的部分用 `⋯` 折叠——与官方预览同一观感，单行改动也能看到上下文（不是只显示工具片段）。容器用官方原语 `HoverCard`（`variant:"preview"`），**diff 行仍由插件自己的渲染器绘制**，所以插件色板（设置 → 修改审查 里那套可自定义的 diff 颜色）与语法高亮和审查 tab 完全一致；拿不到精确差异时（旧记录 / 超出 diff 预算）自动退回按 op 片段渲染，最多 400 行并提示去审查 tab 看完整对比 |
| 空轮 | 该轮无修改时显示「本轮无文件修改」 |
| 持久 | 每个已结束轮次都会渲染，数据按轮向宿主查询，**刷新 / 重开对话后仍在** |
| 接管 | 默认隐藏官方在同一插槽（`conversation.chat.turnTail`）的「已编辑」卡片（`[data-changed-files]`）；可在 **设置 → 修改审查** 里关掉接管、两套并存。**官方那张交付文件卡片不受影响**，仍由官方显示 |

### 审查 tab（会话视图）

- **范围**：任意一轮 / 「全部修改」（会话累计）。
- **双视图**：左侧文件列表 + 右侧该文件 diff；**中间分割线可左右拖动**调整比例，双击恢复响应式默认宽度（左栏最小 140px、diff 至少 260px），宽度写入 `localStorage`；面板过窄（<520px）时自动只留 diff。
- **列表模式**：每文件一张可展开卡片，同时只展开一个，文件标题吸顶。
- **diff**：按扩展名高亮 JS/TS/JSON/CSS/C++/C#/Java/Go/Rust/Python/YAML/Shell/CMake 等；行号是**真实文件行号**：改动发生时即从未截断的快照恢复（`lineHint`），其次用存档快照，再次用磁盘上的当前文件定位，只有三者都不可得时才标注为相对行号；每行左侧有「在编辑器中打开该行」按钮。快照被存储上限截断的记录不再允许还原（否则会把文件截断）。
- **不换行**：diff 行永远保持一行（`white-space:pre`），超宽就由 diff 区自己出横向滚动条——换行会让续行看起来像新行、和行号列错位；两个视图（双视图详情 + 列表模式卡片）与**悬停预览**一律如此。行本身宽 `max-content`（底色铺满可滚动区域），行尾的「打开该行」按钮 `position:sticky` 停在视口右缘，横向滚动时不会跟着跑掉。
- **字体**：默认**跟随** DSH 与皮肤——插件里每处字体栈都走官方 token（`var(--dsw-font-family)` / `var(--ds-font-family-code)`，字号用 `calc(var(--dsh-content-font-size, 14px) ± Npx)`），所以皮肤插件（如 `@pakiknowledge/dsh-client-ui-skin-claude`，它只改写 `--dsw-*` 变量）和「设置 → 常规 → 字号大小」都会作用到本插件。工具条右侧的 `字体：跟随` 可改为**任意系统已安装字体**：列表由 host 读取（Windows 字体注册表 `/ Linux·macOS fontconfig`），支持搜索（输入即过滤，回车应用）与直接输入字体名，选择存在 `localStorage`，随时可切回「跟随」。
- **工具条**：轮次选择、双视图/列表切换、`＋N －M · N 文件`、**字号步进 + 字体选择器**、**编辑器选择器**。
- **记录占用 + 清空**（工具条右侧）：显示本会话在磁盘上的记录占用（分片文件 ＋ 它引用的快照 blob，每 10 秒刷新），悬停可见明细：`分片 X ＋ 快照 Y（N 个 blob，按内容共享，可能与其它会话共用）· M 文件 / K 次修改`。旁边的**「清空」**会先确认，然后删除该会话的分片、清空内存记录与视图，并让宿主顺手 GC 掉因此变成孤儿的 blob（按钮旁回显"已清空，回收 N 个快照"）。**不可恢复**；其它会话的记录不受影响（共享 blob 只在不被任何会话引用时才删）。
- **字号**：字体选择器左边的 `A− 跟随 A+` 只调**本插件**的字号（步进 1px，范围 −4…+8px）；中间显示 `跟随` 表示在 DSH「字号大小」之上不做偏移，点它即恢复跟随。选择存 `localStorage`，字号与行高共用 `--drv-font-delta` 一起缩放。
- **文件类型图标**：直接复用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `FileTypeIcon`（代码文件是彩色品牌图标，其它按分类着色）；该模块缺失时回退为字母角标。

### 打开文件：三级链路

| 顺序 | 方式 | 说明 |
|---|---|---|
| ① | **选中的编辑器** | 宿主 `open-with-editor`，带 `line`/`col`：VS Code / Insiders / Cursor / Windsurf / VSCodium 走 `--goto file:line:col`，JetBrains 系走 `--line N file` |
| ② | **系统默认应用** | 官方远端 `remote.session.openWorkspacePath({path})` —— 与官方卡片「用默认应用打开」是同一条路（文件关联到 VS Code 时直接拉起它），代价是**无法定位到行** |
| ③ | **右侧内置预览** | shell 自带的 preview opener，能定位到行 |

- 编辑器选择器的图标取自宿主图标路由 `/open-in-app/icon/<id>`，与官方「打开方式」菜单用的是**同一枚真实应用图标**（未收录的编辑器回退字母块）。
- ② 以前调的是 `workspaces.openPath`：**任何官方客户端组合都没有 `workspaces` 服务**（客户端 workspace controller 只有 create / rename / pin / archive，没有 openPath），那一步在 web 与桌面都静默返回 false。现已改走官方远端；同理删掉了 `dsh.client.inject` 里并不存在的 `@deepseek-ai/dsh-client-runtime`（它的 `resolveWorkspacePath` 因此永久不可用）。
- 检测范围（Windows）：VS Code / VS Code Insiders / Cursor / Windsurf / VSCodium / Sublime Text / Notepad++ / IntelliJ IDEA / PyCharm / WebStorm；判据是 PATH 上的命令或已知安装路径存在。
- **探测只跑一次**：结果按会话缓存 10 分钟，进入审查 tab 不会重复探测；装了新编辑器可在下拉里点「**重新检测编辑器**」。

### 运行中小胶囊

会话进行中显示：`N 个文件已更改 ＋X −X`，与每轮卡片同一套 token；空闲自动隐藏；窄行下不会把自己压成竖排（`flex:none` + `nowrap`）。

注册在 `conversation.composer.dock` 槽，但**不留在槽里**：当前桌面版的 dock 落在输入框**下方**的状态行（紧挨上下文用量），所以 chip 会脱离文档流、浮到最上层（`position:fixed` + `z-index:60`），以**输入框自身的水平中心**为中线、停在其上沿 10px 处——和官方那个"滑到最底"按钮同一层同一带。位置来自 DOM 实测：从 chip 往上找到最近的、真的含输入框的祖先（`textarea` / `contenteditable`），窗口 resize 与输入框尺寸变化时重测。找不到可测的祖先（我们没见过的宿主）时不加这个类，chip 保持原样待在槽里，不会消失也不会报错。

### 设置 → 修改审查

- diff 与角标颜色：深浅两套预设（各 8 色）+ 一键预设，`localStorage` 持久化。
- 「隐藏官方『已编辑 N 个文件』卡片」开关（默认开）。
- 「往全局 AGENTS.md 注入『用简体中文思考』规则」开关（**默认开**）：宿主把一段规则写进 `~/.dsh/AGENTS.md`（不存在则创建）。**生效时机：无需重启**——DSH 每次请求都会重新读取该文件，当前会话也会收到"指令已更新"（设置页也写了这句提示）；只有插件自身宿主代码的更新才需要重启 DSH。段落用 `<!-- dsh-review-checkout:zh-thinking:start/end -->` 标记：重复注入幂等、关掉开关只移除这一段、你自己写的内容一个字节都不动；若文件里**已经有**等价规则（例如手写的"始终使用简体中文进行思考"），则只报告"未重复写入"。开关状态存在宿主侧（`diff-review-state/settings.json`），所以重启后依然一致。
- 记录占用与「清空本会话的修改记录」**不在设置页**：它们都搬到了审核 tab 的工具条上（见「审查 tab」一节）。

## 工作原理

```
tools/result 事件 ──► lib/index.js（Host）
      │                  记录 write/edit 的 op（含改动前后快照，单条上限 120k 字符、每文件 100 条）
      │                  按 root session 聚合（子代理的改动折进父会话）
      │                  追加一行到 ~/.dsh/profiles/<profile>/diff-review-state/<session>.jsonl
      ▼
session/follow + session/page（官方 RPC；Desktop 走 IPC 桥）
      ▼
lib/client.js（客户端）──► 每 5s 轮询重建 ──► 卡片 / 审查 tab / 小胶囊
                            本地转录解析作为兜底（宿主无数据或旧宿主）
```

- **不建自建 HTTP 路由**，不做跨 fiber RPC 拦截：只用官方 slot 注册 + 官方历史通道。
- **状态按会话分片、追加写**：`~/.dsh/profiles/<profile>/diff-review-state/<session>.jsonl`，**每次修改只追加一行**（`{"p":路径,"c":cwd,"o":op}`；撤回写 `{"p":路径,"n":保留条数}`，清空写 `{"t":"clear"}`）。这样「记一条 = 一次小 append」，不再像 v7 之前那样单文件全量重写（真实 dev profile 曾到 167 MB）；崩在写一半只丢最后一行，坏一个分片只影响一个会话，`n` 重放会重新套用「每文件 100 条」上限，死行超出生效记录 2 倍时在启动时压缩一次（临时文件 + rename）。单文件时期的 `diff-review-state.json` 会被**一次性**读入迁移成分片并改名为 `.migrated` 备份；profile 拆分前的 `profiles/web/diff-review-state.json` 同样只在本地无记录时导入，超过 16 MB 则跳过（避免每次启动解析并复制巨型文件），跳过原因写进诊断日志。旧记录里缺字段的 op 也不会再让整个 `summary` / `file` 响应挂掉。
- **路径围栏（三条来源，宿主自己认定）**：`open-with-editor` / `reveal` 只接受宿主能自行验证的绝对路径——① 本 profile 记录过的文件树（cwd 或文件所在目录）；② **被点击会话自己的工作区**：客户端把 `session` 一并上报，宿主用 live agent → `ctx.sessions` → `workspaceRegistry.readSessionHeader` 依次解析出该会话的 cwd，**命中即以它收窄**（此时其它 session 的工作区不算数）；③ 该会话无法解析时，退回「本进程已打开的工作区」（`ctx.agents.list()` 的 `header.cwd`）。请求里传的路径/工作区一律不采信。跨盘符路径一律不算「在树内」。
- **诊断日志**：`~/.dsh/profiles/<profile>/diff-review-debug.log`（记录 `state:` 行——分片目录 / 分片数 / 记录数 / 压缩与迁移结果、打开动作的 `editor spawned pid=…` / `editor exited code=…`、路径围栏的拒绝与放行来源、revert 调用等）。

## 撤回

- 工具 `diff_review_revert(path, op?)` 注册在官方基础层工具注册表（`@deepseek-ai/dsh-tools`），Web 与 Desktop 都能用；`op` 省略时撤回该文件的全部记录。
- 卡片上的 `撤销` 会按轮生成**倒序**的调用序列（最后一个操作先撤），填进输入框由你确认发送——插件不替模型执行工具调用。
- 审查视图详情头部还有一个单文件 `还原` 按钮。

### 为什么自建撤回（官方没有回滚机制）

官方 DSH 不提供文件内容回滚，也不保留可回滚的基线：客户端文件服务只读（`workspaceFiles` 没有 mutation）、`str_replace_editor` 未实现上游的 `undo_edit`、`write`/`edit` 的 `before`/`after` 全文只在结果时被压成 3 行上下文的 diff hunk，落盘的 meta 里没有全文。所以「撤销」必须由本插件自己存快照、并走 agent 工具通道写回。

完整审计（对象 `0.1.5-rc.2`，含全部证据路径、逐字原文与复核命令）：[docs/official-file-revert-audit.md](docs/official-file-revert-audit.md)。

## 兼容性

| 环境 | 状态 |
|---|---|
| `dsh web`（0.1.6-alpha.2 及更新） | ✅ 全部功能 |
| 旧宿主（≤0.1.5，`turnTail` 为 chain 语义） | ✅ 双代插槽注册兼容 |
| DSH Desktop | ✅ 记录 / 卡片 / 审查视图；`webServer` 缺失时打开回落行为并给出提示 |

## 开发

```bash
npm test                 # 135 条测试（node:test，含 host 与客户端冒烟）
npm run sync             # 把 lib/*.js 与 package.json 复制进实际被加载的 profile 副本
```

`npm run sync` 存在的理由：仓库里的改动**不会自动生效**——`dsh web` 加载的是 `~/.dsh/profiles/<profile>/node_modules/dsh-review-checkout` 下的副本，忘了同步就会得到"改了但没变"的假象。同步后：host 改动重启、客户端改动刷新。

目录：

```
lib/index.js            Host 插件（记录、持久化、RPC 端点、revert 工具）
lib/client.js           客户端 bundle（单文件，DSH client-modules 加载）
scripts/sync-profile.mjs  同步到 profile 副本
test/smoke.test.js      测试
docs/official-file-revert-audit.md  官方回滚能力审计（为什么必须自建撤回）
docs/open-fence-empty-state-diagnosis.md  「目标路径不在本次会话记录的文件范围内」诊断与修复（证据链）
```

## 更新日志

### 1.0.1

行为不变的清理版：只删死代码与重复实现，不改任何可观察行为（135 条测试全绿，与 1.0.0 基线一致），两个源文件净减 149 行。

- **删掉不可达的自定义 tooltip 机制**：`showTip` 只被 `Tip` 调用，而 `Tip` 从未被创建，`store.tip` 恒为 `null`、`TipLayer` 恒返回 `null`（连同一个永不触发的 `setTimeout` 与 `.drv-tip*` 样式）。
- **删掉死函数与死样式**：`windowSummary()` 全文件零引用；CSS 里 62 行旧审查视图（`.drv-*` 文件列表/详情/轮次卡片/右键菜单）与已下线的「记录占用条」（`.cdx-bar*`）规则从没有任何 `className` 引用。
- **删掉只写不读的状态**：`store.mode` 全仓唯一读点就是那个恒为真的 `if (store.mode === "latest")`；以及 `ChangePill` 里同一 selector 的重复订阅。
- **收敛重复判据**：未调用也未导出的 `truncatedSnapshot` 删除，`revertTextOf` / `unrecoverableCut` 里逐字相同的「截断侧」判定合并为 `isCutSide`（撤回安全判据不再有三份拷贝）；`handleRpc` 的 `body.session` 归一化、`buildSummary` 的 `latestTurn`、编辑/写入两个分支的相同尾部各只保留一份。
- **顺手的小优化**：语法高亮的关键词正则按语言预编译一次（原先每个标识符都 `new RegExp`），并修掉两处被自动编辑挤在同一行的格式。

### 1.0.0

首个正式版（0.9.1 的开发内容没有单独发布，一并在这一版里）。

- **修复**「用 VS Code 打开到行」报 `目标路径不在本次会话记录的文件范围内`：路径围栏改为三条来源（本 profile 记录树 / **被点击会话自己的工作区**——按 live agent → `ctx.sessions` → `workspaceRegistry.readSessionHeader` 解析 cwd 并据此收窄 / 兜底本进程已打开的工作区），同时修掉跨盘符路径被误判为「在树内」。
- **状态存储改为按会话分片 + 追加写**（`diff-review-state/<session>.jsonl`）：记一条 = 一次小 append，不再整表重写；撤回写 `n` 行、清空写 `clear` 行，崩溃只丢最后一行，坏一个分片只影响一个会话；旧的单文件自动迁移并改名 `.migrated`。
- **打开链路对齐官方**：第②步改用 `remote.session.openWorkspacePath`（原先调的 `workspaces.openPath` 在任何官方客户端组合里都不存在，永远静默失败），`reveal` 优先走官方 `sessionController.openWorkspacePath({action:'reveal'})`；删除不存在的 `@deepseek-ai/dsh-client-runtime` 依赖与其死代码。
- **运行中小胶囊改为浮层**：脱离 dock 行，浮在输入框上方居中 10px（与官方「滑到最底」按钮同层），找不到可测锚点时自动退回槽内原位。
- **每轮卡片支持悬停预览**：鼠标停在文件行上约 350ms，用官方 `HoverCard`（`variant:"preview"`）浮层显示该文件本轮的 diff；**diff 行仍由插件自己的渲染器绘制**，所以插件色板 / 语法高亮与审查 tab 一致（官方 `DiffBlock` 自带官方配色，故意不用）。
- **卡片统计改成「本轮净差异」**：以前把每个 op 片段的**全部**行数当改动（`old_string`/`new_string` 里带几行上下文就多算几行），还把同一文件的每次中间编辑各算一遍——实测一轮显示 `+401 −93`，而官方基于 git 快照的卡片只有 `+181 −7`。现在按「该范围第一条 op 的改动前内容 → 最后一条 op 的改动后内容」做真实行 diff，与官方同一语义（实测 `lib/index.js` 两边**都是 +60 −27**）。
- **大文件的估算只留给旧记录**：单条快照上限 120k 字符，`lib/client.js`（≈190KB）、`test/smoke.test.js`（≈150KB）这类文件的端点快照会被截断，而"两个截断头部"的 diff 毫无意义（曾把真有改动的文件算成 `+0 −0`）。现在除了逐 op 记录真实行数，还**把完整原文 gzip 压缩后随 op 一起存**（见下一条），所以 0.9.1 起的新记录大文件也是精确值；只有升级前的旧 op 会退化为逐 op 求和并用 **`≈`** 标出（悬停有说明）。
- **快照上限不再等于"数据丢失"，改为内容寻址 blob**：内存里仍按 120k 截断（上限的真正目的是**内存**，全量常驻 RAM），但被截断的那一侧会把完整原文存成 `diff-review-state/blobs/<sha256>.gz`，分片只留一个引用（`fbRef`/`faRef`）。于是：**大文件的撤回恢复可用**（以前一律拒绝："快照被截断，撤回会损坏文件"）、统计精确、行号恢复优先用完整原文。
- **去重**：blob 用内容哈希命名，而一条编辑链里"上一个 op 的 `after`"就是"下一个 op 的 `before`"——同一份 190KB 文本天然只存一份。实测（190KB 文件、33 次编辑的真实形状）：inline 完整原文 4.69MB → blob 去重后 1.81MB，**省 61%**。
- **分片瘦身 + 加载重建（阈值 32k，不只是被截断的）**：只要一侧够大（≥32k 字符）或曾被 `cap` 截断，就往 blob 存全文、分片行只留引用；加载时从 blob 解压（截断侧再 `cap()`）重建，**内存里的形态完全不变**。真实 profile 实测：**41.31MB → 分片 21.50MB + blobs 3.09MB = 24.59MB（省 40%）**。
- **旧记录也能一次性回收**：加载时会给"够大且完整"的旧侧面补 blob 引用（截断侧绝不 adopt——那不是全文，拿来恢复会把文件截断），然后重写该会话分片；上面那次 41MB → 24.6MB 就是这么来的（105 个 op 侧被回收）。剩下的 21.5MB 是**没有完整原文的旧截断副本**，无法追溯。
- **GC**：启动加载完成后清掉没人引用的 blob（被 `MAX_OPS` 挤掉、清空会话、撤回后遗留的），10 分钟内新写的 blob 不删（防另一个进程正在写）；有坏分片行时整个 GC 让位（那行可能含看不见的引用）。
- **向后兼容**：老分片（截断副本直接内联、或更早的 inline base64 全文）照常读；重写分片时把 inline 全文转成 blob。诊断日志会打印 `adopted=` / `offloaded=` / `rebuilt=` / `blobs=` / `blobs-gc=`。
- **悬停预览带上下文代码**：以前预览画的是"工具片段"的 diff（`old_string`/`new_string` 里没带上下文时，单行改动就只剩一行删 + 一行加）。现在宿主按范围端点算出**整文件差异**，裁成"每处改动前后 3 行 + 远处用 `⋯` 折叠"再发给客户端（与官方预览同一形状），浮层里能看到上下文，且行号是真实文件行号。宿主的区间 diff 有记忆化缓存，5 秒轮询不会重复算大文件的 diff。
- **diff 行不再自动换行**：审查 tab 的两个视图与悬停预览一律保持一行 + 横向滚动条（行宽 `max-content`，行尾「打开该行」按钮 sticky 在视口右缘）。
- **新增「中文思考注入」设置项（默认开启）**：勾选后宿主把一段带 `<!-- dsh-review-checkout:zh-thinking -->` 标记的"用简体中文思考"规则写进全局 `~/.dsh/AGENTS.md`（不存在则创建，新会话/新请求即生效）；关掉开关只移除这一段，用户自己写的内容一个字节都不动；文件里**已有**等价规则时只报告"未重复写入"。开关状态存宿主侧 `diff-review-state/settings.json`，重启后依然一致。
- 诊断日志新增 `state:` 行（分片目录 / 分片数 / 记录数 / 压缩与迁移结果）；旧记录缺字段的 op 不再让整个 `summary` / `file` 响应挂掉。

## 已知限制

- **升级前的旧记录**：1.0.0 之前落盘的 op 没有逐 op 行数、也没有被截断侧的完整原文，因此对**超过 120k 字符的大文件**，它们的撤回仍会被拒绝、统计显示 `≈` 估算值。重新编辑（产生新 op）后该文件即恢复精确与可撤回。
- **旧记录的磁盘占用无法回收**：blob 瘦身只对"有完整原文"的新 op 生效，旧 cut op 的 120k 截断副本仍留在分片里（当前 profile：35MB 分片中约 32MB 属于这类）。要立刻释放，只能清空该会话的记录或删除分片文件。

- **交付文件（`present`）不在本插件范围内**：官方 deliverables 的交付卡片保留原样，本插件只统计 `write` / `edit` 的 op。
- 官方**右侧栏**的「第 N 轮改动」审查视图与本插件的审查 tab 并存，两者入口与定位不同（右侧栏便于边看边改，插件的 tab 是全宽专注视图）。
- `撤销` 依赖宿主能启动编辑器/填写输入框；宿主不支持 `inputActions.setDraft` 时会退化为写入剪贴板。

## 致谢

灵感与早期实现来自 [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review)；文件类型图标与「打开方式」图标分别复用了 DSH 官方 `ui-primitives` 与 `host-open-in-app` 的资源。

## License

MIT
