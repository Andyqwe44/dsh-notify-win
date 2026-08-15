// Smoke test for dsh-notify-win plugin logic with a mocked ctx.
// Covers the multi-project guarantee: different sessions ALWAYS each notify
// (per-session dedup), same-session rapid idle is suppressed, subagents are
// skipped, waterfall listeners call next(), and project labels resolve.
import plugin from '../lib/index.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeCtx(spawns, handlers) {
  return {
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
}

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 30))

// --- Case A: per-session dedup (default 1500ms). ---
// Two DIFFERENT projects finish -> both must notify. Same project finishing
// twice within dedupMs -> only one.
{
  const spawns = []
  const handlers = {}
  const nextCalls = []
  plugin.apply(makeCtx(spawns, handlers), {})   // default dedupMs 1500

  const projA = { id: 'sess-A', header: { delegationDepth: 0 } }
  const projB = { id: 'sess-B', header: { delegationDepth: 0 } }
  const agentA = { session: { id: 'sess-A', header: projA } }
  const agentB = { session: { id: 'sess-B', header: projB } }

  // A finishes, then B finishes immediately -> both should notify.
  handlers['agent/status']({ status: 'idle', agent: agentA })
  handlers['agent/status']({ status: 'idle', agent: agentB })
  // A spurious second idle for A within dedup window -> suppressed.
  handlers['agent/status']({ status: 'idle', agent: agentA })

  await YIELD()
  const kindsA = spawns.map((s) => s.argv[s.argv.indexOf('-Kind') + 1])
  const aOk = kindsA.length === 2 && kindsA[0] === 'done' && kindsA[1] === 'done'
  console.log(`Case A multi-project: ${spawns.length} toast(s), kinds=${JSON.stringify(kindsA)} -> ${aOk ? 'PASS' : 'FAIL'}`)
  if (!aOk) process.exit(1)
}

// --- Case B: subagent skipped, waterfall next() always called, tool filter,
//             same-session question burst collapses (anti-spam). ---
{
  const spawns = []
  const nextCalls = []
  const h = {}
  plugin.apply(makeCtx(spawns, h), {})
  const root = { session: { id: 'root', header: { delegationDepth: 0 } } }
  const child = { session: { id: 'child', header: { delegationDepth: 2 } } }

  // subagent idle -> skip, no fire
  h['agent/status']({ status: 'idle', agent: child })
  // running -> nothing
  h['agent/status']({ status: 'running', agent: root })
  // approval root + next()
  h['approval/request']({ agent: root, reason: '允许?' }, () => { nextCalls.push('approval'); return 'ok' })
  // ask_user_question SAME session within dedup window -> fire suppressed (one toast for the session) but next() still called
  h['tools/execute']({ name: 'ask_user_question', agent: root }, () => { nextCalls.push('tool'); return 'ok' })
  // other tool -> next but no fire
  h['tools/execute']({ name: 'pwsh', agent: root }, () => { nextCalls.push('pwsh'); return 'ok' })

  await YIELD()
  const kinds = spawns.map((s) => s.argv[s.argv.indexOf('-Kind') + 1])
  const bOk =
    kinds.length === 1 && kinds[0] === 'question' &&
    nextCalls.join(',') === 'approval,tool,pwsh'
  console.log(`Case B skip/waterfall/same-session-collapse: kinds=${JSON.stringify(kinds)}, next=${nextCalls.join(',')} -> ${bOk ? 'PASS' : 'FAIL'}`)
  if (!bOk) process.exit(1)
}

// --- Case C: per-session with dedupMs=0 (diagnostic mode) fires on every
//             distinct trigger even for the same session. ---
{
  const spawns = []
  const h = {}
  plugin.apply(makeCtx(spawns, h), { dedupMs: 0 })
  const root = { session: { id: 'root', header: { delegationDepth: 0 } } }
  h['agent/status']({ status: 'idle', agent: root })
  h['agent/status']({ status: 'idle', agent: root })
  await YIELD()
  const kinds = spawns.map((s) => s.argv[s.argv.indexOf('-Kind') + 1])
  const cOk = kinds.length === 2
  console.log(`Case C dedupMs=0 same-session: ${spawns.length} events -> ${cOk ? 'PASS' : 'FAIL'}`)
  if (!cOk) process.exit(1)
}

// --- Case D: different-session "done" + "question" close together each notify. ---
{
  const spawns = []
  const h = {}
  plugin.apply(makeCtx(spawns, h), {})
  const a = { session: { id: 'A', header: { delegationDepth: 0 } } }
  const b = { session: { id: 'B', header: { delegationDepth: 0 } } }
  h['agent/status']({ status: 'idle', agent: a })
  h['approval/request']({ agent: b, reason: '允许?' }, () => 'ok')
  await YIELD()
  const kinds = spawns.map((s) => s.argv[s.argv.indexOf('-Kind') + 1]).sort()
  const dOk = kinds.length === 2 && kinds[0] === 'done' && kinds[1] === 'question'
  console.log(`Case D cross-session burst: ${spawns.length} events, kinds=${JSON.stringify(kinds)} -> ${dOk ? 'PASS' : 'FAIL'}`)
  if (!dOk) process.exit(1)
}

// --- Case E/F/G: project label resolution. ---
{
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-notify-test-'))
  const repoDir = join(tmp, 'fixture-repo')
  await mkdir(join(repoDir, '.git'), { recursive: true })
  await writeFile(join(repoDir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:Andyqwe44/dsh-notify-win.git\n', 'utf8')
  const plainDir = join(tmp, 'no-git-folder')
  await mkdir(plainDir, { recursive: true })

  // E: git remote origin name is prefixed.
  {
    const spawns = []
    const h = {}
    plugin.apply(makeCtx(spawns, h), {})
    const session = { id: 'E', header: { delegationDepth: 0, cwd: repoDir } }
    h['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const body = spawns[0]?.argv[spawns[0].argv.indexOf('-Body') + 1]
    const eOk = body === 'dsh-notify-win：任务已完成，可以查看结果。'
    console.log(`Case E git repo label: body="${body}" -> ${eOk ? 'PASS' : 'FAIL'}`)
    if (!eOk) process.exit(1)
  }

  // F: no git -> cwd folder name.
  {
    const spawns = []
    const h = {}
    plugin.apply(makeCtx(spawns, h), {})
    const session = { id: 'F', header: { delegationDepth: 0, cwd: plainDir } }
    h['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const body = spawns[0]?.argv[spawns[0].argv.indexOf('-Body') + 1]
    const fOk = body === 'no-git-folder：任务已完成，可以查看结果。'
    console.log(`Case F folder label: body="${body}" -> ${fOk ? 'PASS' : 'FAIL'}`)
    if (!fOk) process.exit(1)
  }

  // G: showProject=false disables the prefix.
  {
    const spawns = []
    const h = {}
    plugin.apply(makeCtx(spawns, h), { showProject: false })
    const session = { id: 'G', header: { delegationDepth: 0, cwd: repoDir } }
    h['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const body = spawns[0]?.argv[spawns[0].argv.indexOf('-Body') + 1]
    const gOk = body === '任务已完成，可以查看结果。'
    console.log(`Case G showProject=false: body="${body}" -> ${gOk ? 'PASS' : 'FAIL'}`)
    if (!gOk) process.exit(1)
  }

  await rm(tmp, { recursive: true, force: true })
}

console.log('ALL SMOKE TESTS PASSED')
