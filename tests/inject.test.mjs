import test from 'node:test'
import assert from 'node:assert/strict'
import { INHERIT_SOURCE_KIND, enterDesired, isInheritMessage, syncInbox } from '../lib/inject.js'

function fakeMessage(id, text = id) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: INHERIT_SOURCE_KIND, form: 'instructions' } }
}

function fakeAgent(pending = []) {
  const calls = []
  const agent = {
    inbox: {
      nextStep: pending,
      prepend(target, message) {
        calls.push(['prepend', target, message])
        pending.unshift(message)
      },
      replace(id, message) {
        calls.push(['replace', id, message])
        const index = pending.findIndex(item => item.id === id)
        if (index < 0) return false
        pending[index] = message
        return true
      },
      remove(id) {
        calls.push(['remove', id])
        const index = pending.findIndex(item => item.id === id)
        if (index < 0) return false
        pending.splice(index, 1)
        return true
      },
    },
  }
  return { agent, calls, pending }
}

test('isInheritMessage recognizes only this producer', () => {
  assert.equal(isInheritMessage(fakeMessage('a')), true)
  assert.equal(isInheritMessage({ source: { kind: 'agent-instructions' } }), false)
  assert.equal(isInheritMessage(undefined), false)
})

test('enterDesired inserts the context right after the claimed batch', () => {
  const claimed = [fakeMessage('user')]
  const decision = { kind: 'enter', messages: [...claimed] }
  const { agent } = fakeAgent()
  const desired = fakeMessage('ctx')
  const next = enterDesired(agent, claimed, decision, desired, 1)
  assert.deepEqual(next.messages.map(message => message.id), ['user', 'ctx'])
})

test('enterDesired parks the context when the loop rejects the step', () => {
  const claimed = []
  const decision = { kind: 'reject' }
  const { agent, calls } = fakeAgent()
  const desired = fakeMessage('ctx')
  const next = enterDesired(agent, claimed, decision, desired, 1)
  assert.deepEqual(next, decision)
  assert.deepEqual(calls[0].slice(0, 2), ['prepend', 'next-step'])
})

test('enterDesired parks the context when the first step carries no messages', () => {
  const claimed = []
  const decision = { kind: 'enter', messages: [] }
  const { agent, calls } = fakeAgent()
  const desired = fakeMessage('ctx')
  assert.deepEqual(enterDesired(agent, claimed, decision, desired, 1), decision)
  assert.equal(calls[0][0], 'prepend')
})

test('enterDesired removes stale pending context once a step proceeds', () => {
  const claimed = [fakeMessage('user')]
  const stale = fakeMessage('stale')
  const { agent, calls } = fakeAgent([stale])
  const next = enterDesired(agent, claimed, { kind: 'enter', messages: [...claimed] }, fakeMessage('ctx'), 2)
  assert.deepEqual(calls.map(call => [call[0], call[1]]), [['remove', 'stale']])
  assert.deepEqual(next.messages.map(message => message.id), ['user', 'ctx'])
})

test('enterDesired leaves the decision untouched when the payload is already supplied', () => {
  const claimed = [fakeMessage('user')]
  const desired = fakeMessage('ctx')
  const { agent, calls } = fakeAgent([desired])
  const decision = { kind: 'enter', messages: [...claimed, desired] }
  assert.deepEqual(enterDesired(agent, claimed, decision, desired, 2), decision)
  assert.deepEqual(calls.map(call => [call[0], call[1]]), [['remove', 'ctx']])
})

test('syncInbox clears pending context when nothing is desired', () => {
  const pending = [fakeMessage('old-1'), fakeMessage('old-2')]
  const { agent, calls } = fakeAgent(pending)
  syncInbox(agent, [], undefined)
  assert.deepEqual(calls.map(call => [call[0], call[1]]), [['remove', 'old-1'], ['remove', 'old-2']])
  assert.deepEqual(pending, [])
})

test('syncInbox reuses an identical pending payload instead of queuing a duplicate', () => {
  const desired = fakeMessage('ctx')
  const pending = [fakeMessage('other'), desired]
  const { agent, pending: inbox, calls } = fakeAgent(pending)
  syncInbox(agent, [], desired)
  assert.deepEqual(calls.map(call => [call[0], call[1]]), [['remove', 'other']])
  assert.deepEqual(inbox, [desired])
})

test('syncInbox replaces a different pending payload in place', () => {
  const desired = fakeMessage('ctx', 'new')
  const pending = [fakeMessage('old', 'old')]
  const { agent, pending: inbox, calls } = fakeAgent(pending)
  syncInbox(agent, [], desired)
  assert.deepEqual(calls.map(call => [call[0], call[1]]), [['replace', 'old']])
  assert.deepEqual(inbox, [desired])
})
