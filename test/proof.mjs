// End-to-end proof-pipeline test with a fake resident helper.
//
// The fake helper speaks the real stdio JSON protocol, so this covers the whole
// host half without a Windows toast: question dispatch, parked answer, the
// browser pickup, the tool-result comparison, and the two confirmation stages
// (delivered -> spoken with the model's first sentence).
import { PassThrough } from 'node:stream'
import plugin from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (check, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await sleep(15)
  }
  throw new Error('condition timed out')
}

function createFakeHelper() {
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
  return { handle, writes, emit: (message) => { stdout.write(`${JSON.stringify(message)}\n`) } }
}

function createHarness(config = {}) {
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
            if (spec.argv.includes('--check')) return { done: Promise.resolve({ exitCode: 0, signal: null }) }
            fake = createFakeHelper()
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
      await until(() => fake !== null)
      fake.emit({ ev: 'ready', pid: 4242 })
      await until(() => fake.writes !== undefined)
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

function callRoute(routes, path, { method = 'GET', url = path, body } = {}) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`missing route ${path}`)
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      status: 0,
      body: undefined,
      writeHead(status) { this.status = status },
      end(text) {
        this.body = text === undefined || text.length === 0 ? undefined : JSON.parse(text)
        resolve({ status: this.status, body: this.body })
      },
    }
    try {
      handler(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

const assert = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra.length > 0 ? ` (${extra})` : ''}`)
  if (!ok) process.exitCode = 1
}

const askExec = (sessionId, callId, questions) => ({
  name: 'ask_user_question',
  callId,
  agent: { session: { id: sessionId, header: { delegationDepth: 0 } } },
  arguments: { questions },
})

const QUESTIONS = [{
  id: 'Q1',
  header: 'Pick',
  question: 'Which one?',
  options: [{ label: 'A' }, { label: 'B' }],
}]

// --- Happy path: answer -> parked -> delivered -> spoken -------------------
{
  const harness = createHarness()
  await harness.start()

  let resolveTool
  const tool = harness.handlers['tools/execute'](
    askExec('S1', 'call-1', QUESTIONS),
    () => new Promise((resolve) => { resolveTool = resolve }),
  )
  const question = await until(() => harness.helper().writes.find((message) => message.op === 'question'))
  assert(question.sessionId === 'S1' && question.questions[0].id === 'Q1', 'question reaches the helper')
  assert(question.duration === 'short', 'question carries the configured duration')

  harness.helper().emit({
    ev: 'answer',
    id: question.id,
    sessionId: 'S1',
    answers: [{ id: 'Q1', selected: ['B'] }],
  })

  const pickup = await callRoute(harness.routes, '/dsh-notify/pending-answer', {
    url: '/dsh-notify/pending-answer?latest=1',
  })
  assert(pickup.body.id === question.id && pickup.body.answers[0].selected[0] === 'B', 'browser picks up the parked answer')

  await callRoute(harness.routes, '/dsh-notify/answer-ack', {
    method: 'POST',
    body: { id: question.id, ok: true },
  })

  resolveTool({ isError: false, content: [], value: { answers: [{ id: 'Q1', selected: ['B'] }] } })
  await tool
  const delivered = await until(() => harness.helper().writes.find((message) => message.op === 'status' && message.state === 'delivered'))
  assert(delivered.detail === 'B', 'tool result confirms delivery', delivered.detail)

  // The model starts answering the question: first sentence is the receipt.
  harness.handlers['agent/assistant-stream']({
    agent: { session: { id: 'S1' } },
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '好的，我' } },
  })
  harness.handlers['agent/assistant-stream']({
    agent: { session: { id: 'S1' } },
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '按 B 处理了。' } },
  })
  const spoken = await until(() => harness.helper().writes.find((message) => message.op === 'status' && message.state === 'spoken'))
  assert(spoken.detail === '好的，我按 B 处理了。', 'first model sentence becomes the receipt', spoken.detail)

  harness.dispose()
  await until(() => harness.helper().writes.some((message) => message.op === 'shutdown'))
  assert(true, 'dispose shuts the helper down')
}

// --- Mismatch: the agent got a different answer than the toast ------------
{
  const harness = createHarness()
  await harness.start()
  let resolveTool
  const tool = harness.handlers['tools/execute'](
    askExec('S2', 'call-2', QUESTIONS),
    () => new Promise((resolve) => { resolveTool = resolve }),
  )
  const question = await until(() => harness.helper().writes.find((message) => message.op === 'question'))
  harness.helper().emit({ ev: 'answer', id: question.id, sessionId: 'S2', answers: [{ id: 'Q1', selected: ['B'] }] })
  await callRoute(harness.routes, '/dsh-notify/pending-answer', { url: '/dsh-notify/pending-answer?latest=1' })
  await callRoute(harness.routes, '/dsh-notify/answer-ack', { method: 'POST', body: { id: question.id, ok: true } })
  resolveTool({ isError: false, content: [], value: { answers: [{ id: 'Q1', selected: ['A'] }] } })
  await tool
  const mismatch = await until(() => harness.helper().writes.find((message) => message.op === 'status' && message.state === 'mismatch'))
  assert(mismatch.detail === 'A', 'a different agent answer is reported, not hidden', mismatch.detail)
  harness.dispose()
}

// --- No model text: the turn ends after the tool result -------------------
{
  const harness = createHarness()
  await harness.start()
  let resolveTool
  const tool = harness.handlers['tools/execute'](
    askExec('S3', 'call-3', QUESTIONS),
    () => new Promise((resolve) => { resolveTool = resolve }),
  )
  const question = await until(() => harness.helper().writes.find((message) => message.op === 'question'))
  harness.helper().emit({ ev: 'answer', id: question.id, sessionId: 'S3', answers: [{ id: 'Q1', selected: ['A'] }] })
  await callRoute(harness.routes, '/dsh-notify/pending-answer', { url: '/dsh-notify/pending-answer?latest=1' })
  resolveTool({ isError: false, content: [], value: { answers: [{ id: 'Q1', selected: ['A'] }] } })
  await tool
  await until(() => harness.helper().writes.find((message) => message.op === 'status' && message.state === 'delivered'))
  harness.handlers['session/event'](
    { id: 'S3', header: { delegationDepth: 0 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  const nospeech = await until(() => harness.helper().writes.find((message) => message.op === 'status' && message.state === 'nospeech'))
  assert(nospeech !== undefined, 'a turn ending without text reports no text reply')
  harness.dispose()
}

// --- Stale toast: the question was already settled ------------------------
{
  const harness = createHarness()
  await harness.start()
  harness.helper().emit({
    ev: 'answer',
    id: 'q-stale',
    sessionId: 'S4',
    answers: [{ id: 'Q1', selected: ['A'] }],
  })
  const stale = await until(() => harness.helper().writes.find((message) => message.op === 'status' && message.state === 'stale'))
  assert(stale !== undefined, 'an answer with no live question is reported stale')
  harness.dispose()
}

console.log(process.exitCode === 1 ? 'PROOF TEST FAILED' : 'PROOF TEST PASSED')
