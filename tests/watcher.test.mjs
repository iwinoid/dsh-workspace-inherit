import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillRootWatcher } from '../lib/watcher.js'

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

test('SkillRootWatcher reports a new skill file in a tracked root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-watch-'))
  try {
    const root = join(base, 'skills')
    await mkdir(root, { recursive: true })
    let changes = 0
    const watcher = new SkillRootWatcher({
      onChange: () => { changes += 1 },
      logger: { warn() {} },
      pollIntervalMs: 50,
      debounceMs: 10,
    })
    watcher.track([root])
    await mkdir(join(root, 'alpha'))
    await writeFile(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\n')
    assert.equal(await waitFor(() => changes > 0), true)
    watcher.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('SkillRootWatcher picks up a root created after it was tracked', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-watch-'))
  try {
    const root = join(base, 'late', 'skills')
    let changes = 0
    const watcher = new SkillRootWatcher({
      onChange: () => { changes += 1 },
      logger: { warn() {} },
      pollIntervalMs: 30,
      debounceMs: 10,
    })
    watcher.track([root])
    await mkdir(root, { recursive: true })
    assert.equal(await waitFor(() => changes > 0), true)
    watcher.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('SkillRootWatcher stops notifying after dispose', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-watch-'))
  try {
    const root = join(base, 'skills')
    await mkdir(root, { recursive: true })
    let changes = 0
    const watcher = new SkillRootWatcher({
      onChange: () => { changes += 1 },
      logger: { warn() {} },
      pollIntervalMs: 30,
      debounceMs: 10,
    })
    watcher.track([root])
    watcher.dispose()
    await writeFile(join(root, 'late.md'), '# late\n')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(changes, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
