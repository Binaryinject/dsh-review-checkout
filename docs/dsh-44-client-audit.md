# DSH 44.x（client 0.2.1-rc.5）客户端契约审计

审计对象：本插件的浏览器半边（`lib/client.js`）与宿主半边（`lib/index.js`）在
DeepSeek Harness 44.7.0 / `@deepseek-ai/*` 0.2.1-rc.5 下的兼容性。

审计方法：逐个扩展点对照新版包的 `dsh-cordis-client-runner` 契约表、
`dsh-web-frontend` 的 boot 静态模块表、`dsh-host-webserver` 的路由与
`dsh-client-connection` 的 RPC 实现，而不是看插件自己的注释。

## 结论

| 扩展点 | 新版契约 | 插件用法 | 结论 |
| --- | --- | --- | --- |
| `conversation.view` | list；`id` 必填，`label: string \| (() => string)` | `id: "review"`，`label: "审查"` | **曾不兼容**：label 曾是 React 元素，44.x 用 `for (const glyph of label)` 估宽会抛 `label is not iterable`，整行 tab 消失。已改为常量字符串 |
| `conversation.view` owner props | `inspectCall`、`viewRequest`、`openView`、`completeViewRequest` + standard props（含 `sessionId`、`inputActions`） | 用 `openView` / `completeViewRequest` / `viewRequest` / `sessionId` / `inputActions.setDraft` | 兼容 |
| `conversation.chat.turnTail` | list；`id` 必填；owner props `turn: TurnLocation`、`seq`、`openFile` | `id: "diff-review"`，读 `turn.turn`、捕获 `openFile`；额外带旧版 `select`/`priority` 字段（新版忽略） | 兼容（见风险 1） |
| `conversation.composer.dock` | list；`id` + `order` | `id: "diff-review-pill"`，`order: 999` | 兼容 |
| `conversation.session.header.actions` | list；owner props 只有 `children?: never`，`sessionId` 走 standard props | 读 `props.sessionId` 写入 store | 兼容 |
| `settings.section` | list，**root** scope；`label` 为文本 | `id/order/label: "修改审查"` | 兼容 |
| `sidebar.footer.action` | list，root；条目渲染在侧栏页脚 | 曾注册一个返回 `null` 的占位条目 | 无功能，已删除 |
| 服务依赖 `inject` | `slots`（ui-renderer）、`sessions`（api-session-controller）、`conversation`（ui-conversation 的 `super(ctx, "conversation")`） | `["slots", "sessions", "conversation"]` | 三个服务都存在，插件能正常 apply |
| 官方原语 | `@deepseek-ai/dsh-client-ui-primitives` 仍导出 `FileTypeIcon`、`HoverCard`（`variant` 支持 `"preview"`） | 直接 `require` 并用作文件图标与悬停预览 | 兼容 |
| 主题 | `body[data-ds-dark-theme]` | 同一属性 + `--dsh-content-font-size` 等 token | 兼容 |
| 官方改动文件卡片 | `[data-changed-files]` | 默认隐藏它以接管每轮卡片 | 属性仍由 `dsh-client-ui-deliverables` 输出，兼容 |
| 宿主 RPC | 浏览器 `rpc.call(channel, endpoint, payload)` → `POST /<channel>/<endpoint>`，响应必须是 `{type:"server-response", rpcId, result:{ok:true,value}}` | 客户端同签名调用；宿主在 `ctx.inject(['webServer'])` 里注册 `{kind:'prefix', path:'/diff-review', handler}` | 兼容（前缀匹配 `=== prefix \|\| startsWith(prefix + "/")`） |
| 工具事件 | `tools/result`（`exec`, `result`）仍在 | 宿主 `ctx.on('tools/result', …)` 记录 `write`/`edit` | 兼容，参数名仍是 `file_path` / `old_string` / `new_string` / `replace_all` |

## 本轮修复

1. **tab 整条消失**：`conversation.view` 的 `label` 改为常量字符串「审查」，
   tab 上不再挂数量（计数在胶囊与审查面板）。点击/选中判断改为在
   `[data-conversation-tabs]` / `[role=tablist]` 里按文案定位按钮。
2. **运行中「加载中…」与列表闪烁**：轮询每个 tick 曾提交两次列表
   （转录解析 → 宿主 summary），并让 `files` 依赖的 effect 再发一次 turn 请求。
   现在一个 tick 只提交一次、内容未变则完全不提交（`sameFileRows` /
   `samePayload`），`loadTurn` 载荷相同直接返回；`loadSummary` 只在列表为空时
   显示「加载中…」。
3. **清理**：删除 `sidebar.footer.action` 的空注册（44.x 会在侧栏页脚为它留位，
   虽然渲染 `null`，但没有功能）。

## 剩余风险（尚未修，均有明确原因）

1. **内置预览的行号**：44.x 的 `turnTail` 只给 `openFile(path)`，不再接受
   `{line}`。打开链路第 ③ 步（右侧内置预览）因此只能打开文件、不能定位行；
   第 ① 步（选定编辑器，走宿主 `/diff-review/open-with-editor`）仍精确到行。
2. **`turnTail` 的 `select` 字段**：旧版 `chain` 宿主需要它，新版 `list` 宿主忽略。
   保留是为了兼容旧组合；新版不校验未知选项，暂不构成风险。
3. **设置页可见性取决于组合**：本 profile 的 `cordis.patch.yml` 把
   `@deepseek-ai/dsh-client-ui-settings` 置为 `enabled: false`。该包被禁用时
   `settings.section` 槽不存在，插件的「修改审查」设置页自然也不出现——这不是
   插件的报错，要恢复设置入口需重新启用该行。

## 复核方式

```powershell
# 契约表（新版自己声明的 slot 选项与 owner props）
Select-String -Path "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-cordis-client-runner\lib\client.js" -Pattern 'key: "conversation.view"','key: "conversation.chat.turnTail"'

# label 的估宽实现（React 元素会在这里抛错）
Select-String -Path "...\dsh-client-ui-conversation\lib\client.js" -Pattern 'labelNeedsTooltip' -Context 0,6

# 服务是否仍存在（slots / sessions / conversation）
Select-String -Path "...\*.js" -Pattern 'super\(ctx, "(conversation|slots)"'
```
