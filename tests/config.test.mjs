import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'

test('resolveConfig fills every documented default', () => {
  assert.deepEqual(resolveConfig({}), {
    enabled: true,
    includeInstructions: true,
    includeSkills: true,
    maxBytes: 65536,
    maxSourceBytes: 1048576,
    instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
    localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
    projectRootMarkers: ['.git'],
  })
})

test('resolveConfig accepts explicit overrides', () => {
  const config = resolveConfig({
    enabled: false,
    includeSkills: false,
    maxBytes: 2048,
    maxSourceBytes: 4096,
    instructionFileCandidates: ['AGENTS.md'],
    localInstructionFileCandidates: [],
    projectRootMarkers: ['.git', '.hg'],
  })
  assert.equal(config.enabled, false)
  assert.equal(config.includeSkills, false)
  assert.equal(config.maxBytes, 2048)
  assert.equal(config.maxSourceBytes, 4096)
  assert.deepEqual(config.instructionFileCandidates, ['AGENTS.md'])
  assert.deepEqual(config.localInstructionFileCandidates, [])
  assert.deepEqual(config.projectRootMarkers, ['.git', '.hg'])
})

test('resolveConfig rejects a non-positive budget', () => {
  assert.throws(() => resolveConfig({ maxBytes: 0 }), TypeError)
  assert.throws(() => resolveConfig({ maxBytes: Number.NaN }), TypeError)
  assert.throws(() => resolveConfig({ maxSourceBytes: -1 }), TypeError)
})

test('resolveConfig rejects a non-boolean toggle', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), TypeError)
  assert.throws(() => resolveConfig({ includeInstructions: 1 }), TypeError)
})

test('resolveConfig rejects malformed candidate lists', () => {
  assert.throws(() => resolveConfig({ instructionFileCandidates: 'AGENTS.md' }), TypeError)
  assert.throws(() => resolveConfig({ instructionFileCandidates: [''] }), TypeError)
  assert.throws(() => resolveConfig({ projectRootMarkers: [] }), TypeError)
})

test('resolveConfig rejects a non-object input', () => {
  assert.throws(() => resolveConfig(null), TypeError)
  assert.throws(() => resolveConfig([]), TypeError)
})
