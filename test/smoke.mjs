// Smoke test for dsh-notify-win plugin logic with a mocked ctx.
import plugin from '../lib/index.js'

const spawns = []
const handlers = {}
const nextCalls = []

const ctx = {
  get(name) {
    if (name === 'subprocess') {
      return {
        async resolveExecutable(cmd) { return `C:\\mock\\${cmd}.exe` },
        spawn(spec) { spawns.push(spec); return { done: Promise.resolve({ code: 0 }) } },
      }
    }
    return undefined
  },
  on(name, fn) { handlers[name] = fn },
}

plugin.apply(ctx, { dedupMs: 0 })

const rootAgent = { session: { header: { delegationDepth: 0 } } }
const childAgent = { session: { header: { delegationDepth: 2 } } }

// 1. root agent idle -> done notification
handlers['agent/status']({ status: 'idle', agent: rootAgent })
// 2. subagent idle -> must be skipped
handlers['agent/status']({ status: 'idle', agent: childAgent })
// 3. running -> nothing
handlers['agent/status']({ status: 'running', agent: rootAgent })
// 4. approval/request -> question + next()
handlers['approval/request']({ agent: rootAgent, reason: '允许运行此命令？' }, () => { nextCalls.push('approval'); return 'ok' })
// 5. ask_user_question execution -> question + next()
handlers['tools/execute']({ name: 'ask_user_question', agent: rootAgent }, () => { nextCalls.push('tool'); return 'ok' })
// 6. other tool execution -> nothing
handlers['tools/execute']({ name: 'pwsh', agent: rootAgent }, () => { nextCalls.push('pwsh'); return 'ok' })
// 7. dedup: immediate second idle -> suppressed
handlers['agent/status']({ status: 'idle', agent: rootAgent })

// runNotify is async (resolveExecutable); let the microtasks settle.
await new Promise((resolve) => setTimeout(resolve, 50))

const kinds = spawns.map((s) => s.argv[s.argv.indexOf('-Kind') + 1])
const titles = spawns.map((s) => s.argv[s.argv.indexOf('-Title') + 1])

console.log('spawn count:', spawns.length, '(expected 4: done, question, question, done-with-dedup-off)')
console.log('kinds:', JSON.stringify(kinds), '(expected ["done","question","question","done"])')
console.log('nextCalls:', JSON.stringify(nextCalls), '(expected ["approval","tool","pwsh"])')
console.log('argv0:', spawns[0]?.argv[0], '| script:', spawns[0]?.argv[spawns[0].argv.indexOf('-File') + 1])
console.log('stdio:', JSON.stringify(spawns[0]?.stdio), '| graceMs:', spawns[0]?.graceMs, '| cwd:', spawns[0]?.cwd)
console.log('done title:', JSON.stringify(titles[0]))
console.log('approval reason title body:', JSON.stringify(titles[1]))

const argv0 = spawns[0]?.argv[0] ?? ''
const ok =
  spawns.length === 4 &&
  kinds[0] === 'done' && kinds[1] === 'question' && kinds[2] === 'question' && kinds[3] === 'done' &&
  JSON.stringify(nextCalls) === '["approval","tool","pwsh"]' &&
  /(pwsh|powershell)\.exe$/i.test(argv0) &&
  spawns[0].argv.includes('-File')
console.log(ok ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED')
process.exit(ok ? 0 : 1)
