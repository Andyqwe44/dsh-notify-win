# dsh-notify-win

> DeepSeek Harness（DSH）Windows 通知插件：任务完成或需要你回答时，弹出原生 toast 并闪烁任务栏图标。

[English](README.md) | 中文

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![license](https://img.shields.io/badge/license-MIT-green)
![version](https://img.shields.io/badge/version-0.2.0-blue)

## 📸 截图

### 任务完成

![任务完成 toast](docs/assets/screenshots/done-toast.png)

### 上下文压缩完成

![上下文压缩完成 toast](docs/assets/screenshots/compact-toast.png)

### 单选问题

![单选问题 toast](docs/assets/screenshots/question-single-select.png)

### toast 超时 → 任务栏闪烁

<img src="docs/assets/screenshots/taskbar-flash.png" alt="toast 超时后的任务栏闪烁" style="max-width: 900px; width: 100%;" />

> 截图来自 Windows 11。任务栏闪烁是动态效果，截图展示的是 DSH 任务栏按钮被系统暖色高亮的状态。

## ✨ 功能

- 🔔 **原生 Windows toast**（右下角，Win10/11 系统样式）
- 💡 **任务栏闪烁**（`FlashWindowEx`），DSH 在后台时提醒你切回；回到 DSH 前台后由系统停止
- 🖱️ **点击跳转** — 点击 toast 自动打开 DSH 并切换到对应会话
- ✅ **任务完成**时触发（根 agent 进入 `idle`）
- 🧭 **说清楚为什么停** —— 通知跟随 `turn/end` 的真实原因，不再一律报「完成」：正常完成、输出达到上限（`max-tokens`）、前置检查拦截、LLM 失败（带 provider 无关错误码与重试次数）、被取消。详见 [停止原因](#停止原因)。
- 🗜️ **上下文压缩完成**时触发 —— 压缩**失败**时单独告警（`compaction/end` 带 `error`）
- ❓ **需要你回答**时触发（审批 / `ask_user_question`）
- 📋 **问题 toast（可分页）**：单题显示原生下拉框（最多 5 个选项）+ 自定义答案输入框；两题以上合并为一个分页 toast（`问题 i/n` + 上一题 / 下一题 / 提交 / 取消），翻回上一页时下拉框和自定义文本都会恢复，`已答：…` 行保留其它题的答案。
- 🧷 **常驻 helper，跟随插件生命周期**：插件加载时启动一个 `dsh-toast-question.exe`，之后每次提问复用；在插件里关掉插件或退出 DSH 时回收（DSH 退出会关闭 stdio，helper 读到 EOF 自行退出），不再每次提问都拉起新进程，也不会留下孤儿进程。
- ✅ **只有一条、不撒谎的回执**：点 Send 后问题 toast 直接收起，中间没有任何「已提交 / 已送达 / 已收到并回应」步骤；模型回答后只弹一条 toast，内容就是 **模型返回的第一行**（铺满 toast 一行宽度，超长以 `…` 截断，没有标题行）——这句话只可能来自真实完成的整条链路。模型没有可见文本时不弹回执（不编造）。取消会明确写「没有向 DSH 提交任何答案」；卡片填不进去则提示「请在 DSH 窗口中手动回答」。
- 🖱️ **在 toast 里回答能直接送达 agent**：所选选项（含自定义文本、多个问题）会落到官方提问卡片并提交，卡住的 `ask_user_question` 立即返回
- ⏰ **超时闪烁**：任意 toast 被忽略并超时关闭后，任务栏闪烁提醒你；回到 DSH 前台或在窗口里作答后立即停止
- 🖼️ 不使用 hero 大图：所有通知都只有应用角标，保持紧凑
- 🪪 通知归属显示 **DeepSeek Harness** 与自带图标（自注册 AppUserModelID）；只有在品牌 notifier 无法创建时才退回系统 PowerShell 身份
- 🚀 不注册 DSH 服务、不经过模型审批、不占用 settings 命名空间——只有一个常驻 helper 子进程

## 🚀 一行安装

```powershell
dsh plugin --profile web add dsh-notify-win
```

> 需要 `pnpm` 在 PATH 中（没有就先 `corepack enable`）。详见 [安装](#安装)。

## 安装

1. **前置：pnpm**

   ```powershell
   corepack enable
   ```

   没有管理员权限时，在 PATH 目录放一个用户级 shim：

   ```powershell
   Set-Content -Path "$env:LOCALAPPDATA\Microsoft\WindowsApps\pnpm.cmd" -Value "@echo off`r`ncorepack pnpm %*`r`n"
   corepack pnpm --version
   ```

2. **安装插件**

   ```powershell
   # 从 npm 安装（推荐）
   dsh plugin --profile web add dsh-notify-win

   # 或从 GitHub 直接安装：
   dsh plugin --profile web add github:Andyqwe44/dsh-notify-win

   # 若 github: 失败（网络受限），改用 SSH：
   dsh plugin --profile web add git+ssh://git@github.com/Andyqwe44/dsh-notify-win.git
   ```

3. **验证**

   ```powershell
   dsh --profile web --dump-config   # 找到：# == dsh-notify-win / - id: dsh-notify-win
   ```

4. **重启并测试**

   ```powershell
   dsh web
   ```

   随便完成一个任务即可。第一条通知会自动完成品牌身份注册（开始菜单快捷方式 + AppUserModelID，一次性）。若 toast 标题仍显示 `DeepSeekHarness` 且没有图标，重启一次资源管理器：

   ```powershell
   Stop-Process -Name explorer -Force; Start-Process explorer
   ```

## 环境要求

- Windows 10/11（x64）
- DeepSeek Harness，任意 profile（推荐 `web`）
- .NET 10 Desktop Runtime（x64）— **必需**：常驻 .NET helper 是唯一的通知实现。完成/压缩/告警/取消、交互审批以及交互问题全部走它。用 `winget install Microsoft.DotNet.DesktopRuntime.10` 或从 <https://dotnet.microsoft.com/download/dotnet/10.0> 安装。不再使用 PowerShell 脚本。

## 配置

编辑 `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- id: dsh-notify-win
  config:
    doneTitle: 'DeepSeek Harness · 任务完成'
    doneBody: '任务已完成，可以查看结果。'
    compactTitle: 'DeepSeek Harness · 上下文已压缩'
    compactBody: '上下文压缩完成，可以继续。'
    questionTitle: 'DeepSeek Harness · 需要你确认'
    questionBody: '有操作需要你批准或拒绝。'
    askTitle: 'DeepSeek Harness · 有问题等你回答'
    askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。'
    dedupMs: 1500              # 两次通知之间的去重窗口（毫秒）
    questionToastDuration: 'short'  # 'short'（约5秒）或 'long'（约25秒），用于 ask_user_question 交互 toast
    doneToastDuration: 'short'      # 'short' 或 'long'，用于完成/压缩/告警/取消 toast
    approvalToastDuration: 'long'   # 'short' 或 'long'，用于交互式审批请求
    helperLog: ''              # 可选：helper 协议/toast 诊断日志路径
    answerPendingTimeoutMs: 30000  # 暂存的答案最多等浏览器端多久，超时才提示
    answerSpeechTimeoutMs: 90000   # 送达后等待模型第一行的上限
    showProject: true          # 正文前缀显示项目标识

    # 停止原因通知
    notifyOnCancel: true       # 用户取消运行时弹一条轻量「已取消」
    notifyOnError: true        # 输出上限 / 被拦截 / LLM 失败 / 压缩失败 时告警
    includeErrorCode: true     # 错误正文追加机器可读错误码
    cancelledTitle: 'DeepSeek Harness · 已取消'
    cancelledBody: '任务已取消。'
    hookCancelledBody: '任务被 hook 拦截：{message}'
    maxTokensTitle: 'DeepSeek Harness · 输出达到上限'
    maxTokensBody: '模型输出达到上限，本轮已截断。发送「继续」即可接着写。'
    blockedTitle: 'DeepSeek Harness · 回合被拦截'
    blockedBody: '本轮在开始前被前置检查拒绝。'
    errorTitle: 'DeepSeek Harness · 任务中断'
    errorBody: '任务异常停止：{hint}'    # {hint} = 内置错误码提示或 provider 原文
    retrySuffix: '（已重试 {retry}/{retryMax} 次）'
    compactionFailedTitle: 'DeepSeek Harness · 上下文压缩失败'
    compactionFailedBody: '上下文压缩失败：{message}'
```

模板支持 `{message}`、`{code}`、`{hint}`、`{reason}`、`{retry}`、`{retryMax}`。

禁用插件：

```yaml
- id: dsh-notify-win
  disabled: true
```

安装/禁用后需重启（web profile 默认关闭 HMR）。

## 停止原因

`agent/status` 只说 `idle`，不说是为什么。插件因此缓存 `turn/end` 的原因（该事件总在 idle 之前紧邻追加），再据此生成通知：

| `turn/end` 原因 | 通知 | 说明 |
| --- | --- | --- |
| `completed` | done | 正常完成 |
| `max-tokens` | alert | 输出 token 达到上限，本轮被截断 |
| `blocked` | alert | 前置 hook/插件拒绝了这一轮 |
| `error` | alert | LLM 失败，正文带错误码提示与重试次数 |
| `aborted`（`user` / `parent` / `legacy`） | notice | 轻量「已取消」 |
| `aborted`（`hook`） | notice | 正文给出 hook 的原因 |
| `aborted`（`disposed`） | **静默** | 销毁前会取消 driver，不该弹通知 |
| `interrupted`、`forked` | **静默** | 持久化历史标记（resume / fork seed），永远不会实时出现 |
| 未知（未来新增） | alert | 渲染为「任务已停止，结束方式：{reason}」 |

上下文压缩失败（`compaction/end` 带 `error`）单独告警；压缩成功仍弹「上下文已压缩」。

`error` 通知的细节来自 provider 无关的 `LlmFailure.code`（`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE`、`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`、`AUTH`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`ACCOUNT_TOKEN_INVALID`、`STREAM_CLOSED`、`NO_ADAPTER`、`UNKNOWN_MODEL`、`INVALID_CONFIG`、`UNSUPPORTED_OPTION`、`ABORTED`、`UNKNOWN` 等）。未列出的 code 回退到 provider 原文。重试次数取自持久的 `llm/retry` 事件——框架没有「重试耗尽」这个独立原因，所以由插件根据最后一条重试记录显示「已重试 N/M 次」。

## 工作原理

| 环节 | 实现 |
| --- | --- |
| 「完成/告警/取消」触发 | `session/event` → `turn/end` 原因缓存 + `agent/status` 的 `idle`（仅根 agent） |
| 「压缩完成 / 压缩失败」触发 | `session/event` → `compaction/end` |
| 「待回答」触发 | `approval/request` 瀑布（toast + DSH 面板）+ `ask_user_question` 的 `tools/execute` |
| 完成/压缩/告警/取消 toast | 常驻 .NET helper 的 `notify` op；WinRT `Windows.UI.Notifications`，失败回退 `NotifyIcon` 气泡。不再为每条通知启动进程 |
| 交互审批 toast | DSH 自己的审批面板照常显示；toast 只是它的遥控器，复用同一套 `question` op：单张固定选项卡片（`允许一次` / `拒绝`），没有自定义输入。答案暂存给浏览器端，由浏览器端切换到所属会话并点击面板，面板仍是最终权威。点「取消」把决定留给面板；回合取消/中止时撤掉 toast |
| 交互问题 toast | 常驻 .NET helper 的 `question` op，通过子进程 stdin/stdout 的 JSON 行通信。单题一张卡；多题一张分页卡（`问题 i/n`、上一题/下一题/提交），每页草稿通过 toast 的 `defaultInput` 属性恢复 |
| 回答回执 | helper 上报选择并收起问题 toast → 宿主暂存给浏览器端并核对 `ask_user_question` 的 tool result → 只弹一条带模型第一行的 `spoken`（铺满一行、超出以 … 截断，无标题行）；没有 pending / delivered toast |
| 身份 / 协议 / 点击聚焦 | helper 启动时注册 AUMID、Start Menu 快捷方式和 `dsh-notify://`；点击 toast 由 helper 在进程内聚焦 DSH（冷启动走 `--focus`） |
| helper 生命周期 | 插件 `apply` 启动 → `ctx.effect` 销毁时发 `shutdown`；DSH 退出关闭 stdin（EOF），helper 自行退出；宿主崩溃也不会留下孤儿 |
| 任务栏闪烁 | `EnumWindows` + `FlashWindowEx`（`FLASHW_TRAY \| FLASHW_TIMERNOFG` = `2 \| 12` = 14；系统在 DSH 回到前台时停止，无周期重闪） |
| 执行方式 | 所有通知、提问和 toast 点击都走常驻 .NET helper；没有 PowerShell 路径 |

插件不注册服务、工具或 settings 命名空间——普通消费者行，任何 profile 都安全。

### helper 生命周期

| 时机 | 行为 |
| --- | --- |
| 插件加载（DSH 启动 / 热重载） | 宿主先跑一次 `--check` 探测，再启动 `dsh-toast-question.exe --serve`，5 秒内等它的 `ready` 行；helper 启动时注册 toast 身份和协议 |
| 非交互通知 | 往 helper 的 stdin 写一行 JSON `notify`——不新建进程；helper 显示 toast 并监听 `Dismissed` / `Activated` |
| 有提问 | 往 helper 的 stdin 写一行 JSON `question`——不再新建进程 |
| 用户回答 | helper 上报 `answer` 并收起问题 toast；宿主暂存给浏览器端 |
| tool result 返回 | 宿主比对 toast 的答案与 agent 实际收到的答案（不一致会提示），然后等模型第一行，只显示这一条 `spoken`（按 toast 一行宽度截断） |
| 问题在 DSH 卡片内被回答（未走 toast） | 宿主发 `resolved`；helper 停止闪烁并移除问题 toast |
| 插件被关闭 / 从 profile 移除 | `ctx.effect` 清理时发 `shutdown`，helper 1.5 秒内退出（否则强制终止） |
| DSH 退出或崩溃 | helper 的 stdin 收到 EOF 自行退出；子进程范围也会被 DSH 回收 |

## 已知限制

- 原生 toast 文本很紧凑，大约只能显示 4 行，长内容会被截断。
- 原生下拉框弹出列表时，鼠标移到弹层上可能导致 toast 收起；如果随后 toast 超时关闭，任务栏闪烁仍会提醒你，回到 DSH 前台后即停。
- .NET 10 Desktop Runtime 是硬性要求。没有它 helper 无法启动，所有通知都不会出现；宿主会写明确的错误日志。没有 PowerShell 兜底。
- helper 是单个常驻进程。它崩溃后，下一条通知会让宿主重新拉起；在此之前通知会被丢弃并记录日志。
- `FlashWindowEx` 使用系统自带暖色脉冲，无法自定义颜色。
- Windows 不会闪烁前台窗口——只有 DSH 在后台时任务栏按钮才会闪；已经开始的闪烁在回到前台时由系统停止。
- 取消的一轮会如实报「已取消」而不是「任务完成」；可用 `notifyOnCancel: false` 静音，或用 `notifyOnError: false` 静音异常停止告警。
- 通知按会话在 `dedupMs`（默认 1500ms）内去重；同一轮重复的 `idle` 不会重复通知。
- 多问题 toast 通过重新显示原生 toast 来翻页，Windows 会把旧 toast 收起、新 toast 滑入，因此每次翻页都有一小段视觉间隔；`已答` 行用于跨页保留上下文。多问题卡片固定使用 long 时长（约 25 秒）。
- 同一页里自定义答案优先于下拉选择（与原来的单题 toast 一致）；只想用下拉选择时，把文本框清空即可。
- 回执无法被界面伪造：「已回应」来自模型自己输出的第一行（按 toast 一行宽度截断，超出补 …），并且是唯一的一条回执。如果模型没有输出可见文本（例如立刻又去调用工具），不会弹回执 toast。
- DSH 窗口关闭时浏览器端无法填官方卡片；超过 `answerPendingTimeoutMs` 会如实提示「未收到 DSH 确认」，你仍可在 DSH 里回答。
- Windows 不允许非打包桌面应用删除自己 Action Center 里的通知。问题已被处理后，旧 toast 可能还会留在通知中心直到过期，点击不会有动作。

## 开发

```powershell
npm run build     # 发布 helper 到 artifacts/，并把最终 exe 复制到 lib/
npm run check     # 语法检查
npm test          # 闪烁策略 + 冒烟 + 回执链路 + helper 协议/生命周期四组测试
```

`npm run build` 需要 **.NET 10 SDK**（运行已发布的 exe 只需 Desktop Runtime）。产物先写到 `artifacts/publish/`，只把最终的 `dsh-toast-question.exe` 复制到 `lib/`——那才是 npm 打包和宿主运行时查找的目录。helper 运行时 exe 会被占用，重新构建前先退出 DSH（或结束 `dsh-toast-question.exe`）。如果 `dotnet` 不在 PATH 中，把 `DOTNET` 设为 SDK 的 `dotnet.exe` 完整路径。

`npm test` 依次跑四组：`test/flash-policy.mjs`（闪烁策略 + 旧脚本已删除的守卫）、`test/smoke.mjs`（假 helper 的通知逻辑）、`test/proof.mjs`（用真实协议的假 helper 验证「回答 → tool result → 第一行」）、`test/helper-protocol.mjs`（真实 exe 的 `--check` / `ready` / `ping` / `shutdown` / stdin EOF 退出）。

## 项目结构

```
dsh-notify-win/
├── Directory.Build.props        # 所有生成物统一进 artifacts/
├── artifacts/                   # 构建产物（gitignored）
│   ├── bin/                     # 编译出的程序集
│   └── publish/                 # 发布成单文件 exe 后、复制到 lib/ 之前
├── scripts/
│   └── build-helper.mjs         # dotnet publish + 把 exe 复制到 lib/
├── src/DshToastQuestion/        # 只放 C# 源码（不再有 bin/obj）
│   ├── DshToastQuestion.csproj
│   ├── Program.cs               # 入口、CLI 模式、stdin 分发
│   ├── State.cs                 # 共享状态、常量、JSON 选项
│   ├── GlobalUsings.cs          # 项目级 using
│   ├── Protocol/
│   │   ├── WireModels.cs        # JSON 消息与问题模型
│   │   └── HelperOutput.cs      # stdout 协议 + XML 转义
│   ├── Notifications/
│   │   └── Notifications.cs     # notify op、toast、气泡、跟踪清理
│   ├── Questions/
│   │   ├── QuestionFlow.cs      # flow 状态、开始/结束
│   │   ├── QuestionRendering.cs # toast XML、分页、草稿
│   │   ├── QuestionInteraction.cs # 激活动作、提交、答案
│   │   └── QuestionStatus.cs    # 宿主状态 → 回执 toast
│   ├── Platform/
│   │   ├── ToastIdentity.cs     # AUMID、Start Menu 快捷方式、协议
│   │   ├── DshWindow.cs         # 查找/聚焦/启动 DSH
│   │   └── TaskbarFlash.cs      # FLASHW_TIMERNOFG / FLASHW_STOP
│   ├── Interop/
│   │   └── NativeMethods.cs     # P/Invoke、COM 接口、结构体
│   └── Logging/
│       └── HelperLog.cs         # 可选 --log 文件
├── lib/                         # npm 包目录：JS、素材、构建后复制进来的 exe
│   ├── index.js                 # 宿主半：事件、helper 生命周期、回执
│   ├── client.js                # 浏览器侧：点击跳转 + 官方卡片驱动
│   ├── dsh-toast-question.exe   # 由 npm run build 复制（gitignored）
│   └── dsh-*.png / dsh-*.ico    # 品牌素材
├── test/                        # 假 helper + 四组测试
├── docs/                        # 落地页与截图
├── cordis.patch.yml             # DSH bundle 补丁
├── package.json                 # dsh.bundle 声明 + 构建脚本
├── README.md
└── README.zh.md
```

## 链接

- 🌐 落地页：https://Andyqwe44.github.io/dsh-notify-win/

## Roadmap

- **V1（已实现）**：完成 + 压缩 + 问题 toast；单选下拉框 + 自定义答案；取消 / Send；超时 → 任务栏闪烁。
- **V1.1（已实现）**：分页多问题 toast（每页草稿独立保存，含下拉框和自定义文本）；多选问题 toast（编号输入）；多问题卡片驱动；由 tool result 与模型第一行支撑的两段式真实回执。
- **V1.2（已实现）**：一个常驻 .NET helper 统一负责所有通知、toast 身份、点击聚焦和任务栏闪烁；没有 PowerShell/`.ps1` 路径；所有 toast 都只在超时后闪烁。
- **V2（计划中）**：完全自包含打包（无需安装 .NET 运行时）和/或后台激活，让 toast 按钮无需前台激活即可直接提交。

## License

[MIT](LICENSE)
