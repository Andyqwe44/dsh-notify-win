// Background answering test: a toast answer must reach the agent while the DSH
// window is minimized — through DSH's own card, never behind its back.
//
// The official question card is the only answerer of `user-questions/request`,
// and Chromium throttles the hidden page that renders it. The page therefore
// waits on a HANGING request (a response is delivered to a hidden renderer like
// any other event) and applies the parked answer immediately; the helper wake
// is only the fallback for a page that cannot act. These cases pin that
// contract: the host never settles the waterfall itself.
import plugin from '../lib/index.js'
import { createHarness, ensureFakeDotnet } from './fake-helper.mjs'

await ensureFakeDotnet()

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 60))
const GRACE = 600

let failed = false
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed = true
}

/** Route helpers: the host tests only need the handler's JSON answer. */
const routeCall = (h, path, url, body) => new Promise((resolve, reject) => {
  const route = h.routes.get(path)
  if (route === undefined) {
    reject(new Error(`missing route ${path}`))
    return
  }
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    url,
    method: body === undefined ? 'GET' : 'POST',
    on() {},
    async* [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const res = {
    writeHead() {},
    end(text) {
      try {
        resolve(JSON.parse(String(text)))
      } catch (error) {
        reject(error)
      }
    },
  }
  Promise.resolve(route(req, res)).catch(reject)
})
const get = (h, path, url = path) => routeCall(h, path, url)
const post = (h, path, body) => routeCall(h, path, path, body)

const QUESTIONS = [{ id: 'q1', question: '继续吗？', options: [{ label: 'A' }, { label: 'B' }] }]

/** Ask a question through the tool hook; the card chain stays pending. */
const ask = (h, agent) => {
  const tool = h.handlers['tools/execute']({
    name: 'ask_user_question',
    agent,
    callId: 'call-1',
    arguments: { questions: QUESTIONS },
  }, () => new Promise(() => {}))
  void tool
}

const ops = (h) => h.helper().writes.map((write) => write.op)

/** Consume a leftover parked answer: the queue is shared across plugin loads. */
const drain = async (h) => {
  const peek = await get(h, '/dsh-notify/v2/pending-answer', '/dsh-notify/v2/pending-answer?peek=1')
  if (peek.available === true) {
    await get(h, '/dsh-notify/v2/pending-answer', '/dsh-notify/v2/pending-answer?latest=1&id=' + encodeURIComponent(peek.id))
  }
}

// --- Case 1: hidden page -> the answer is parked, the hanging request returns
//             it right away, and the wake is only the delayed fallback. ---
{
  const h = createHarness(plugin, { dedupMs: 0, answerWakeGraceMs: GRACE })
  await h.start()
  const root = { session: { id: 'sess-hidden', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c1', visible: false })
  ask(h, root)
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)

  const waiting = get(h, '/dsh-notify/v2/wait-answer', '/dsh-notify/v2/wait-answer?since=')
  await YIELD()
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-hidden', answers: [{ id: 'q1', selected: ['A'] }] })
  const delivered = await waiting
  check(delivered?.answer?.id === toast.id, 'the hanging request delivers the parked answer')
  check(!ops(h).includes('wake'), 'no wake while the page can still act')
  await new Promise((resolve) => setTimeout(resolve, GRACE + 80))
  check(ops(h).includes('wake'), 'the wake is the delayed fallback')
  await drain(h)
  h.dispose()
}

// --- Case 2: the page applies the answer -> the fallback wake is retired. ---
{
  const h = createHarness(plugin, { dedupMs: 0, answerWakeGraceMs: GRACE })
  await h.start()
  const root = { session: { id: 'sess-applied', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c2', visible: false })
  ask(h, root)
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-applied', answers: [{ id: 'q1', selected: ['B'] }] })
  await YIELD()
  const consumed = await get(h, '/dsh-notify/v2/pending-answer', `/dsh-notify/v2/pending-answer?latest=1&id=${encodeURIComponent(toast.id)}`)
  check(consumed.available === true, 'the page consumes the parked answer')
  await new Promise((resolve) => setTimeout(resolve, GRACE + 80))
  check(!ops(h).includes('wake'), 'a consumed answer never wakes the window')
  await drain(h)
  h.dispose()
}

// --- Case 3: a visible page -> no wake at all. ---
{
  const h = createHarness(plugin, { dedupMs: 0, answerWakeGraceMs: GRACE })
  await h.start()
  const root = { session: { id: 'sess-visible', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c3', visible: true })
  ask(h, root)
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-visible', answers: [{ id: 'q1', selected: ['A'] }] })
  await YIELD()
  const parked = await get(h, '/dsh-notify/v2/pending-answer', '/dsh-notify/v2/pending-answer?peek=1')
  check(parked.available === true, 'the visible page gets the parked answer')
  await new Promise((resolve) => setTimeout(resolve, GRACE + 80))
  check(!ops(h).includes('wake'), 'a visible page needs no wake')
  await drain(h)
  h.dispose()
}

// --- Case 4: the page reports its failure -> the helper puts the window back. ---
{
  const h = createHarness(plugin, { dedupMs: 0, answerWakeGraceMs: GRACE })
  await h.start()
  const root = { session: { id: 'sess-ack', header: { delegationDepth: 0 } } }
  ask(h, root)
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)
  await post(h, '/dsh-notify/v2/answer-ack', { id: toast.id, ok: false, reason: 'no-card' })
  check(ops(h).includes('restore'), 'an acknowledged answer restores the window')
  await drain(h)
  h.dispose()
}

// --- Case 5: an approval keeps the same contract. ---
{
  const h = createHarness(plugin, { dedupMs: 0, answerWakeGraceMs: GRACE })
  await h.start()
  const root = { session: { id: 'sess-approval', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c5', visible: false })
  void h.handlers['approval/request'](
    { agent: root, toolName: 'pwsh', reason: '允许执行?', signal: new AbortController().signal },
    () => new Promise(() => {}),
  )
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval === true)
  const waiting = get(h, '/dsh-notify/v2/wait-answer', '/dsh-notify/v2/wait-answer?since=')
  await YIELD()
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-approval', answers: [{ id: 'approval', selected: ['允许一次'] }] })
  const delivered = await waiting
  check(delivered?.answer?.kind === 'approval' && delivered.answer.id === toast.id, 'an approval answer is delivered the same way')
  await drain(h)
  h.dispose()
}

console.log(failed ? 'BACKGROUND ANSWER TEST FAILED' : 'BACKGROUND ANSWER TEST PASSED')
if (failed) process.exit(1)
