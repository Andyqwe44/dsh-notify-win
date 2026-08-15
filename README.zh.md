# dsh-plugin

English | [中文](README.zh.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件工作区。
每个插件独占一个一级目录，作为带 `dsh.bundle` 声明的独立 npm 包，可用官方命令
分别安装：

```powershell
dsh plugin --profile web add <包名>
```

## 插件列表

| 目录 | 包名 | 功能 | 安装 |
| --- | --- | --- | --- |
| [`dsh-notify-win/`](dsh-notify-win/README.zh.md) | `dsh-notify-win` | 任务完成或需要你回答时，弹出 Win11 原生通知并闪烁任务栏 | `dsh plugin --profile web add dsh-notify-win` |

## 新增插件

1. 创建一级目录，例如 `my-plugin/`，包含：
   - `package.json` —— 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
   - `cordis.patch.yml` —— 本 bundle 贡献的 `insert` 行
   - 插件代码、`README.md`（+ `README.zh.md`）、`LICENSE`
2. 在上表加一行；如需 CI 则补相应步骤。
3. 本地安装（`$DSH_HOME/profiles/node_modules` 里建 junction + 注册 bundle），
   用 `dsh --profile web --dump-config` 验证。

## 开发

各插件自包含，在各自目录内运行检查：

```powershell
cd dsh-notify-win
npm run check   # 语法检查
npm test        # 冒烟测试
```

## License

[MIT](LICENSE)
