# 「外部打开失败（目标路径不在本次会话记录的文件范围内）」诊断

对象：DSH Desktop（官方桌面版，2026-09-28 构建，`DSH_PROFILE=desktop`）+ 插件 0.9.0（修复随 0.9.1 发布）。
症状：在审查卡片上点「用 VS Code 打开到行」，弹出
`外部打开失败（目标路径不在本次会话记录的文件范围内）；已在右侧内置预览中打开。`

## 证据链

1. 插件诊断日志 `~/.dsh/profiles/desktop/diff-review-debug.log` 里有 8 次拒绝，涉及两个真实路径：

   ```
   open-with-editor rejected by path fence: D:\GIT\dsh-review-checkout\README.md
   open-with-editor rejected by path fence: D:\SVN\fst2\ProjectGay\ProjectGay\Assets\Kirurobo\UniWindowController\Samples\Kirurobo.UniWindowController.Samples.asmdef
   ```

2. 宿主当前 profile 的记录文件 `~/.dsh/profiles/desktop/diff-review-state.json` 当时是
   `{"version":1,"savedAt":…,"sessions":{}}`——**零条记录**。围栏只认记录，所以当时**任何**路径都会被拒。

3. 同一时刻，本次拒绝的两个路径都能在**旧位置的**状态文件里找到：
   `~/.dsh/profiles/web/diff-review-state.json`（167 MB，`savedAt=2026-09-25T13:10:19Z`，40 个会话、198 条匹配记录）：
   - `D:\GIT\dsh-review-checkout\README.md`（会话 `session-ee7f9bae…` 等，2026-09-07 / 09-18 的 edit+write）
   - `…\Kirurobo.UniWindowController.Samples.asmdef`（会话 `c225e74e…`，2026-09-25T13:10Z 的 write+edit，`lineHint.line=164`）

4. 复查 `stateFilePath()` 的兜底与迁移代码：`legacyStateFilePath(ctx)` 当时**逐字返回**
   `stateFilePath(ctx)`，因此 `loadStateInto()` 里的 `legacy !== file` 永远为假——迁移是死代码。
   而 `stateFilePath()` 自己的 no-ctx 兜底恰恰就是 `dshHomePath('profiles','web', …)`，
   也就是第 3 步那份装满了历史的文件。桌面 profile 从来没有自己的记录文件，于是从空记录启动。

5. 界面为什么还看得见文件？审查视图的卡片在宿主无数据时用**本地转录解析**兜底（README「工作原理」一节），
   于是出现「卡片看得见 + 宿主没记录」的组合，点击必然撞上围栏。

6. 复现（对运行中的宿主直接打官方 RPC，`POST http://127.0.0.1:19387/diff-review/open-with-editor`）：

   | 请求 | 结果 |
   |---|---|
   | `D:\GIT\dsh-review-checkout\README.md`（当时该 cwd 下无记录） | `目标路径不在本次会话记录的文件范围内` |
   | 任意已记录树内的路径（临时探针文件写入后） | 通过围栏，报「编辑器 … 未检测到」= 围栏放行 |

## 根因

路径围栏只有一条来源——**本 profile 从 `write`/`edit` 工具结果里记录过的文件树**。它没有覆盖：

- 只被**读**过（从未写入）的文件；
- 会话转录兜底重建出来的旧卡片（宿主无记录，界面照旧显示）；
- 状态文件为空/未迁移/被 `MAX_OPS` 挤掉记录的情况。

叠加两个缺陷，使上面这类卡片 100% 打不开：

1. `legacyStateFilePath()` 与 `stateFilePath()` 恒等 → 迁移永不触发（见证据 4）；
2. 同一函数的旧内联围栏判断 `!relative(...).startsWith('..')` 在 **跨盘符**时会把
   `relative()` 返回的目标绝对路径判为「在树内」（Windows 语义），围栏因此既漏又紧。

## 修复（v0.9.1 方向）

| 位置 | 改动 |
|---|---|
| `lib/index.js` `legacyStateFilePath()` | 返回真实的旧位置 `profiles/web/diff-review-state.json`，恢复「一次性迁移」语义；`loadStateInto()` 增加 16 MB 上限（整张表每次修改都会重写，导入巨型文件会让每次保存写 100 MB+），并把 `state:` 结果写进诊断日志 |
| `lib/index.js` `withinTree()` / `isSafeRecordedPath()` | 抽出纯函数 `withinTree()`，跨盘符（`isAbsolute(relative(…))`）判为**树外** |
| `lib/index.js` `openWorkspaceRoots()` / `isInsideOpenWorkspace()` / `openFenceArm()` | 围栏第二条来源：**当前打开的工作区**，根取自宿主自己的 `ctx.agents.list()` → `agent.session.header.cwd`，绝不采信请求里的路径；日志区分 `record` / `workspace` 两种放行 |
| `lib/index.js` `splitLines()` | 对 `null`/非字符串做全定义，旧记录缺字段不再让整个 `summary` / `file` 响应 500 |
| `test/core.test.js`、`test/smoke.test.js` | 7 条新测试：跨盘符、`..` 逃逸、工作区兜底（含会话关闭后收口）、迁移一次性、迁移体积上限、旧记录缺字段、以及「无记录 + 有工作区」的端到端打开 |

验证：

- `node --test test/core.test.js test/smoke.test.js` → 90 条，89 通过、1 条件跳过；
- 复刻本次两个真实路径的脚本（`logs/verify-real-paths.mjs`，gitignored）：两条都被 `open-workspace` 放行，
  `C:\Windows\…\hosts` 与 `…\ProjectGayX\sibling.js` 仍被拒。

## 遗留

- 旧历史（167 MB）**不会**被自动导入（体积上限）；要在桌面 profile 里恢复 9/25 之前的完整审阅历史，
  需要按会话挑选合并，或把状态文件改成 per-session / 增量写。
- 围栏的工作区来源目前是「本进程打开的所有工作区」；更紧的做法是让客户端把 `session` 一并上报，
  由宿主按该会话的 cwd 收窄（本次未改客户端，避免扩大改动面）。

## 后续（同批落地）

上面第二条「遗留」已实现，另外两条死代码也一并清掉：

| 改动 | 依据 |
|---|---|
| 客户端在 `open-with-editor` 里上报 `session`；宿主按 live agent → `ctx.sessions.get(id)` → `workspaceRegistry.readSessionHeader(id)` 解析该会话 cwd，**命中即收窄**（其它会话工作区失效），解析不到才退回「本进程已打开的工作区」 | `dsh-session/lib/index.js:1621`（宿主 sessions 服务）、`dsh-workspace/lib/index.js:911`（持久化 header）、`dsh-api-session-controller/lib/typert.host.js:2017`（header 含 cwd） |
| 打开链路第②步改官方 `remote.session.openWorkspacePath({path})`；删除 `workspaces.openPath` 分支、死代码 `openViaWorkspace` 与未被调用的 `openFileFor`；从 `dsh.client.inject` 删掉不存在的 `@deepseek-ai/dsh-client-runtime` | 官方客户端无 `workspaces` 服务；`dsh-client-runtime` 在 asar 内 0 命中；官方 open-in-app 客户端 `lib/client.js:440-453` 即调 `remote.session.openWorkspacePath` |
| 宿主 `reveal` 优先走官方 `sessionController.openWorkspacePath({path, action:'reveal'})`，失败再回退到 `explorer.exe` | `dsh-api-session-controller/lib/index.js:2847,3031`；官方 deliverables 宿主半 `lib/index.js:135` 同款调用 |

未做（需先实测/专项设计，盲改风险高于收益）：

- **状态存储迁到官方 storage / 按会话分片**：要先把 `ctx.storageDomain` 的 API 与迁移路径读清，且格式变更有丢历史风险。
- **改用官方鉴权通道**（`ctx.connection.fetch.register` 取代自建 `/diff-review` 前缀路由 + 手工 envelope）：
  插件注释记录的 `connection.rpc.handle` 跨 fiber 失败尚未在桌面版复测，改错会让插件整体失效。
- **写盘/外部进程纳入 `ctx.sandboxPolicy`**：需要先确认 `resolve()` 的返回形状，否则可能误伤正常撤回。
