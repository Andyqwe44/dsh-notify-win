// Smoke test for dsh-notify-win plugin logic with a fake resident helper.
// Covers the multi-project guarantee: different sessions ALWAYS each notify
// (per-session dedup), same-session rapid idle is suppressed, subagents are
// skipped, waterfall listeners call next(), and project labels resolve.
// Also covers every live turn-end reason: the notification must say WHY the
// turn stopped (max-tokens / blocked / LLM failure with retry count / cancelled),
// while a disposed cancel stays silent and historical markers never toast.
import plugin from '../lib/index.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness, ensureFakeDotnet } from './fake-helper.mjs'

await ensureFakeDotnet()

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 80))

const notesOf = (h) => h.helper().writes.filter((message) => message.op === 'notify')

// --- Case A: per-session dedup (default 1500ms). ---
// Two DIFFERENT projects finish -> both must notify. Same project finishing
// twice within dedupMs -> only one.
{
  const h = createHarness(plugin, { dedupMs: 1500 })
  await h.start()

  const projA = { id: 'sess-A', header: { delegationDepth: 0 } }
  const projB = { id: 'sess-B', header: { delegationDepth: 0 } }
  const agentA = { session: { id: 'sess-A', header: projA } }
  const agentB = { session: { id: 'sess-B', header: projB } }

  h.handlers['agent/status']({ status: 'idle', agent: agentA })
  h.handlers['agent/status']({ status: 'idle', agent: agentB })
  h.handlers['agent/status']({ status: 'idle', agent: agentA })

  await YIELD()
  const notes = notesOf(h)
  const aOk = notes.length === 2 && notes[0].kind === 'done' && notes[1].kind === 'done'
  console.log(`Case A multi-project: ${notes.length} notification(s) -> ${aOk ? 'PASS' : 'FAIL'}`)
  if (!aOk) process.exit(1)
  h.dispose()
}

// --- Case B: subagent skipped, waterfall next() always called, tool filter,
//             same-session question burst collapses (anti-spam). ---
{
  const h = createHarness(plugin, { dedupMs: 1500 })
  await h.start()
  const nextCalls = []
  const root = { session: { id: 'root', header: { delegationDepth: 0 } } }
  const child = { session: { id: 'child', header: { delegationDepth: 2 } } }

  // subagent idle -> skip
  h.handlers['agent/status']({ status: 'idle', agent: child })
  // running -> nothing
  h.handlers['agent/status']({ status: 'running', agent: root })
  // approval root + next()
  h.handlers['approval/request']({ agent: root, reason: '允许?' }, () => { nextCalls.push('approval'); return 'ok' })
  // ask_user_question SAME session within dedup window -> notification suppressed
  h.handlers['tools/execute']({ name: 'ask_user_question', agent: root }, () => { nextCalls.push('tool'); return 'ok' })
  // other tool -> next but no notification
  h.handlers['tools/execute']({ name: 'pwsh', agent: root }, () => { nextCalls.push('pwsh'); return 'ok' })

  await YIELD()
  const notes = notesOf(h)
  const bOk =
    notes.length === 1 && notes[0].kind === 'question' &&
    nextCalls.join(',') === 'approval,tool,pwsh'
  console.log(`Case B skip/waterfall/same-session-collapse: notifications=${notes.length}, next=${nextCalls.join(',')} -> ${bOk ? 'PASS' : 'FAIL'}`)
  if (!bOk) process.exit(1)
  h.dispose()
}

// --- Case C: per-session with dedupMs=0 (diagnostic mode) fires on every
//             distinct trigger even for the same session. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'root', header: { delegationDepth: 0 } } }
  h.handlers['agent/status']({ status: 'idle', agent: root })
  h.handlers['agent/status']({ status: 'idle', agent: root })
  await YIELD()
  const notes = notesOf(h)
  const cOk = notes.length === 2
  console.log(`Case C dedupMs=0 same-session: ${notes.length} notifications -> ${cOk ? 'PASS' : 'FAIL'}`)
  if (!cOk) process.exit(1)
  h.dispose()
}

// --- Case D: different-session "done" + "question" close together each notify. ---
{
  const h = createHarness(plugin, { dedupMs: 1500 })
  await h.start()
  const a = { session: { id: 'A', header: { delegationDepth: 0 } } }
  const b = { session: { id: 'B', header: { delegationDepth: 0 } } }
  h.handlers['agent/status']({ status: 'idle', agent: a })
  h.handlers['approval/request']({ agent: b, reason: '允许?' }, () => 'ok')
  await YIELD()
  const kinds = notesOf(h).map((note) => note.kind).sort()
  const dOk = kinds.length === 2 && kinds[0] === 'done' && kinds[1] === 'question'
  console.log(`Case D cross-session burst: ${kinds.length} notifications, kinds=${JSON.stringify(kinds)} -> ${dOk ? 'PASS' : 'FAIL'}`)
  if (!dOk) process.exit(1)
  h.dispose()
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
    const h = createHarness(plugin)
    await h.start()
    const session = { id: 'E', header: { delegationDepth: 0, cwd: repoDir } }
    h.handlers['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const body = notesOf(h)[0]?.body
    const eOk = body === 'dsh-notify-win：任务已完成，可以查看结果。'
    console.log(`Case E git repo label: body="${body}" -> ${eOk ? 'PASS' : 'FAIL'}`)
    if (!eOk) process.exit(1)
    h.dispose()
  }

  // F: no git -> cwd folder name.
  {
    const h = createHarness(plugin)
    await h.start()
    const session = { id: 'F', header: { delegationDepth: 0, cwd: plainDir } }
    h.handlers['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const body = notesOf(h)[0]?.body
    const fOk = body === 'no-git-folder：任务已完成，可以查看结果。'
    console.log(`Case F folder label: body="${body}" -> ${fOk ? 'PASS' : 'FAIL'}`)
    if (!fOk) process.exit(1)
    h.dispose()
  }

  // G: showProject=false disables the prefix.
  {
    const h = createHarness(plugin, { showProject: false })
    await h.start()
    const session = { id: 'G', header: { delegationDepth: 0, cwd: repoDir } }
    h.handlers['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const body = notesOf(h)[0]?.body
    const gOk = body === '任务已完成，可以查看结果。'
    console.log(`Case G showProject=false: body="${body}" -> ${gOk ? 'PASS' : 'FAIL'}`)
    if (!gOk) process.exit(1)
    h.dispose()
  }

  await rm(tmp, { recursive: true, force: true })
}

// --- Cases H..O: every live stop reason reaches the right notification. ---
// A turn/end is always appended before the idle transition, so each case feeds
// the session/event feed first and then the idle status.
{
  const runCase = async (name, events, { idle = true, ...options } = {}) => {
    const h = createHarness(plugin, { dedupMs: 0, ...options })
    await h.start()
    const session = { id: `sess-${name}`, header: { delegationDepth: 0 } }
    for (const event of events) h.handlers['session/event'](session, event)
    // Compaction reports on session/event alone; every turn-end case needs the
    // following idle transition to produce its notification.
    if (idle) h.handlers['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const notes = notesOf(h)
    return {
      h,
      notes,
      kinds: notes.map((note) => note.kind),
      arg: (key) => notes[0]?.[key],
      body: notes[0]?.body,
    }
  }
  const turnEnd = (reason) => ({ type: 'turn/end', data: { turn: 1, reason } })
  const turnStart = { type: 'turn/start', data: { turn: 1 } }

  // H: output-token ceiling -> alert, not "task complete".
  {
    const r = await runCase('H', [turnEnd({ kind: 'max-tokens' })])
    const ok = r.kinds.length === 1 && r.kinds[0] === 'alert' && r.arg('reason') === 'max-tokens'
    console.log(`Case H max-tokens: kind=${r.kinds[0]} reason=${r.arg('reason')} -> ${ok ? 'PASS' : 'FAIL'}`)
    r.h.dispose()
    if (!ok) process.exit(1)
  }

  // I: retries exhausted -> alert carries the failure code and retry count.
  {
    const r = await runCase('I', [
      turnStart,
      { type: 'llm/retry', data: { retry: 5, maxRetries: 5, failure: { code: 'RATE_LIMIT', message: 'busy' } } },
      turnEnd({ kind: 'error', error: { code: 'RATE_LIMIT', message: 'busy' } }),
    ])
    const ok = r.kinds[0] === 'alert' && r.arg('code') === 'RATE_LIMIT' &&
      r.arg('retry') === 5 && r.arg('retryMax') === 5 &&
      String(r.body).includes('接口限流') && String(r.body).includes('5/5')
    console.log(`Case I retry-exhausted: code=${r.arg('code')} retry=${r.arg('retry')}/${r.arg('retryMax')} body="${r.body}" -> ${ok ? 'PASS' : 'FAIL'}`)
    r.h.dispose()
    if (!ok) process.exit(1)
  }

  // J: user cancel -> lightweight "cancelled" notice.
  {
    const r = await runCase('J', [turnEnd({ kind: 'aborted', reason: { kind: 'user' } })])
    const ok = r.kinds.length === 1 && r.kinds[0] === 'notice' && r.arg('code') === 'user' &&
      String(r.body).includes('已取消')
    console.log(`Case J cancelled: kind=${r.kinds[0]} code=${r.arg('code')} body="${r.body}" -> ${ok ? 'PASS' : 'FAIL'}`)
    r.h.dispose()
    if (!ok) process.exit(1)
  }

  // K: disposal cancel -> silent (no shutdown toast).
  {
    const r = await runCase('K', [turnEnd({ kind: 'aborted', reason: { kind: 'disposed' } })])
    const ok = r.notes.length === 0
    console.log(`Case K disposed-cancel silent: ${r.notes.length} notification(s) -> ${ok ? 'PASS' : 'FAIL'}`)
    r.h.dispose()
    if (!ok) process.exit(1)
  }

  // L: pre-step blocked -> alert.
  {
    const r = await runCase('L', [turnEnd({ kind: 'blocked' })])
    const ok = r.kinds[0] === 'alert' && r.arg('reason') === 'blocked'
    console.log(`Case L blocked: kind=${r.kinds[0]} reason=${r.arg('reason')} -> ${ok ? 'PASS' : 'FAIL'}`)
    r.h.dispose()
    if (!ok) process.exit(1)
  }

  // M: compaction: success -> compact toast, failure -> alert.
  {
    const okRun = await runCase('M1', [
      { type: 'compaction/end', data: { compactionId: 'c1', turn: null } },
    ], { idle: false })
    const failRun = await runCase('M2', [
      { type: 'compaction/end', data: { compactionId: 'c2', turn: null, error: 'summary rejected' } },
    ], { idle: false })
    const ok = okRun.kinds[0] === 'compact' &&
      failRun.kinds[0] === 'alert' && String(failRun.body).includes('summary rejected')
    console.log(`Case M compaction success=${okRun.kinds[0]} failure=${failRun.kinds[0]} -> ${ok ? 'PASS' : 'FAIL'}`)
    okRun.h.dispose()
    failRun.h.dispose()
    if (!ok) process.exit(1)
  }

  // N: historical markers never toast; an unknown future reason renders as alert.
  {
    const marker = await runCase('N1', [turnEnd({ kind: 'interrupted' })])
    const unknown = await runCase('N2', [turnEnd({ kind: 'budget' })])
    const ok = marker.notes.length === 0 &&
      unknown.kinds[0] === 'alert' && String(unknown.body).includes('budget')
    console.log(`Case N markers/unknown: interrupted=${marker.notes.length} unknown=${unknown.kinds[0]} -> ${ok ? 'PASS' : 'FAIL'}`)
    marker.h.dispose()
    unknown.h.dispose()
    if (!ok) process.exit(1)
  }

  // O: a second idle for the same turn does not re-notify.
  {
    const h = createHarness(plugin, { dedupMs: 0 })
    await h.start()
    const session = { id: 'sess-O', header: { delegationDepth: 0 } }
    h.handlers['session/event'](session, turnEnd({ kind: 'max-tokens' }))
    h.handlers['agent/status']({ status: 'idle', agent: { session } })
    h.handlers['agent/status']({ status: 'idle', agent: { session } })
    await YIELD()
    const ok = notesOf(h).length === 1
    console.log(`Case O duplicate idle: ${notesOf(h).length} notification(s) -> ${ok ? 'PASS' : 'FAIL'}`)
    h.dispose()
    if (!ok) process.exit(1)
  }
}

console.log('ALL SMOKE TESTS PASSED')
