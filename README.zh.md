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
| 空轮 | 该轮无修改时显示「本轮无文件修改」 |
| 持久 | 每个已结束轮次都会渲染，数据按轮向宿主查询，**刷新 / 重开对话后仍在** |
| 接管 | 默认隐藏官方在同一插槽（`conversation.chat.turnTail`）的「已编辑」卡片（`[data-changed-files]`）；可在 **设置 → 修改审查** 里关掉接管、两套并存。**官方那张交付文件卡片不受影响**，仍由官方显示 |

### 审查 tab（会话视图）

- **范围**：任意一轮 / 「全部修改」（会话累计）。
- **双视图**：左侧文件列表 + 右侧该文件 diff；**中间分割线可左右拖动**调整比例，双击恢复响应式默认宽度（左栏最小 140px、diff 至少 260px），宽度写入 `localStorage`；面板过窄（<520px）时自动只留 diff。
- **列表模式**：每文件一张可展开卡片，同时只展开一个，文件标题吸顶。
- **diff**：按扩展名高亮 JS/TS/JSON/CSS/C++/C#/Java/Go/Rust/Python/YAML/Shell/CMake 等；行号是**真实文件行号**：改动发生时即从未截断的快照恢复（`lineHint`），其次用存档快照，再次用磁盘上的当前文件定位，只有三者都不可得时才标注为相对行号；每行左侧有「在编辑器中打开该行」按钮。快照被存储上限截断的记录不再允许还原（否则会把文件截断）。
- **工具条**：轮次选择、双视图/列表切换、`＋N －M · N 文件`、**编辑器选择器**（原「刷新 / 清空」位置：刷新已由 5s 轮询承担，清空移到设置页）。
- **文件类型图标**：直接复用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `FileTypeIcon`（代码文件是彩色品牌图标，其它按分类着色）；该模块缺失时回退为字母角标。

### 打开文件：三级链路

| 顺序 | 方式 | 说明 |
|---|---|---|
| ① | **选中的编辑器** | 宿主 `open-with-editor`，带 `line`/`col`：VS Code / Insiders / Cursor / Windsurf / VSCodium 走 `--goto file:line:col`，JetBrains 系走 `--line N file` |
| ② | **系统默认应用** | `workspaces.openPath(abs)` —— 与官方卡片「用默认应用打开」是同一条路（文件关联到 VS Code 时直接拉起它），代价是**无法定位到行** |
| ③ | **右侧内置预览** | shell 自带的 preview opener，能定位到行 |

- 编辑器选择器的图标取自宿主图标路由 `/open-in-app/icon/<id>`，与官方「打开方式」菜单用的是**同一枚真实应用图标**（未收录的编辑器回退字母块）。
- 检测范围（Windows）：VS Code / VS Code Insiders / Cursor / Windsurf / VSCodium / Sublime Text / Notepad++ / IntelliJ IDEA / PyCharm / WebStorm；判据是 PATH 上的命令或已知安装路径存在。
- **探测只跑一次**：结果按会话缓存 10 分钟，进入审查 tab 不会重复探测；装了新编辑器可在下拉里点「**重新检测编辑器**」。

### 运行中小胶囊

会话进行中显示在输入框上方（`conversation.composer.dock`）：`N 个文件已更改 ＋X −X`，与每轮卡片同一套 token；空闲自动隐藏；窄行下不会把自己压成竖排（`flex:none` + `nowrap`）。

### 设置 → 修改审查

- diff 与角标颜色：深浅两套预设（各 8 色）+ 一键预设，`localStorage` 持久化。
- 「隐藏官方『已编辑 N 个文件』卡片」开关（默认开）。
- 「清空本会话的修改记录」按钮（原来在审查工具条上的 ✕）。

## 工作原理

```
tools/result 事件 ──► lib/index.js（Host）
      │                  记录 write/edit 的 op（含改动前后快照，单条上限 120k 字符、每文件 100 条）
      │                  按 root session 聚合（子代理的改动折进父会话）
      │                  原子写 ~/.dsh/profiles/<profile>/diff-review-state.json
      ▼
session/follow + session/page（官方 RPC；Desktop 走 IPC 桥）
      ▼
lib/client.js（客户端）──► 每 5s 轮询重建 ──► 卡片 / 审查 tab / 小胶囊
                            本地转录解析作为兜底（宿主无数据或旧宿主）
```

- **不建自建 HTTP 路由**，不做跨 fiber RPC 拦截：只用官方 slot 注册 + 官方历史通道。
- **路径围栏**：`open-with-editor` / `reveal` 只接受本会话记录过的文件树内的绝对路径。
- **诊断日志**：`~/.dsh/profiles/<profile>/diff-review-debug.log`（记录打开动作的 `editor spawned pid=…` / `editor exited code=…`、路径围栏拒绝、revert 调用等）。

## 撤回

- 工具 `diff_review_revert(path, op?)` 注册在官方基础层工具注册表（`@deepseek-ai/dsh-tools`），Web 与 Desktop 都能用；`op` 省略时撤回该文件的全部记录。
- 卡片上的 `撤销` 会按轮生成**倒序**的调用序列（最后一个操作先撤），填进输入框由你确认发送——插件不替模型执行工具调用。
- 审查视图详情头部还有一个单文件 `还原` 按钮。

## 兼容性

| 环境 | 状态 |
|---|---|
| `dsh web`（0.1.6-alpha.2 及更新） | ✅ 全部功能 |
| 旧宿主（≤0.1.5，`turnTail` 为 chain 语义） | ✅ 双代插槽注册兼容 |
| DSH Desktop | ✅ 记录 / 卡片 / 审查视图；`webServer` 缺失时打开回落行为并给出提示 |

## 开发

```bash
npm test                 # 78 条测试（node:test，含 host 与客户端冒烟）
npm run sync             # 把 lib/*.js 与 package.json 复制进实际被加载的 profile 副本
```

`npm run sync` 存在的理由：仓库里的改动**不会自动生效**——`dsh web` 加载的是 `~/.dsh/profiles/<profile>/node_modules/dsh-review-checkout` 下的副本，忘了同步就会得到"改了但没变"的假象。同步后：host 改动重启、客户端改动刷新。

目录：

```
lib/index.js            Host 插件（记录、持久化、RPC 端点、revert 工具）
lib/client.js           客户端 bundle（单文件，DSH client-modules 加载）
scripts/sync-profile.mjs  同步到 profile 副本
test/smoke.test.js      测试
```

## 已知限制

- **交付文件（`present`）不在本插件范围内**：官方 deliverables 的交付卡片保留原样，本插件只统计 `write` / `edit` 的 op。
- 官方**右侧栏**的「第 N 轮改动」审查视图与本插件的审查 tab 并存，两者入口与定位不同（右侧栏便于边看边改，插件的 tab 是全宽专注视图）。
- `撤销` 依赖宿主能启动编辑器/填写输入框；宿主不支持 `inputActions.setDraft` 时会退化为写入剪贴板。

## 致谢

灵感与早期实现来自 [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review)；文件类型图标与「打开方式」图标分别复用了 DSH 官方 `ui-primitives` 与 `host-open-in-app` 的资源。

## License

MIT
