# dsh-notify-win

DeepSeek Harness (DSH) 的 Windows 宿主插件：当发生以下情况时，在**右下角弹出
原生 Windows toast 通知**（VSCode Copilot 同款样式），并让**任务栏里的
DeepSeek Harness 图标闪烁**（系统暖色脉冲，`FlashWindowEx`）：

- **任务完成** —— harness 检测到模型 API 返回结束、且没有工具调用继续对话
  轮次（根 agent 进入 `idle`）；
- **需要你回答** —— 有审批/决策请求在等待，或助手向你直接提问
  （`ask_user_question`）。

触发源是 harness 自身的生命周期，**不是模型工具调用**，因此不涉及 DSH 的
模型审批；唯一涉及的权限是操作系统层面的（Windows 是否允许 harness 进程
弹出通知）。

## 环境要求

- Windows 10/11，任意 profile 的 DeepSeek Harness（推荐 `web`）。
- PowerShell 7 或 Windows PowerShell 5.1（两者皆可；5.1 会自动作为兜底探测）。

## 安装

本包是标准的 DSH **bundle 插件**：自带 `cordis.patch.yml`，成为 profile
依赖后即自动注册进组合树。

### 从 npm 安装（发布后推荐）

```powershell
dsh plugin --profile web add dsh-notify-win
```

（`dsh plugin` 会在 profile 目录里执行 `pnpm add`，并把任何声明了
`dsh.bundle` 的依赖自动加入 profile 的 bundle 层栈。）

### 从 git clone 安装（无需 npm）

```powershell
git clone https://github.com/Andyqwe44/dsh-plugin.git

# 让 profile 能解析到该包（在 profile 的 node_modules 里建一个 junction，
# -Target 换成你的 clone 路径）：
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-notify-win" -Target "D:\path\to\dsh-notify-win"

# 在 profile 清单里注册 bundle：
#   "$env:USERPROFILE\.dsh\profiles\web\package.json"
#     "dependencies": { "dsh-notify-win": "^0.1.0" },
#     "dsh": { "profile": { "bundles": [ ..., "dsh-notify-win" ] } }

# 验证组合树里有这一行：
dsh --profile web --dump-config   # 找到：# == dsh-notify-win / - id: dsh-notify-win
```

完成后**重启 harness**（`dsh web`）。插件默认启用；因为存在于 profile 组合
里，重启后依然保持启用。

## 启用 / 禁用（即开关）

加载/禁用开关就是插件行上的标准 `disabled` 字段——编辑
`$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`：

```yaml
# 禁用：
- id: dsh-notify-win
  disabled: true

# 重新启用（删掉该覆盖，或改为 false）：
- id: dsh-notify-win
  disabled: false
```

重启后生效（web profile 的 HMR 在出厂模板里是关闭的）。

## 自定义文案

```yaml
- id: dsh-notify-win
  config:
    doneTitle: 'DeepSeek Harness · 任务完成'
    doneBody: '任务已完成，可以查看结果。'
    questionTitle: 'DeepSeek Harness · 需要你确认'
    questionBody: '有操作需要你批准或拒绝。'
    askTitle: 'DeepSeek Harness · 有问题等你回答'
    askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。'
    dedupMs: 1500   # 两次通知之间的去重窗口（毫秒）
```

## 工作原理

| 环节 | 实现 |
| --- | --- |
| 「完成」触发 | `agent/status` 事件 `status: 'idle'`（仅根 agent；子代理通过 `delegationDepth` 跳过） |
| 「待回答」触发 | `approval/request` 瀑布（触发通知 + 调用 `next()` 放行），以及 `ask_user_question` 的 `tools/execute`（同样触发 + `next()`） |
| 弹窗 | `lib/notify.ps1` → WinRT `Windows.UI.Notifications`（原生 toast），使用系统已注册的 PowerShell 身份（未注册的 AUMID 会被 Win10/11 静默丢弃），失败回退 `NotifyIcon` 气泡 |
| 任务栏闪烁 | `lib/notify.ps1` → `EnumWindows` 找到标题以 `DeepSeek Harness` 开头的顶层窗口，再调 `FlashWindowEx`（`FLASHW_ALL \| FLASHW_TIMERNOFG` = 15，一直闪到窗口获得焦点） |
| 执行方式 | `ctx.subprocess.spawn(powershell -NoProfile -NonInteractive -WindowStyle Hidden -File notify.ps1 ...)`，即发即忘；PowerShell 按官方 `dsh-pwsh-local` 的策略解析（pwsh 7 安装目录 → PATH → Windows PowerShell 5.1） |

本插件不注册任何服务、工具或 settings 命名空间——它只是一个普通消费者行，
放在任何 profile 里都安全，无需 isolate realm。

## 已知限制

- **闪烁颜色**：`FlashWindowEx` 用的是系统自带的暖色脉冲高亮；通过公开
  Windows API 无法自定义成纯橙色。
- **只有窗口在后台时才会闪烁**：Windows 永远不会为「你正在看的窗口」闪烁
  任务栏——这是系统行为，也正是它的意义（把你拉回没在看的窗口）。
- **Toast 身份**：通知以系统已注册的「Windows PowerShell」身份显示（可靠
  显示需要已注册的 AUMID；注册专属品牌 AUMID 留作后续工作）。
- **取消也算完成**：停止正在运行的一轮同样会让 agent 进入 `idle`，因此取消
  任务也会触发「完成」通知（status 事件不携带停止原因）。
- **改动需重启**：在 web profile 上安装/禁用后需重启（出厂模板禁用了
  web HMR）。
- 每个根 agent 一轮触发一次通知；1.5 秒去重窗口（可配置）避免连续事件
  重复弹窗。

## 开发

```powershell
npm run check     # 语法检查
npm test          # 逻辑冒烟测试（mock ctx）

# 单独测试通知脚本（会真的弹出 toast + 闪烁任务栏）：
powershell -NoProfile -File lib/notify.ps1 -Kind done -Title "test" -Body "test"

# 端到端加载测试（用 overlay 启动一个 headless profile 并加载插件）：
dsh --profile headless --patch test/headless-overlay.yml "reply ok"
```

## 项目结构

```
dsh-notify-win/
├── .github/workflows/ci.yml   # CI：node 检查 + 冒烟测试、ps1 解析
├── lib/
│   ├── index.js               # 宿主半：事件监听 → subprocess 拉起 PowerShell
│   └── notify.ps1             # toast + 任务栏闪烁实现
├── test/
│   ├── smoke.mjs              # 插件逻辑冒烟测试（mock ctx）
│   └── headless-overlay.yml   # 端到端启动用的测试 overlay
├── cordis.patch.yml           # DSH bundle 补丁：插入插件行
├── package.json               # dsh.bundle 声明 + npm 元数据
├── CHANGELOG.md
└── LICENSE
```

## License

[MIT](LICENSE)
