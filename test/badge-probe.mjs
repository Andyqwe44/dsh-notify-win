// Manual protocol check for the taskbar badge: start one extra helper, send
// config + attention, then read the log. Not part of npm test; run on demand.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const exe = fileURLToPath(new URL('../lib/dsh-toast-question.exe', import.meta.url))
const log = fileURLToPath(new URL('../artifacts/badge-probe.log', import.meta.url))
const child = spawn(exe, ['--serve', '--log', log], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const lines = []
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => lines.push(...chunk.split('\n').filter(Boolean)))
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const exited = new Promise((resolve) => child.once('exit', resolve))
await sleep(800)
const hold = Number(process.argv[2] ?? 1500)
send({ op: 'config', blinkIntervalMs: 600, blinkMaxMinutes: 30 })
send({ op: 'attention', kind: 'done', effects: { blink: true, flash: false, timing: 'immediate' } })
await sleep(hold)
send({ op: 'ping' })
await sleep(400)
send({ op: 'shutdown' })
const code = await exited
const text = await readFile(log, 'utf8')
const tail = text.split('\n').filter((line) => line.length > 0).slice(-14)
console.log(tail.join('\n'))
console.log(`\nexit=${code} pong=${lines.some((line) => line.includes('"pong"'))}`)
