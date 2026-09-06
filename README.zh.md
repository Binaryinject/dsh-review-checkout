# dsh-review-checkout

[DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）**会话修改审查插件** —— [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review) 的加固 + Codex 风格重构版，适配 DSH Desktop 与 `dsh --profile web`。

会话内 `write`/`edit` 工具调用会被追踪并以以下形态呈现：

- **Codex 风格每轮卡片**（对话流每轮尾部，记录**该轮**的修改）—— 文件类型徽章、`＋N −M` 统计、时间戳，多文件时列出清单（**完整路径** + 每文件统计，单击单个文件跳审查 tab 并只展开它）；点击卡片任意处跳转审查 tab
- **审查 tab**（会话视图）—— 按卡片跳转的**对应轮次**展示：文件卡 → 展开语法高亮 diff（行号、`+ / −` 前缀、左缘色条；按扩展名自动识别 JS/TS/JSON/C++/Python/YAML/Shell/CMake 等），顶部吸顶「当前文件」标题条随滚动切换并可折叠/展开
- **运行中小胶囊**（会话进行中，输入框上方）—— `N 个文件已更改 ＋X −X`，空闲自动隐藏
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
| 每轮卡片 | 每一轮一张（该轮无修改时显示「本轮无文件修改」）：`已编辑 D:\...\client.js 等 2 个文件 ＋N −M`、文件清单（**完整路径** + 每文件统计；单击单个文件跳审查 tab 并**只展开该文件**，其余收起）、`撤销`（按该轮生成倒序 op 序列，只撤回这一轮的修改）、`审核` 跳审查 tab；整卡可点击 |
| 审查 tab | 从卡片跳转后按**对应轮次**展示：文件卡 → 展开语法高亮 diff（hunks/行号/`+ −`）、展开/收起全部、刷新、清空；文件标题自身吸顶（滚动时依次切换为正在浏览的文件，点击可折叠/展开） |
| 实时刷新 | 5s 轮询；含运行态小胶囊与主题同步 |
| 颜色 | 深浅两套独立预设（各 12 色），**设置 → 修改审查** tab 切换；自动跟随 DSH 主题；`::selection` 随主题 |
| 撤回 | 每轮卡片按轮签发 `diff_review_revert` op 序列（最后一个操作开始倒序撤回，不影响其他轮的修改）——依赖 `webServer` 通道，`dsh --profile web` 可用；Desktop 挂载渠道时自动隐藏按钮 |
| 其他 | 编辑器选择器（会话头）、主题化自定义 tooltip、完整路径显示、原子写状态文件 |

## 配置

- **设置 → 修改审查**：浅色/深色两个 tab，各 12 色（增删行背景与文字、上下文行、行号、标签角标）、预设按钮，`localStorage` 持久化
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
