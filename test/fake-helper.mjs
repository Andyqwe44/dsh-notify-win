// Shared fake for the host tests.
//
// The real helper is a Windows .NET process; the host tests only need the
// newline-delimited JSON seam. This fake answers `--check`, reports ready, and
// records every command the host writes to its stdin.
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fakeDotnetRoot = null

/**
 * `desktopRuntimePresent()` probes the real machine before the host will spawn
 * the helper. Unit tests are platform-independent, so give it a fake .NET 10
 * Desktop layout in DOTNET_ROOT; the fake `--check` below is the liveness probe.
 */
export const ensureFakeDotnet = async () => {
  if (fakeDotnetRoot !== null) return fakeDotnetRoot
  fakeDotnetRoot = await mkdtemp(join(tmpdir(), 'dsh-notify-dotnet-'))
  await mkdir(join(fakeDotnetRoot, 'shared', 'Microsoft.WindowsDesktop.App', '10.0.0'), { recursive: true })
  process.env.DOTNET_ROOT = fakeDotnetRoot
  return fakeDotnetRoot
}

export function createFakeHelper() {
  const stdout = new PassThrough()
  const writes = []
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const handle = {
    stdin: {
      write(line) {
        const message = JSON.parse(line)
        writes.push(message)
        if (message.op === 'shutdown') settle({ code: 0 })
      },
    },
    stdout,
    done,
    terminate() { settle({ code: 1 }) },
  }
  return {
    handle,
    writes,
    emit: (message) => { stdout.write(`${JSON.stringify(message)}\n`) },
  }
}

/**
 * Plugin harness for the host tests: no PowerShell, no real helper exe.
 * The fake helper emits `ready` on the next tick and records every op.
 */
export function createHarness(plugin, config = {}) {
  const routes = new Map()
  const handlers = {}
  const spawns = []
  const disposers = []
  let fake = null

  const ctx = {
    get(name) {
      if (name === 'subprocess') {
        return {
          async resolveExecutable(command) { return command },
          spawn(spec) {
            spawns.push(spec)
            if (spec.argv.includes('--check')) {
              return { done: Promise.resolve({ exitCode: 0, signal: null }) }
            }
            fake = createFakeHelper()
            setTimeout(() => fake.emit({ ev: 'ready', pid: 4242 }), 0)
            return fake.handle
          },
        }
      }
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        }
      }
      return undefined
    },
    on(name, fn) { handlers[name] = fn },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }

  plugin.apply(ctx, { dedupMs: 0, ...config })

  return {
    routes,
    handlers,
    spawns,
    helper: () => fake,
    async start() {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (fake !== null) {
          fake.emit({ ev: 'ready', pid: 4242 })
          await new Promise((resolve) => setTimeout(resolve, 40))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('toast helper was not spawned')
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}
