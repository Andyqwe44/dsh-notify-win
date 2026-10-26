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
- 💡 **任务栏闪烁**（`FlashWindowEx`），DSH 在后台时提醒你切回
- 🖱️ **点击跳转** — 点击 toast 自动打开 DSH 并切换到对应会话
- ✅ **任务完成**时触发（根 agent 进入 `idle`）
- 🧭 **说清楚为什么停** —— 通知跟随 `turn/end` 的真实原因，不再一律报「完成」：正常完成、输出达到上限（`max-tokens`）、前置检查拦截、LLM 失败（带 provider 无关错误码与重试次数）、被取消。详见 [停止原因](#停止原因)。
- 🗜️ **上下文压缩完成**时触发 —— 压缩**失败**时单独告警（`compaction/end` 带 `error`）
- ❓ **需要你回答**时触发（审批 / `ask_user_question`）
- 📋 **问题 toast（可分页）**：单题显示原生下拉框（最多 5 个选项）+ 自定义答案输入框；两题以上合并为一个分页 toast（`问题 i/n` + 上一题 / 下一题 / 提交 / 取消），翻回上一页时下拉框和自定义文本都会恢复，`已答：…` 行保留其它题的答案。
- 🧷 **常驻 helper，跟随插件生命周期**：插件加载时启动一个 `dsh-toast-question.exe`，之后每次提问复用；在插件里关掉插件或退出 DSH 时回收（DSH 退出会关闭 stdio，helper 读到 EOF 自行退出），不再每次提问都拉起新进程，也不会留下孤儿进程。
- ✅ **只有一条、不撒谎的回执**：点 Send 后问题 toast 直接收起，中间没有任何「已提交 / 已送达 / 已收到并回应」步骤；模型回答后只弹一条 toast，内容就是 **模型返回的第一行**（铺满 toast 一行宽度，超长以 `…` 截断，没有标题行）——这句话只可能来自真实完成的整条链路。模型没有可见文本时不弹回执（不编造）。取消会明确写「没有向 DSH 提交任何答案」；卡片填不进去则提示「请在 DSH 窗口中手动回答」。
- 🖱️ **在 toast 里回答能直接送达 agent**：所选选项（含自定义文本、多个问题）会落到官方提问卡片并提交，卡住的 `ask_user_question` 立即返回
- ⏰ **超时闪烁兜底**：交互 toast 被忽略并超时关闭后，任务栏闪烁提醒你还有待处理的问题
- 🖼️ 不使用 hero 大图：所有通知都只有应用角标，保持紧凑
- 🪪 通知归属显示 **DeepSeek Harness** 与自带图标（自注册 AppUserModelID），不再是「Windows PowerShell」
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

- Windows 10/11
- DeepSeek Harness，任意 profile（推荐 `web`）
- PowerShell 7 或 Windows PowerShell 5.1（5.1 会自动作为兜底）
- .NET 10 Desktop Runtime（x64）— 仅**交互式问题 toast**（`ask_user_question`）需要；任务完成/压缩完成 toast 走 PowerShell，不需要 .NET

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
    doneToastDuration: 'short'      # 'short'（约5秒）或 'long'（约25秒），用于完成/压缩/审批 toast
    helperEnabled: true        # false = 不启用常驻 .NET helper（改到 DSH 窗口回答）
    helperLog: ''              # 可选：helper 协议/toast 诊断日志路径
    answerPendingTimeoutMs: 30000  # 暂存的答案最多等浏览器端多久，超时才提示
    answerSpeechTimeoutMs: 90000   # 送达后等待模型第一行的上限
    helperUnavailableHint: '（toast 内回答暂不可用，请到 DSH 窗口作答）'  # helper 不可用时追加
    noDotNetHint: '（如需从 toast 直接回答，请安装 .NET 10 Desktop Runtime）'  # .NET 缺失时追加到 toast 正文
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
| 「待回答」触发 | `approval/request` 瀑布 + `ask_user_question` 的 `tools/execute` |
| 完成/压缩/告警/取消 toast | WinRT `Windows.UI.Notifications`，经 `notify.ps1`（入口）+ `notify/_common.ps1`（OS 管道）+ `notify/_kinds.ps1`（按 kind 渲染），失败回退 `NotifyIcon` 气泡 |
| 交互问题 toast | 常驻 .NET helper `dsh-toast-question.exe --serve`，通过子进程 stdin/stdout 的 JSON 行通信。单题一张卡；多题一张分页卡（`问题 i/n`、上一题/下一题/提交），每页草稿通过 toast 的 `defaultInput` 属性恢复 |
| 回答回执 | helper 上报选择并收起问题 toast → 宿主暂存给浏览器端并核对 `ask_user_question` 的 tool result → 只弹一条带模型第一行的 `spoken`（铺满一行、超出以 … 截断，无标题行）；没有 pending / delivered toast |
| helper 生命周期 | 插件 `apply` 启动 → `ctx.effect` 销毁时发 `shutdown`；DSH 退出关闭 stdin（EOF），helper 自行退出；宿主崩溃也不会留下孤儿 |
| 任务栏闪烁 | `EnumWindows` + `FlashWindowEx`（`FLASHW_TRAY \| FLASHW_TIMERNOFG` = 14） |
| 执行方式 | 完成/压缩/告警/取消走即发即忘 PowerShell；提问走常驻 helper |

插件不注册服务、工具或 settings 命名空间——普通消费者行，任何 profile 都安全。

### helper 生命周期

| 时机 | 行为 |
| --- | --- |
| 插件加载（DSH 启动 / 热重载） | 宿主先跑一次 `--check` 探测，再启动 `dsh-toast-question.exe --serve`，5 秒内等它的 `ready` 行 |
| 有提问 | 往 helper 的 stdin 写一行 JSON `question`——不再新建进程 |
| 用户回答 | helper 上报 `answer` 并收起问题 toast；宿主暂存给浏览器端 |
| tool result 返回 | 宿主比对 toast 的答案与 agent 实际收到的答案（不一致会提示），然后等模型第一行，只显示这一条 `spoken`（按 toast 一行宽度截断） |
| 插件被关闭 / 从 profile 移除 | `ctx.effect` 清理时发 `shutdown`，helper 1.5 秒内退出（否则强制终止） |
| DSH 退出或崩溃 | helper 的 stdin 收到 EOF 自行退出；子进程范围也会被 DSH 回收 |

## 已知限制

- 原生 toast 文本很紧凑，大约只能显示 4 行，长内容会被截断。
- 原生下拉框弹出列表时，鼠标移到弹层上可能导致 toast 收起；如果随后 toast 超时关闭，任务栏闪烁仍会提醒你。
- `FlashWindowEx` 使用系统自带暖色脉冲，无法自定义颜色。
- Windows 不会闪烁前台窗口——只有 DSH 在后台时任务栏按钮才会闪。
- 取消的一轮会如实报「已取消」而不是「任务完成」；可用 `notifyOnCancel: false` 静音，或用 `notifyOnError: false` 静音异常停止告警。
- 通知按会话在 `dedupMs`（默认 1500ms）内去重；同一轮重复的 `idle` 不会重复通知。
- 交互式问题 toast 需要机器上安装 .NET 10 Desktop Runtime。如果未安装，插件会回退为普通 PowerShell toast，仍然会提醒有问题待处理，并在正文末尾追加安装 .NET 的提示。
- 多问题 toast 通过重新显示原生 toast 来翻页，Windows 会把旧 toast 收起、新 toast 滑入，因此每次翻页都有一小段视觉间隔；`已答` 行用于跨页保留上下文。多问题卡片固定使用 long 时长（约 25 秒）。
- 同一页里自定义答案优先于下拉选择（与原来的单题 toast 一致）；只想用下拉选择时，把文本框清空即可。
- 回执无法被界面伪造：「已回应」来自模型自己输出的第一行（按 toast 一行宽度截断，超出补 …），并且是唯一的一条回执。如果模型没有输出可见文本（例如立刻又去调用工具），不会弹回执 toast。
- DSH 窗口关闭时浏览器端无法填官方卡片；超过 `answerPendingTimeoutMs` 会如实提示「未收到 DSH 确认」，你仍可在 DSH 里回答。
- Windows 不允许非打包桌面应用删除自己 Action Center 里的通知。问题已被处理后，旧 toast 可能还会留在通知中心直到过期，点击不会有动作。

## 开发

```powershell
npm run check     # 语法检查
npm test          # 冒烟 + 回执链路 + helper 协议/生命周期三组测试

# 单独测试通知脚本（会真的弹出 toast + 闪烁任务栏）。
# 必须用 Windows PowerShell 5.1：PowerShell 7 没有 WinRT toast 投影，会静默退化成气泡。
powershell -NoProfile -File lib/notify.ps1 -Kind done -Title "test" -Body "test"

# 复现一次异常停止告警：
powershell -NoProfile -File lib/notify.ps1 -Kind alert -Title "test" -Body "重试耗尽" `
  -Reason error -Code RATE_LIMIT -Retry 5 -RetryMax 5 -Duration long

# 重新构建常驻问题 helper。运行时 exe 被占用，先退出 DSH（或结束 dsh-toast-question.exe）：
dotnet publish src/DshToastQuestion/DshToastQuestion.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o lib
```

`npm test` 依次跑三组：`test/smoke.mjs`（mock ctx 的通知逻辑）、`test/proof.mjs`（用真实协议的假 helper 验证「回答 → tool result → 第一行」）、`test/helper-protocol.mjs`（真实 exe 的 `--check` / `ready` / `ping` / `shutdown` / stdin EOF 退出）。

## 项目结构

```
dsh-notify-win/
├── lib/
│   ├── index.js               # 宿主半：事件、停止原因、helper 生命周期、回执链路
│   ├── client.js              # 浏览器侧：点击跳转 + 官方卡片驱动
│   ├── notify.ps1             # 入口：校验 kind，执行通知流水线
│   ├── notify/
│   │   ├── _common.ps1        # 身份/协议/主题/toast/气泡/任务栏闪烁
│   │   └── _kinds.ps1         # 按 kind 渲染（done/compact/alert/notice/question）
│   ├── focus-dsh.ps1          # 聚焦/启动 DSH Edge PWA
│   ├── focus-dsh.vbs          # focus-dsh.ps1 的隐藏启动器
│   ├── dsh-toast-question.exe # 常驻问题 helper（C#，--serve）
│   └── dsh-*.png / dsh-*.ico  # 品牌素材
├── src/DshToastQuestion/
│   ├── Program.cs             # C# helper 源码（stdio JSON 协议）
│   └── DshToastQuestion.csproj
├── test/
│   ├── smoke.mjs              # 通知逻辑冒烟测试
│   ├── proof.mjs              # 回答 → tool result → 第一行回执
│   ├── helper-protocol.mjs    # 真实 exe 的协议/生命周期测试
│   └── headless-overlay.yml
├── docs/
│   └── assets/screenshots/    # README 截图
├── cordis.patch.yml           # DSH bundle 补丁
├── package.json               # dsh.bundle 声明
├── README.md
└── README.zh.md
```

## 链接

- 🌐 落地页：https://Andyqwe44.github.io/dsh-notify-win/

## Roadmap

- **V1（已实现）**：完成 + 压缩 + 问题 toast；单选下拉框 + 自定义答案；取消 / Send；超时 → 任务栏闪烁兜底。
- **V1.1（已实现）**：分页多问题 toast（每页草稿独立保存，含下拉框和自定义文本）；多选问题 toast（编号输入）；多问题卡片驱动；由 tool result 与模型第一行支撑的两段式真实回执。
- **V2（计划中）**：完全自包含打包（无需安装 .NET 运行时）和/或后台激活，让 toast 按钮无需前台激活即可直接提交。

## License

[MIT](LICENSE)
