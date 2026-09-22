# 审计：官方 DSH 的文件回滚能力

**结论：官方 DSH 没有「把文件内容还原到先前版本」的机制，也不保留可回滚的基线。**
本插件的 `diff_review_revert` 与逐轮 `撤销` 不是「官方已有的功能的复刻」，而是补上一个官方在四个层面刻意排除的能力。

- **审计对象**：官方 `@deepseek-ai/*` 包群，版本 **`0.1.5-rc.2`**（约 240 个包；`dsh`、`dsh-tools`、`dsh-tool-fs`、`dsh-tool-str-replace-editor`、`dsh-agent-loop`、`dsh-api-workspace-files`、`dsh-client-ui-deliverables` 均为此版本）。
- **审计方式**：只读。对 `lib/**/*.js` 与各包 `README.md` 全树检索后再逐条通读命中点；vendored 第三方包（`pdfjs`、`codemirror`、highlight 语法）中的 `undo` 命中已排除，不作为发现。
- **日期**：2026-09-22。
- 下文路径均为**官方包内路径**（省略 `<install>/node_modules/` 前缀），行号对应上述版本。

## 1. 四条硬证据

1. **客户端没有写文件的能力。** `@deepseek-ai/dsh-api-workspace-files/README.md:12`：
   > "The service exposes no mutation operation."

   该服务只暴露 `read` / `readBytes` / `readAll` / `readRelated` / `stat` / `list` / `changes`，全部只读。浏览器侧在架构上就无法回滚文件。
2. **上游工具自带的 `undo_edit` 被刻意未实现。** `@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js:272-278` 的 `command` enum 只有 `view` / `create` / `str_replace` / `insert`，而 Anthropic 原版 `str_replace_editor` 是有 `undo_edit` 的。
3. **全量 `before`/`after` 从不落盘。** `@deepseek-ai/dsh-agent-loop/lib/index.js:697-713` 的 `appendToolResult` 只 append `{ turn, step, message(content/isError), error?, meta? }` —— 含全文的结构化 `value` 被丢弃；持久层只有 `meta.diffs`（每个 hunk 带 3 行上下文）。
4. **改动卡片上唯一的动作是「打开」。** `@deepseek-ai/dsh-client-ui-deliverables/lib/client.js:866,869` 的字典只有 `produced.label`（`"本轮文件改动"`）与 `produced.open`（`"打开 {name}"`），渲染处 `client.js:532-539` 的 `onClick` 只调用 `openFile(path)`。

全树中文 UI 文案 grep `撤销|回退|还原|回滚|恢复到` 仅 1 处命中：`@deepseek-ai/dsh-client-ui-cordis/lib/client.js:1195` 的 `"action.rollback": "回退"`，属动态插件版本回退。

## 2. `undo` / `revert` / `rollback` 命中的真实语义

| 语义 | 命中与结论 |
|---|---|
| **文件内容回滚** | **零命中。** 除上述证据外，侧栏预览 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/README.md:75`：*"Preview, not editing."* |
| **事务性回滚** | 全部 `rollback` 命中的真实语义：`cordis-plugin-loader/lib/index.js:105-120`、`dsh-agent/lib/index.js:415`（"rollback-covered publication"）、`dsh-workspace/lib/index.js:515-536`、`dsh-subagent/lib/index.js:1120`（`rollbackUnpublished`）、`dsh-session-persistence-jsonl/lib/index.js:3074`（`rollbackAppend`）、`dsh-scope/lib/index.js:204-212`、`dsh-skill/lib/index.js:165-175`；UI 侧 `dsh-client-ui-cordis/lib/client.js:955` 是插件 Package 回退。**都不是文件内容。** |
| **编辑器 undo 栈** | `dsh-client-ui-conversation/lib/client.js:11531,11538-11572`（输入框 Lexical 的 `undoStack`）；`:12808-12809` 注释说明发送后主动清空撤销历史，使 `Ctrl/Cmd-Z` 无法复活已发送内容。 |
| **UI 布局 undo（额外发现）** | `dsh-client-ui-sidebar-right/lib/client.js:597-602`、`:1382-1391`（dockkit `stepBack`），被源码显式标注为非产品功能，见第 5 节。 |

## 3. `before`/`after` 的确存在——但只服务于渲染

- fs 层返回全文：`dsh-fs/lib/types/types.d.ts:118-134`（`FsWriteOutcome{ before: string | null; after: string }`）、`:145-156`（`FsEditOutcome{ before: string; after: string }`）。注释 `:127-129` 明确它只是 diff 基线：
  > "LF-normalized storage text (the diff basis), **never a diff** — a consumer computes the result-time contextual diff from `before`/`after` …"
- 工具的输出 schema 也带全文：`dsh-tool-fs/lib/index.js:626-633`（write）、`:775-783`（edit），`execute` 返回 `{ path, operation, before, after }`（`:661-666` / `:814-818`）。
- **唯一消费者是 diff 计算**：`presentationMeta: (args, value) => ({ diffs: computeHunkDiffs(args.file_path, value.before, value.after) … })`（`:640-644` / `:789-793`），`computeHunkDiffs` 用 jsdiff `structuredPatch(..., { context: 3 })`（`:484`，`DIFF_CONTEXT = 3` 见 `dsh-tool-fs/lib/types/diff.d.ts:6`）。
- **落盘的 meta 只有 hunk**：`dsh-tool-fs/lib/types/diff.d.ts:12-16` 的 `FsDiffMeta = { diffs: FileDiff[] }`，注释说明它随会话日志持久化以便 `presentResult` **在回放时复原卡片**。`FileDiff` 只有 `{ path, oldText, newText }`（`dsh-tools/lib/types/presentation.d.ts:30-36`）——**没有行号字段**。行号只出现在 `FileLocation.line`（`:20-23`），那是给「在编辑器中打开第 N 行」用的。
- 卡片数据流：调用时 `presentCall(args)` 直接用**参数**（edit：`:820-830`，`oldText: args.old_string`）；完成时 `presentResult` 从 `result.meta.diffs` 复原（`:832-839`），meta 缺失才回退参数。即：**pending 卡来自参数，结果卡来自 hunk，重放卡来自日志 meta —— 三处都没有可用于还原的文本。**

## 4. `dsh-session-checkpoint-policy` 只管 durability

- `dsh-session-checkpoint-policy/README.md:12`：*"Semantic session **durability** checkpoints … that must not lose a model request or tool side effect on crash."*
- 实现只在三个 seam 做 flush 屏障：`llm/stream` 之前、顶层 `tools/execute` 之前、`agent/pre-step` 边界（`lib/index.js:4-6,50-52`），失败 fail-closed。
- 全树 `checkpoint` 的其余命中属 compaction 标记、projection-cache 检查点、chunked-list/storage 检查点——**没有一处是文件内容检查点**。

## 5. 没有 session 级「回到某一轮并恢复文件」

- `rewind` 全树**零命中**。
- `loadThrough(seq)`（`dsh-api-session-controller/README.md:33`）是只读翻页导航（"the turn-jump loader"），不改状态、不碰文件。
- Session 的 resume / fork 恢复的是**对话日志**而非文件：`dsh-session-reference/README.md:137`：*"No live link — references are snapshots, not forks, resumes, subscriptions, or source-session mutations."*

## 6. 刻意缺失的原文（逐字）

- `dsh-client-ui-sidebar-right/lib/client.js:1385-1386`（唯一真正的 undo 动作被标为非产品）：
  > `@internal Not part of the product: the sequence is an architectural fact` / `with no user-facing control yet. Kept reachable for tests.`
- `dsh-api-workspace-files/README.md:12`：> "**The service exposes no mutation operation.**"
- `dsh-client-ui-sidebar-documentpreview/README.md:75`：> "**Preview, not editing.** …"
- `dsh-client-ui-deliverables/README.md:99`：> "**Declarations do not preserve file contents** — reopening or transferring a Session requires source files accessible through the viewed Session's filesystem."
- `dsh-fs-observation-policy/README.md:126`：> "**Observed state does not survive a session resume** — persistence of the record is deferred, so a resumed session must re-read files before guarded writes and edits."
- `dsh-client-ui-conversation/lib/client.js:12808-12809`：> "Clear the draft as a successful-send commit: the editor empties (no undo step) and the undo history is cut, so Ctrl/Cmd-Z cannot resurrect sent content."

## 7. 「本轮文件改动」卡片是纯客户端推导（只有路径）

`dsh-client-ui-deliverables/lib/client.js`：

1. `deliverablesDefinition` 注册于 `:932`（`ctx.uiConversation.events.register(...)`），`match` 只吃 `turn/start` / `tool/call` / **append 型** `tool/result`（`surfaceOp === "append"`，`:271-273`）/ `deliverables/presented`（`:367-385`）。
2. 路径来自 **`tool/call` 的原始参数**：`mutationPath(name, argsRaw)`（`:289-303`）只认 `write`（需 `content`）、`edit`（`validEditArgs`，`:305-307`）、`str_replace_editor`（仅 `create`/`str_replace`/`insert`，`:309-318`）；读类工具、失败结果、畸形参数一律不贡献。
3. 折叠成 turn 作用域的 Location data（key `deliverables`，值 `{ produced: [{ seq, path }] }`，`:433-445`），`producedForClosing` 按 seq 截断、按路径去重保首见顺序（`:344-354`），`ProducedFiles` 渲染标签 + 至多 6 个 chip（`:520-559`）。
4. 其设计注释（`:275-280`）：
   > "Client-only and model-free: the vocabulary comes from successful first-party mutation calls, **never presentation data or the closing prose**."

即：**卡片知道「哪些文件变了」（path + seq），完全不知道「变成了什么」，也没有任何内容快照参与。** 这也是本插件客户端半注释里那句 *"the transcript carries tool args + the result's rendered text, never the raw before/after value"* 的一手依据——结构化 `value` 不进会话日志。

## 8. 边界

唯一真能「还原文件」的路径是**模型自己用 `bash` / `pwsh` 跑 `git restore` / `git checkout`**——那是外部工具能力，harness 既不提供、也不记录、更不暴露基线。

`dsh-fs-observation-policy` 的 `FS_STALE_VERSION` / `FS_NOT_OBSERVED`（先读再写、外部改动则拒绝）是**前置防冲突**，不是事后回滚：`README.md:129` 明确 *"Authorization is version freshness, not view completeness"*。

## 9. 对本插件的含义

| 层面 | 官方 DSH | 本插件 |
|---|---|---|
| 谁记录改动 | 客户端折叠 `tool/call` 参数（只有 path/seq） | host 监听 `tools/result`，读取 `value.before`/`after` 全文 |
| 持久化什么 | 只存 3 行上下文的 hunk（供卡片回放） | 存全文快照（`MAX_CHARS` 上限）+ `lineHint` / `beforeLen` / `afterLen` |
| 行号 | 无此概念（`FileDiff` 无行号字段） | 三层定位：记录时的 `lineHint` → 存档快照 → 磁盘当前文件 |
| 写回文件 | 客户端无写 API；工具无 `undo_edit` | `diff_review_revert` 工具经 agent 工具通道写回（`defineTool` 输出 schema 受 `additionalProperties: false` 校验） |
| 安全网 | 无（`FS_STALE_VERSION` 只是写前防冲突） | 快照被上限截断的记录拒绝还原；op 级撤回走 merge3 合并 |

结论：**本插件的撤回是这套系统里唯一的文件级撤销能力**——因此必须自建快照、自建工具通道，并自行承担「行号恢复」这类官方根本没提供的信息。

## 10. 如何复核

```bash
cd <dsh-install>/node_modules/@deepseek-ai     # 或 pnpm store 中 @deepseek-ai/dsh-*
rg -n 'revert|rollback|rewind' --glob 'lib/**/*.js'
rg -n '撤销|回退|还原|回滚|恢复到' --glob 'lib/**/*.js'
rg -n 'undo_edit' --glob 'lib/**/*.js'
rg -n 'no mutation operation' --glob '**/README.md'
rg -n 'presentationMeta|computeHunkDiffs' lib/../dsh-tool-fs/lib/index.js 2>/dev/null || rg -n 'presentationMeta|computeHunkDiffs' dsh-tool-fs/lib/index.js
```

预期：文件内容回滚零命中；`rollback` 全部落在事务/插件语义；`undo_edit` 只在 `str_replace_editor` 的上游文档里被提及（实现中不存在）。
