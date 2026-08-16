# dsh-notify-win

> DeepSeek Harness（DSH）Windows 通知插件：任务完成或需要你回答时，弹出原生 toast 并闪烁任务栏图标。

[English](README.md) | 中文

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4)
![license](https://img.shields.io/badge/license-MIT-green)
![version](https://img.shields.io/badge/version-0.2.0-blue)

## ✨ 功能

- 🔔 **原生 Windows toast**（右下角，Win10/11 系统样式）
- 💡 **任务栏闪烁**（`FlashWindowEx`），DSH 在后台时提醒你切回
- 🖱️ **点击跳转** — 点击 toast 自动打开 DSH 并切换到对应会话
- ✅ **任务完成**时触发（根 agent 进入 `idle`）
- ❓ **需要你回答**时触发（审批 / `ask_user_question`）
- 🖼️ toast 顶部显示 DeepSeek Harness hero 大图（自动适配浅色/深色主题）
- 🚀 即发即忘：不注册服务、不经过模型审批、不占用 settings 命名空间

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

## 配置

编辑 `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- id: dsh-notify-win
  config:
    doneTitle: 'DeepSeek Harness · 任务完成'
    doneBody: '任务已完成，可以查看结果。'
    questionTitle: 'DeepSeek Harness · 需要你确认'
    questionBody: '有操作需要你批准或拒绝。'
    askTitle: 'DeepSeek Harness · 有问题等你回答'
    askBody: '助手向你提了一个问题，请切换到 DeepSeek Harness 查看。'
    dedupMs: 1500              # 两次通知之间的去重窗口（毫秒）
    showProject: true          # 正文前缀显示项目标识
```

禁用插件：

```yaml
- id: dsh-notify-win
  disabled: true
```

安装/禁用后需重启（web profile 默认关闭 HMR）。

## 工作原理

| 环节 | 实现 |
| --- | --- |
| 「完成」触发 | `agent/status` 事件 `status: 'idle'`（仅根 agent） |
| 「待回答」触发 | `approval/request` 瀑布 + `ask_user_question` 的 `tools/execute` |
| 弹窗 | WinRT `Windows.UI.Notifications`，顶部 hero 大图，失败回退 `NotifyIcon` 气泡 |
| 任务栏闪烁 | `EnumWindows` + `FlashWindowEx`（`FLASHW_ALL \| FLASHW_TIMERNOFG`） |
| 执行方式 | 即发即忘的 `powershell -File notify.ps1` 子进程 |

插件不注册服务、工具或 settings 命名空间——普通消费者行，任何 profile 都安全。

## 已知限制

- `FlashWindowEx` 使用系统自带暖色脉冲，无法自定义颜色。
- Windows 不会闪烁前台窗口——只有 DSH 在后台时任务栏按钮才会闪。
- 取消正在运行的一轮同样会进入 `idle`，所以取消任务也会触发「完成」通知。
- 通知按会话在 `dedupMs`（默认 1500ms）内去重。

## 开发

```powershell
npm run check     # 语法检查
npm test          # 逻辑冒烟测试（mock ctx）

# 单独测试通知脚本（会真的弹出 toast + 闪烁任务栏）：
powershell -NoProfile -File lib/notify.ps1 -Kind done -Title "test" -Body "test"
```

## 项目结构

```
dsh-notify-win/
├── lib/
│   ├── index.js       # 宿主半：事件监听 → 拉起子进程
│   └── notify.ps1     # toast + 任务栏闪烁实现
├── test/
│   ├── smoke.mjs      # 插件逻辑冒烟测试
│   └── headless-overlay.yml
├── cordis.patch.yml   # DSH bundle 补丁
├── package.json       # dsh.bundle 声明
├── README.md
└── README.zh.md
```

## 链接

- 🌐 落地页：https://Andyqwe44.github.io/dsh-notify-win/

## License

[MIT](LICENSE)
