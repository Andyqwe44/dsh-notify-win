// Background answer test: a question must be answerable from the toast while
// the DSH window is minimized.
//
// The official question card is the only answerer of `user-questions/request`,
// and the page that renders it is throttled while hidden. The plugin therefore
// PREPENDS its own listener and holds the request itself when no page is
// visible, settling it from the toast; the first visible page takes every held
// request back so the in-window card flow is unchanged. These cases pin that
// contract against the fake host.
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
 * Ask one question through the plugin's tool hook, exactly like the harness
 * does: the tool executor's `next` enters the answerer waterfall, whose
 * fallback stands for the official card chain (a rejection when no client
 * answers, or a request that stays open, like a card waiting on the user).
 */
const ask = (h, agent, { signal = undefined, fallback = 'reject' } = {}) => {
  const state = { cardCalls: 0 }
  let release
  const cardGate = new Promise((resolve, reject) => { release = { resolve, reject } })
  const tool = h.handlers['tools/execute']({
    name: 'ask_user_question',
    agent,
    callId: 'call-1',
    arguments: { questions: QUESTIONS },
  }, async () => {
    const answer = await h.handlers['user-questions/request'](
      { agent, questions: QUESTIONS, signal },
      () => {
        state.cardCalls += 1
        if (fallback === 'pending') return cardGate
        return Promise.reject(new Error('no client answered'))
      },
    )
    return { value: answer }
  })
  return { tool, state, release }
}

const toasts = (h) => h.helper().writes.filter((write) => write.op === 'question' && write.approval !== true)

// --- Case 1: hidden page -> the host holds the question and the toast answers
//             it; the card chain is never entered. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-hidden', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c1', visible: false })

  const { tool, state } = ask(h, root)
  await YIELD()
  const toast = toasts(h)[0]
  const held = await getRoute(h, '/dsh-notify/state')
  check(toast !== undefined, 'a question toast went out while the page is hidden')
  check(held.pageHidden === true && held.held.length === 1, 'the host holds the request while no page is visible')
  check(state.cardCalls === 0, 'the official card chain is not entered')

  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-hidden', answers: [{ id: 'q1', selected: ['A'] }] })
  const result = await tool
  check(state.cardCalls === 0, 'the card chain stayed out of the answer')
  check(result?.value?.answers?.[0]?.selected?.[0] === 'A', 'the toast answer reached the agent')
  const after = await getRoute(h, '/dsh-notify/state')
  check(after.held.length === 0, 'nothing is left held after the answer')
  const peek = await getRoute(h, '/dsh-notify/pending-answer', '/dsh-notify/pending-answer?peek=1')
  check(peek.available === false, 'nothing is parked for the browser half')
  h.dispose()
}

// --- Case 2: visible page -> the official card chain owns the request again. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-visible', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c2', visible: true })

  const { tool, state } = ask(h, root)
  const outcome = await tool.catch((error) => ({ error }))
  check(state.cardCalls === 1, 'a visible page keeps the official card path')
  check(outcome?.error !== undefined, 'the card chain answers, not the host')
  h.dispose()
}

// --- Case 3: a page becoming visible hands the held request to the card, and
//             a toast answer picked after that is parked for the page. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-handover', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c3', visible: false })

  const { tool, state, release } = ask(h, root, { fallback: 'pending' })
  await YIELD()
  const toast = toasts(h)[0]
  const waiting = await getRoute(h, '/dsh-notify/state')
  check(waiting.held.length === 1, 'the question is held before the page wakes')

  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c3', visible: true })
  await YIELD()
  check(state.cardCalls === 1, 'the held request was handed to the official chain')

  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-handover', answers: [{ id: 'q1', selected: ['B'] }] })
  await YIELD()
  const peek = await getRoute(h, '/dsh-notify/pending-answer', '/dsh-notify/pending-answer?peek=1')
  check(peek.available === true, 'a late toast answer is parked for the visible page')
  release.resolve({ answers: [{ id: 'q1', selected: ['B'] }] })
  await tool.catch(() => {})
  h.dispose()
}

// --- Case 4: an aborted held question rejects instead of hanging. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-abort', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c4', visible: false })

  const controller = new AbortController()
  const { tool } = ask(h, root, { signal: controller.signal })
  await YIELD()
  controller.abort(new Error('cancelled by the agent'))
  const outcome = await tool.catch((error) => ({ error }))
  check(outcome?.error !== undefined, 'an aborted held question rejects')
  h.dispose()
}

// --- Case 5: a delegated agent's question never enters the host path. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const child = { session: { id: 'sess-child', header: { delegationDepth: 2 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c5', visible: false })

  const { tool, state } = ask(h, child)
  await tool.catch(() => {})
  check(state.cardCalls === 1, 'a subagent question falls through to the normal chain')
  h.dispose()
}

// --- Case 6: the card was already handed over, then the window was minimized:
//             the toast still settles the question, and the answer stays parked
//             so the stale card retires when the page wakes. ---
{
  const h = createHarness(plugin, { dedupMs: 0 })
  await h.start()
  const root = { session: { id: 'sess-late-hide', header: { delegationDepth: 0 } } }
  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c6', visible: true })

  const { tool, state } = ask(h, root, { fallback: 'pending' })
  await YIELD()
  const toast = toasts(h)[0]
  const handedOver = await getRoute(h, '/dsh-notify/state')
  check(handedOver.held[0]?.handed === true, 'the card chain owns the question while the page is visible')
  check(state.cardCalls === 1, 'the official chain was entered')

  await postRoute(h, '/dsh-notify/visibility', { clientId: 'c6', visible: false })
  h.helper().emit({ ev: 'answer', id: toast.id, sessionId: 'sess-late-hide', answers: [{ id: 'q1', selected: ['A'] }] })
  const result = await tool
  check(result?.value?.answers?.[0]?.selected?.[0] === 'A',
    'a toast answer settles a handed-over question while the page is hidden')
  const peek = await getRoute(h, '/dsh-notify/pending-answer', '/dsh-notify/pending-answer?peek=1')
  check(peek.available === true, 'the answer stays parked so the stale card can retire')
  h.dispose()
}

console.log(failed ? 'BACKGROUND ANSWER TEST FAILED' : 'BACKGROUND ANSWER TEST PASSED')
if (failed) process.exit(1)
