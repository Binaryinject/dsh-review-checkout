# dsh-review-checkout

[DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）**会话修改审查插件** —— [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review) 的加固 + Codex 风格重构版，适配 DSH Desktop 与 `dsh --profile web`。

会话内 `write`/`edit` 工具调用会被追踪并以以下形态呈现：

- **Codex 风格每轮卡片**（对话流每轮尾部，记录**该轮**的修改）—— 文件类型徽章、`＋N −M` 统计、时间戳，多文件时列出清单（**完整路径** + 每文件统计，单击单个文件跳审查 tab 并只展开它）；点击卡片任意处跳转审查 tab
- **审查 tab**（会话视图）—— 按卡片跳转的**对应轮次**展示：文件卡 → 展开语法高亮 diff（行号、`+ / −` 前缀、左缘色条；按扩展名自动识别 JS/TS/JSON/C++/Python/YAML/Shell/CMake 等），顶部吸顶「当前文件」标题条随滚动切换并可折叠/展开
- **运行中小胶囊**（会话进行中，输入框上方）—— `N 个文件已更改 ＋X −X`，与每轮卡片同款主题样式（同填充/边框/统计色），空闲自动隐藏
- **主题化 UI** —— 深浅两套独立配色、自动跟随 DSH 主题；tooltip 与文本选区使用 DSH 设计变量

## 安装

```bash
dsh plugin add dsh-review-checkout
```

确认 profile 配置注册了 bundle patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- insert:
    - id: diff-review
      name: 'dsh-review-checkout'
```

**Host 端改动需重启 DSH Desktop**（或 `dsh --profile web`）；客户端改动仅需刷新页面。

## 功能

| 模块 | 说明 |
|---|---|
| 数据通道 | 官方 `session/follow` + `session/page` RPC（Web 走 RPC fetch，Desktop 走 IPC 桥）——无自建 HTTP 路由，兼容 Desktop 分层组合 |
| 每轮卡片 | 每一轮一张，外观照官方 `dsh-client-ui-deliverables` 的「已编辑」卡片（同款圆角 16px 卡片 / 36px 图标块 / `+N −M` 统计 / 折叠行，颜色跟随 DSH 主题）：规则 = 该轮无修改时显示「本轮无文件修改」；文件清单默认最多 3 行，超出用「**全部 N 个文件** ⌄」展开（单击单个文件跳审查 tab 并**只展开该文件**，其余收起）；`撤销`（按该轮生成倒序 op 序列，只撤回这一轮的修改）、`审核` 跳审查 tab；头部整行可点击；默认**接管**官方 deliverables 挂在同一插槽的「已编辑」卡片（隐藏它，可在 设置 → 修改审查 里取消接管、两套并存；官方那张交付文件卡片不受影响，仍由官方显示） |
| 审查 tab | 从卡片跳转后按**对应轮次**展示，顶部有 **「双视图 / 列表」切换**：双视图 = 左侧文件列表 + 右侧详情面板（**中间的分割线可左右拖动调整两侧宽度，双击恢复默认**；头部带该文件的 `还原` 按钮）；列表 = 每文件一张可展开卡片（语法高亮 diff、**同时只展开一个文件**、文件标题吸顶）；两种模式共享选中/展开状态，来回切换不丢失；工具条右侧是**编辑器选择器**（顶替了原来的刷新 / 清空按钮：刷新由 5s 轮询承担，清空移到设置里）；列表每行的文件类型图标直接复用官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `FileTypeIcon`（彩色品牌图标 / 分类色字形，与 DSH 其它界面一致；该模块缺失时回退为字母角标） |
| 实时刷新 | 5s 轮询；含运行态小胶囊与主题同步 |
| 颜色 | diff 与角标为深浅两套独立预设（各 8 色），**设置 → 修改审查** tab 切换；卡片与运行中小胶囊统一用 DSH 主题 token，自动跟随主题 |
| 撤回 | 每轮卡片按轮签发 `diff_review_revert` op 序列（最后一个操作开始倒序撤回，不影响其他轮的修改）；审查双视图详情面板头部也有该文件的 `还原` 按钮——工具注册在官方基础层工具注册表（`@deepseek-ai/dsh-tools`），Web 与 Desktop 均可用 |
| 其他 | 编辑器选择器（审查工具条；图标直接取宿主 `/open-in-app/icon/<id>`，与官方「打开方式」菜单用的是**同一枚真实应用图标**，未收录的编辑器回退字母块）+ 三级打开链：① 选了编辑器 → 用它打开并**定位到行**（宿主 `open-with-editor`，带 line/col）；② 未选、或编辑器被宿主拒绝/启动失败 → **系统默认应用**（与官方卡片「用默认应用打开」同一条路，文件关联到 VS Code 时直接拉起它）；③ 再不行 → 右侧内置预览。每一级的失败都会在界面上说明原因，绝不静默。另有主题化自定义 tooltip、完整路径显示、原子写状态文件 |

## 配置

- **设置 → 修改审查**：浅色/深色两个 tab，各 8 色（增删行背景与文字、上下文行、行号、标签角标）、预设按钮，`localStorage` 持久化；另有「隐藏官方已编辑卡片」开关
- 状态文件：`~/.dsh/profiles/<profile>/diff-review-state.json`（删除即清空审查历史）

## 架构

- `lib/index.js`（Host）：把 `write`/`edit` 工具调用写入会话状态；原子 JSON 持久化
- `lib/client.js`（客户端）：经官方通道 `session/follow`（snapshot）+ `session/page`（分页）加载会话历史，解析 `tool/call` / `tool/result` 为审查记录，渲染 Codex 风格 UI
- 第三方约束：不碰私有层服务（`webServer`、`connection` 代理）、不做跨 fiber RPC 拦截——仅官方 slot 注册与历史 API

## 兼容性

- ✅ DSH Desktop（分层作用域：渲染器 + 官方 slot）
- ✅ `dsh --profile web`（完整撤回）
- ⚠️ Desktop 撤回按钮按设计禁用（`webServer` 在私有 web-app 层）

## 开发

```bash
pnpm install
pnpm test        # 24 个单元 + 冒烟测试
```

客户端 bundle 由 DSH `client-modules` 加载；Host 改动需重启 Desktop，客户端改动只需刷新。

## 致谢

灵感来自 [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review)，基于社区对官方会话历史通道的调研成果构建。

## License

MIT
