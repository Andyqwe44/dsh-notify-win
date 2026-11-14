// Background answering test: a toast answer must reach the agent while the DSH
// window is minimized — through DSH's own card, never behind its back.
//
// The official question card is the only answerer of `user-questions/request`,
// and Chromium throttles the hidden page that renders it. The page therefore
// waits on a HANGING request (a response is delivered to a hidden renderer like
// any other event) and applies the parked answer immediately. No poll, no
// timer, and the window never moves: these cases pin that contract.
import plugin from '../lib/index.js'
import { createHarness, ensureFakeDotnet } from './fake-helper.mjs'

await ensureFakeDotnet()

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 60))

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
  void h.handlers['tools/execute']({
    name: 'ask_user_question',
    agent,
    callId: 'call-1',
    arguments: { questions: QUESTIONS },
  }, () => new Promise(() => {}))
}

const ops = (h) => h.helper().writes.map((write) => write.op)

/** Consume a leftover parked answer: the queue is shared across plugin loads. */
const drain = async (h) => {
  const peek = await get(h, '/dsh-notify/v2/pending-answer', '/dsh-notify/v2/pending-answer?peek=1')
  if (peek.available === true) {
    await get(h, '/dsh-notify/v2/pending-answer', '/dsh-notify/v2/pending-answer?latest=1&id=' + encodeURIComponent(peek.id))
  }
}

/**
 * Wait for a queued answer without a timer: the hanging request resolves when
 * one is parked. Resolves with null when nothing arrives before the test gives
 * up (its own bound, not the plugin's).
 */
const hangingAnswer = (h, since = '') => Promise.race([
  get(h, '/dsh-notify/v2/wait-answer', `/dsh-notify/v2/wait-answer?since=${encodeURIComponent(since)}`),
  new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 2000)),
])

// --- Case 1: hidden page -> the hanging request delivers the parked answer,
//             and the window is never woken (there is no wake at all). ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-hidden', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c1', visible: false })
  ask(h, root)
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)

  const waiting = hangingAnswer(h)
  await YIELD()
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-hidden', answers: [{ id: 'q1', selected: ['A'] }] })
  const delivered = await waiting
  check(delivered?.answer?.id === toast.id, 'the hanging request delivers the parked answer')
  const state = await get(h, '/dsh-notify/v2/diag')
  check(state.parkedAnswer?.id === toast.id, 'the answer stays parked until the page consumes it')
  check(!ops(h).includes('wake'), 'the window is never woken')
  await drain(h)
  h.dispose()
}

// --- Case 2: the page consumes the answer; nothing else happens. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-applied', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c2', visible: false })
  ask(h, root)
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-applied', answers: [{ id: 'q1', selected: ['B'] }] })
  await YIELD()
  const consumed = await get(h, '/dsh-notify/v2/pending-answer',
    `/dsh-notify/v2/pending-answer?latest=1&id=${encodeURIComponent(toast.id)}`)
  check(consumed.available === true, 'the page consumes the parked answer')
  await YIELD()
  check(!ops(h).includes('wake') && !ops(h).includes('restore'), 'no window operation on the happy path')
  h.dispose()
}

// --- Case 3: the next waiting page gets the next answer. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-next', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c3', visible: true })
  ask(h, root)
  await YIELD()
  const first = h.helper().writes.find((write) => write.op === 'question' && write.approval !== true)
  h.helper().emit({ ev: 'answer', id: first.id, sessionId: 'sess-next', answers: [{ id: 'q1', selected: ['A'] }] })
  const one = await hangingAnswer(h, '')
  check(one?.answer?.id === first.id, 'the first answer is delivered')
  await drain(h)
  const root2 = { session: { id: 'sess-next-2', header: { delegationDepth: 0 } } }
  ask(h, root2)
  await YIELD()
  const toasts = h.helper().writes.filter((write) => write.op === 'question' && write.approval !== true)
  const second = toasts[toasts.length - 1]
  const next = hangingAnswer(h, '')
  h.helper().emit({ ev: 'answer', id: second.id, sessionId: 'sess-next-2', answers: [{ id: 'q1', selected: ['B'] }] })
  const two = await next
  check(two?.answer?.id === second.id, 'the same waiting page picks up the next answer')
  await drain(h)
  h.dispose()
}

// --- Case 4: an approval is delivered the same way. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-approval', header: { delegationDepth: 0 } } }
  await post(h, '/dsh-notify/v2/visibility', { clientId: 'c5', visible: false })
  void h.handlers['approval/request'](
    { agent: root, toolName: 'pwsh', reason: '允许执行?', signal: new AbortController().signal },
    () => new Promise(() => {}),
  )
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval === true)
  const waiting = hangingAnswer(h)
  await YIELD()
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-approval', answers: [{ id: 'approval', selected: ['允许一次'] }] })
  const delivered = await waiting
  check(delivered?.answer?.kind === 'approval' && delivered.answer.id === toast.id, 'an approval answer is delivered the same way')
  await drain(h)
  h.dispose()
}

console.log(failed ? 'BACKGROUND ANSWER TEST FAILED' : 'BACKGROUND ANSWER TEST PASSED')
if (failed) process.exit(1)
