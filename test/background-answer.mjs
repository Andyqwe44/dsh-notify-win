// Background answering test: a toast answer must reach the agent while the DSH
// window is minimized — through DSH's own card, never behind its back.
//
// The official question card is the only answerer of `user-questions/request`,
// and Chromium throttles the hidden page that renders it. The plugin therefore
// keeps parking the answer and asks the resident helper to wake the window for
// the click (and to put it back afterwards). These cases pin that contract:
// the host never settles the waterfall itself.
import plugin from '../lib/index.js'
import { createHarness, ensureFakeDotnet } from './fake-helper.mjs'

await ensureFakeDotnet()

const YIELD = () => new Promise((resolve) => setTimeout(resolve, 60))

let failed = false
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed = true
}

/** POST JSON to one registered host route and parse its JSON answer. */
const postRoute = (h, path, payload) => new Promise((resolve, reject) => {
  const route = h.routes.get(path)
  if (route === undefined) {
    reject(new Error(`missing route ${path}`))
    return
  }
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    url: path,
    method: 'POST',
    async* [Symbol.asyncIterator]() {
      yield body
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

/** GET one registered host route and parse its JSON answer. */
const getRoute = (h, path, url = path) => new Promise((resolve, reject) => {
  const route = h.routes.get(path)
  if (route === undefined) {
    reject(new Error(`missing route ${path}`))
    return
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
  Promise.resolve(route({ url, method: 'GET' }, res)).catch(reject)
})

const QUESTIONS = [{ id: 'q1', question: '继续吗？', options: [{ label: 'A' }, { label: 'B' }] }]

/**
 * Ask one question through the plugin's tool hook. The fallback stands for the
 * official card chain: it only resolves when a parked answer is applied by the
 * page, so a host that settles the question itself would show up as a fallback
 * that was never reached.
 */
const ask = (h, agent, { fallback = 'pending' } = {}) => {
  const state = { cardCalls: 0 }
  let release
  const cardGate = new Promise((resolve, reject) => { release = { resolve, reject } })
  const tool = h.handlers['tools/execute']({
    name: 'ask_user_question',
    agent,
    callId: 'call-1',
    arguments: { questions: QUESTIONS },
  }, async () => {
    const answer = await h.handlers['user-questions/request']({ agent, questions: QUESTIONS }, () => {
      state.cardCalls += 1
      if (fallback === 'pending') return cardGate
      return Promise.reject(new Error('no client answered'))
    })
    return { value: answer }
  })
  return { tool, state, release }
}

const toasts = (h) => h.helper().writes.filter((write) => write.op === 'question' && write.approval !== true)
const ops = (h) => h.helper().writes.map((write) => write.op)

// --- Case 1: hidden page -> the answer is parked and the helper is asked to
//             wake the window; the host never answers the question itself. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-hidden', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c1', visible: false })

  const { tool, state } = ask(h, root)
  await YIELD()
  const toast = toasts(h)[0]
  const before = await getRoute(h, '/dsh-notify/state')
  check(toast !== undefined, 'a question toast went out while the page is hidden')
  check(before.pageHidden === true, 'the host knows no page can click')

  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-hidden', answers: [{ id: 'q1', selected: ['A'] }] })
  await YIELD()
  check(ops(h).includes('wake'), 'the helper is asked to wake the window for the click')
  const parked = await getRoute(h, '/dsh-notify/pending-answer', '/dsh-notify/pending-answer?peek=1')
  check(parked.available === true, 'the answer is parked for DSH to apply itself')
  check(state.cardCalls === 1, 'the official card chain still owns the answer')
  check(!ops(h).includes('restore'), 'no restore before the page reports back')

  await postRoute(h, '/dsh-notify/answer-ack', { id: toast.id, ok: true })
  check(ops(h).includes('restore'), 'the window is restored once the page applied the answer')
  h.dispose()
}

// --- Case 2: a visible page -> no wake at all. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-visible', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c2', visible: true })

  const { tool, state } = ask(h, root, { fallback: 'pending' })
  await YIELD()
  const toast = toasts(h)[0]
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-visible', answers: [{ id: 'q1', selected: ['B'] }] })
  await YIELD()
  const parked = await getRoute(h, '/dsh-notify/pending-answer', '/dsh-notify/pending-answer?peek=1')
  check(parked.available === true, 'the visible page gets the parked answer')
  check(!ops(h).includes('wake'), 'a visible page needs no wake')
  check(state.cardCalls === 1, 'the official chain owns the answer')
  h.dispose()
}

// --- Case 3: an approval keeps the same contract. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-approval', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c3', visible: false })
  const pending = h.handlers['approval/request'](
    { agent: root, toolName: 'pwsh', reason: '允许执行?', signal: new AbortController().signal },
    () => new Promise(() => {}),
  )
  await YIELD()
  const toast = h.helper().writes.find((write) => write.op === 'question' && write.approval === true)
  if (toast !== undefined) {
    h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-approval', answers: [{ id: 'approval', selected: ['允许一次'] }] })
  }
  await YIELD()
  check(ops(h).includes('wake'), 'an approval answer wakes the window too')
  h.dispose()
  void pending
}

// --- Case 4: the page reports itself hidden/visible through the route, and the
//             state route reflects it. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  check((await getRoute(h, '/dsh-notify/state')).pageHidden === false, 'no report yet: the old path is kept')
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c4', visible: false })
  check((await getRoute(h, '/dsh-notify/state')).pageHidden === true, 'a hidden report turns the wake on')
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c4', visible: true })
  check((await getRoute(h, '/dsh-notify/state')).pageHidden === false, 'a visible report turns it off again')
  h.dispose()
}

console.log(failed ? 'BACKGROUND ANSWER TEST FAILED' : 'BACKGROUND ANSWER TEST PASSED')
if (failed) process.exit(1)
