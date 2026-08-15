# dsh-plugin

English | [中文](README.zh.md)

Workspace of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins. Every plugin lives in its own first-level directory as a standalone
npm package with a `dsh.bundle` declaration, so each one is independently
installable with the official command:

```powershell
dsh plugin --profile web add <package-name>
```

## Plugins

| Directory | Package | What it does | Install |
| --- | --- | --- | --- |
| [`dsh-notify-win/`](dsh-notify-win/README.md) | `dsh-notify-win` | Native Windows toast + taskbar flash when a task finishes or the user's answer is needed | `dsh plugin --profile web add dsh-notify-win` |

## Adding a new plugin

1. Create a first-level directory, e.g. `my-plugin/`, with:
   - `package.json` — declare `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
   - `cordis.patch.yml` — the `insert` rows the bundle contributes
   - the plugin code, `README.md` (+ `README.zh.md`), `LICENSE`
2. Add a row to the table above and a CI step if the plugin needs one.
3. Install locally (junction into `$DSH_HOME/profiles/node_modules` + bundle
   registration) and verify with `dsh --profile web --dump-config`.

## Development

Each plugin is self-contained; run its own checks inside its directory:

```powershell
cd dsh-notify-win
npm run check   # syntax check
npm test        # smoke test
```

## License

[MIT](LICENSE)
