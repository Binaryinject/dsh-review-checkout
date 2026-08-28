# dsh-review-checkout

[DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）**会话修改审查插件** —— [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review) 的加固 + Codex 风格重构版，适配 DSH Desktop 与 `dsh --profile web`。

会话内 `write`/`edit` 工具调用会被追踪并以以下形态呈现：

- **Codex 风格每轮卡片**（对话流每轮尾部）—— 文件类型徽章、`＋N −M` 统计、时间戳，多文件时列出清单（相对路径 + 每文件统计）；点击卡片任意处跳转审查 tab
- **审查 tab**（会话视图）—— 聚合**最新一轮**：文件卡 → 展开语法高亮 diff（行号、`+ / −` 前缀、左缘色条；按扩展名自动识别 JS/TS/JSON/C++/Python/YAML/Shell/CMake 等）
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
| 数据通道 | 官方 `connection.api.sessions.history`（Web 走 RPC fetch，Desktop 走 IPC 桥）——无自建 HTTP 路由，兼容 Desktop 分层组合 |
| 每轮卡片 | 仅最新一轮：`已编辑 client.js 等 2 个文件 ＋N −M`、文件清单（相对路径，悬停完整路径）、`撤销`（仅 Web 组合）、`审核` 跳审查 tab；整卡可点击 |
| 审查 tab | 最新一轮聚合：文件卡 → 展开语法高亮 diff（hunks/行号/`+ −`），展开/收起全部、刷新、清空 |
| 实时刷新 | 5s 轮询；含运行态小胶囊与主题同步 |
| 颜色 | 深浅两套独立预设（各 12 色），**设置 → 修改审查** tab 切换；自动跟随 DSH 主题；`::selection` 随主题 |
| 撤回 | 单项/整文件（防抖确认）——依赖 `webServer` 通道，`dsh --profile web` 可用；Desktop 挂载渠道时自动隐藏按钮 |
| 其他 | 编辑器选择器（会话头）、主题化自定义 tooltip、相对路径显示、原子写状态文件 |

## 配置

- **设置 → 修改审查**：浅色/深色两个 tab，各 12 色（增删行背景与文字、上下文行、行号、标签角标）、预设按钮，`localStorage` 持久化
- 状态文件：`~/.dsh/profiles/<profile>/diff-review-state.json`（删除即清空审查历史）

## 架构

- `lib/index.js`（Host）：把 `write`/`edit` 工具调用写入会话状态；原子 JSON 持久化
- `lib/client.js`（客户端）：经官方通道 `api.sessions.history`（分页窗口）加载会话历史，解析 `tool/call` / `tool/result` 为审查记录，渲染 Codex 风格 UI
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

灵感来自 [cirelir/dsh-change-review](https://github.com/cirelir/dsh-change-review)，基于社区对官方 `api.sessions.history` 通道的调研成果构建。

## License

MIT
