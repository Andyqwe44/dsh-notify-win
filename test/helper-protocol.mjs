// Protocol + lifecycle test for the resident toast helper.
//
// It exercises the real executable but never shows a toast: the helper is
// asked to ping and then to shut down, and the second spawn exits on stdin EOF.
// That is the contract the host plugin relies on: a helper that follows the
// plugin lifetime instead of the plugin killing it blindly.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const EXE = fileURLToPath(new URL('../lib/dsh-toast-question.exe', import.meta.url))

function start() {
  const child = spawn(EXE, ['--serve'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const lines = []
  const waiters = []
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    lines.push(message)
    for (const waiter of waiters.splice(0)) waiter()
  })
  const next = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = lines.findIndex(predicate)
      if (found >= 0) return lines[found]
      await new Promise((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 200)
      })
    }
    throw new Error('timed out waiting for helper output')
  }
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  return { child, send, next, lines }
}

function waitExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helper did not exit')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

function assert(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) process.exitCode = 1
}

{
  // --check is the runtime probe the plugin uses before spawning.
  const probe = spawn(EXE, ['--check', '1'], { stdio: 'ignore', windowsHide: true })
  const code = await waitExit(probe)
  assert(code === 0, 'runtime probe exits 0')
}

{
  const helper = start()
  const ready = await helper.next((m) => m.ev === 'ready')
  assert(typeof ready.pid === 'number' && ready.pid > 0, 'helper reports ready with its pid')

  helper.send({ op: 'ping' })
  const pong = await helper.next((m) => m.ev === 'pong')
  assert(pong.ev === 'pong', 'ping answers pong')

  helper.send({ op: 'shutdown' })
  const code = await waitExit(helper.child)
  assert(code === 0, 'shutdown exits 0')
}

{
  // EOF is what DSH exit looks like to the helper: no explicit shutdown.
  const helper = start()
  await helper.next((m) => m.ev === 'ready')
  helper.child.stdin.end()
  const code = await waitExit(helper.child)
  assert(code === 0, 'stdin EOF exits 0')
}

console.log(process.exitCode === 1 ? 'HELPER TEST FAILED' : 'HELPER TEST PASSED')
