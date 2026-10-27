import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'

function fakeAgent() {
  const pending = []
  return {
    pending,
    session: { surface: { nodes: [] }, eventAt: () => undefined },
    inbox: {
      nextStep: pending,
      prepend(_target, message) {
        pending.unshift(message)
      },
      replace(id, message) {
        const index = pending.findIndex(item => item.id === id)
        if (index < 0) return false
        pending[index] = message
        return true
      },
      remove(id) {
        const index = pending.findIndex(item => item.id === id)
        if (index < 0) return false
        pending.splice(index, 1)
        return true
      },
    },
  }
}

function fakeCtx({ workspaceRegistry, workingDirectory = { ensure: async () => '/tmp' }, skills } = {}) {
  const handlers = new Map()
  const injections = []
  const providers = []
  const disposers = []
  const ctx = {
    logger: { warn() {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    inject(deps, callback) {
      injections.push(deps)
      if (deps.every(dependency => ctx[dependency] !== undefined)) callback(ctx)
    },
    get(service) {
      return service === 'workspaceRegistry' ? workspaceRegistry : undefined
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
    workingDirectory,
  }
  const listenerOf = event => handlers.get(event)?.at(-1)
  const emit = (event, ...args) => {
    for (const handler of handlers.get(event) ?? []) handler(...args)
  }
  if (skills) {
    ctx.skills = {
      registerProvider(create) {
        providers.push(create)
        return () => {}
      },
    }
  }
  return { ctx, handlers, listenerOf, emit, injections, providers, disposers }
}

const USER_MESSAGE = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }

/** Simulate the durable user/message append the loop performs after entering the step. */
function commit(emit, agent, seq, message) {
  emit('session/event', agent.session, { seq, type: 'user/message', data: message })
}

test('the plugin exports its row name', () => {
  assert.equal(name, 'workspace-inherit')
})

test('apply registers nothing when disabled', () => {
  const { ctx, handlers, injections } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(handlers.size, 0)
  assert.deepEqual(injections, [])
})

test('apply registers a pre-step listener and a skill provider', () => {
  const { ctx, listenerOf, providers } = fakeCtx({ workspaceRegistry: { list: () => [] }, skills: {} })
  apply(ctx, {})
  assert.equal(typeof listenerOf('agent/pre-step'), 'function')
  assert.equal(providers.length, 1)
})

test('the pre-step listener injects the parent baseline once, then stays quiet', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-index-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'AGENTS.md'), '# PARENT VIA LISTENER\n')

    const agent = fakeAgent()
    const { ctx, listenerOf, emit } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const signal = new AbortController().signal
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })

    const first = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    assert.equal(first.messages.length, 2)
    assert.match(first.messages[1].content[0].text, /PARENT VIA LISTENER/)
    assert.equal(first.messages[1].source.kind, 'workspace-inherit')
    assert.equal(first.messages[1].source.baseline, true)
    commit(emit, agent, 10, first.messages[1])

    const second = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 2, signal }, next)
    assert.equal(second.messages.length, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the pre-step listener leaves the step untouched without a workspace registry', async () => {
  const { ctx, listenerOf } = fakeCtx()
  apply(ctx, {})
  const listener = listenerOf('agent/pre-step')
  const decision = { kind: 'enter', messages: [USER_MESSAGE] }
  const next = async () => decision
  const result = await listener({ agent: fakeAgent(), messages: [USER_MESSAGE], turn: 1, step: 1, signal: new AbortController().signal }, next)
  assert.deepEqual(result, decision)
})

test('the pre-step listener survives a working-directory failure', async () => {
  const { ctx, listenerOf } = fakeCtx({
    workspaceRegistry: { list: () => [{ path: '/tmp' }] },
    workingDirectory: { ensure: async () => { throw new Error('gone') } },
  })
  apply(ctx, {})
  const listener = listenerOf('agent/pre-step')
  const decision = { kind: 'enter', messages: [USER_MESSAGE] }
  const next = async () => decision
  const result = await listener({ agent: fakeAgent(), messages: [USER_MESSAGE], turn: 1, step: 1, signal: new AbortController().signal }, next)
  assert.deepEqual(result, decision)
})

test('the registered skill provider lists parent-workspace skills', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-index-skills-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(join(parent, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(parent, '.dsh', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: parent skill\n---\n# alpha\n')
    await mkdir(child, { recursive: true })

    const { ctx, providers } = fakeCtx({ workspaceRegistry: { list: () => [{ path: parent }] }, skills: {} })
    apply(ctx, { includeInstructions: false })
    const provider = providers[0]({ invalidate() {}, signal: new AbortController().signal })
    const candidates = await provider.list({ cwd: child })
    assert.deepEqual(candidates.map(candidate => candidate.name), ['alpha'])
    provider.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a surface replacement that shadows the injected context re-injects the baseline', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-compact-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'AGENTS.md'), '# PARENT COMPACTION\n')
    const agent = fakeAgent()
    const { ctx, listenerOf, emit } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const signal = new AbortController().signal
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })

    const first = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    assert.equal(first.messages.length, 2)
    commit(emit, agent, 10, first.messages[1])

    const quiet = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 2, signal }, next)
    assert.equal(quiet.messages.length, 1)

    // Real 0.2.1-rc.2 shape: the summary event carries no surfaceOp, and the
    // replacement is a user/message checkpoint carrying surfaceOp.replace.
    emit('session/event', agent.session, { seq: 1682, type: 'compaction/summary', data: { summary: 'summary' } })
    emit('session/event', agent.session, {
      seq: 1683,
      type: 'user/message',
      data: { source: { kind: 'compact-checkpoint' }, content: [] },
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 1681 },
    })
    const reinjected = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 3, signal }, next)
    assert.equal(reinjected.messages.length, 2)
    assert.match(reinjected.messages[1].content[0].text, /PARENT COMPACTION/)
    commit(emit, agent, 1684, reinjected.messages[1])

    // A second compaction over the re-injected baseline must re-inject again.
    emit('session/event', agent.session, { seq: 1685, type: 'compaction/summary', data: { summary: 'summary' } })
    emit('session/event', agent.session, {
      seq: 1686,
      type: 'user/message',
      data: { source: { kind: 'compact-checkpoint' }, content: [] },
      surfaceOp: { op: 'replace', startSeq: 1684, endSeq: 1684 },
    })
    const reagain = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 4, signal }, next)
    assert.equal(reagain.messages.length, 2)
    assert.match(reagain.messages[1].content[0].text, /PARENT COMPACTION/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an unrelated surface replacement keeps the context quiet', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-compact-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'AGENTS.md'), '# PARENT KEEP\n')
    const agent = fakeAgent()
    const { ctx, listenerOf, emit } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const signal = new AbortController().signal
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })

    const first = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    commit(emit, agent, 10, first.messages[1])
    emit('session/event', agent.session, { seq: 9, type: 'compaction/summary', data: { summary: 'summary' } })
    emit('session/event', agent.session, {
      seq: 11,
      type: 'user/message',
      data: { source: { kind: 'compact-checkpoint' }, content: [] },
      surfaceOp: { op: 'replace', startSeq: 11, endSeq: 20 },
    })
    const quiet = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 2, signal }, next)
    assert.equal(quiet.messages.length, 1)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the first delivery after a quiet start uses the baseline frame, not an additional-instructions delta', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-first-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    const agent = fakeAgent()
    const { ctx, listenerOf } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const signal = new AbortController().signal
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })

    const quiet = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    assert.equal(quiet.messages.length, 1)

    await writeFile(join(parent, 'AGENTS.md'), '# LATE PARENT\n')
    const first = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 2, signal }, next)
    assert.equal(first.messages.length, 2)
    assert.match(first.messages[1].content[0].text, /The following instructions come from a parent workspace/)
    assert.doesNotMatch(first.messages[1].content[0].text, /Additional parent-workspace instructions/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the pre-step listener canonicalizes a symlinked working directory before chain math', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-symlink-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    const link = join(base, 'child-link')
    await mkdir(child, { recursive: true })
    await symlink(child, link)
    await writeFile(join(parent, 'AGENTS.md'), '# SYMLINK PARENT\n')
    const agent = fakeAgent()
    const { ctx, listenerOf, emit } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => link },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })
    const signal = new AbortController().signal
    const first = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    assert.equal(first.messages.length, 2)
    assert.match(first.messages[1].content[0].text, /SYMLINK PARENT/)
    commit(emit, agent, 10, first.messages[1])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an uncommitted injection leaves delivery state unchanged, so the baseline is resent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-abort-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'AGENTS.md'), '# ABORT PARENT\n')
    const agent = fakeAgent()
    const { ctx, listenerOf } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const signal = new AbortController().signal
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })

    // The step enters but aborts before the loop commits the user/message event.
    const first = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    assert.equal(first.messages.length, 2)
    const second = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    assert.equal(second.messages.length, 2)
    assert.match(second.messages[1].content[0].text, /ABORT PARENT/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an aborted step signal skips injection and keeps the original decision', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-signal-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'AGENTS.md'), '# SIGNAL PARENT\n')
    const agent = fakeAgent()
    const { ctx, listenerOf } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const controller = new AbortController()
    controller.abort()
    const decision = { kind: 'enter', messages: [USER_MESSAGE] }
    const result = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal: controller.signal }, async () => decision)
    assert.deepEqual(result, decision)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a replacement that shadows only the baseline still triggers a re-baseline', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-baseline-shadow-'))
  try {
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'AGENTS.md'), '# SHADOW PARENT V1\n')
    const agent = fakeAgent()
    const { ctx, listenerOf, emit } = fakeCtx({
      workspaceRegistry: { list: () => [{ path: parent }] },
      workingDirectory: { ensure: async () => child },
    })
    apply(ctx, {})
    const listener = listenerOf('agent/pre-step')
    const signal = new AbortController().signal
    const next = async () => ({ kind: 'enter', messages: [USER_MESSAGE] })

    const baseline = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 1, signal }, next)
    commit(emit, agent, 10, baseline.messages[1])

    await writeFile(join(parent, 'AGENTS.md'), '# SHADOW PARENT V2\n')
    const delta = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 2, signal }, next)
    assert.equal(delta.messages.length, 2)
    commit(emit, agent, 50, delta.messages[1])

    // Compaction shadows seq 5..20: the baseline (10) is gone, the delta (50) survives.
    emit('session/event', agent.session, { seq: 51, type: 'compaction/summary', data: { summary: 'summary' } })
    emit('session/event', agent.session, {
      seq: 52,
      type: 'user/message',
      data: { source: { kind: 'compact-checkpoint' }, content: [] },
      surfaceOp: { op: 'replace', startSeq: 5, endSeq: 20 },
    })
    const rebaselined = await listener({ agent, messages: [USER_MESSAGE], turn: 1, step: 3, signal }, next)
    assert.equal(rebaselined.messages.length, 2)
    assert.match(rebaselined.messages[1].content[0].text, /The following instructions come from a parent workspace/)
    assert.match(rebaselined.messages[1].content[0].text, /SHADOW PARENT V2/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
