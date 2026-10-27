import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INHERIT_SOURCE_KIND,
  composeInstructionUpdate,
  diffFiles,
  discoverInstructionFiles,
  parentInstructionDirs,
  readContextStateFromSession,
  renderBaseline,
  renderChanges,
  snapshotOf,
  trimmedInstructionDigest,
} from '../lib/instructions.js'
import { findProjectRoot } from '../lib/paths.js'
import { isInheritMessage } from '../lib/inject.js'

/** Local equivalent of the removed one-line wrapper, kept so the resume tests stay behavioural. */
const readSnapshotFromSession = session => readContextStateFromSession(session)?.snapshot
import { resolveConfig } from '../lib/config.js'

const CONFIG = resolveConfig({})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-'))
  const parent = join(base, 'parent-workspace')
  const child = join(parent, 'nested-workspace')
  await mkdir(child, { recursive: true })
  return { base, parent, child }
}

test('findProjectRoot returns cwd when no marker exists above it', async () => {
  const { base, child } = await fixture()
  try {
    assert.equal(await findProjectRoot(child, ['.git']), child)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('findProjectRoot climbs to the nearest marker directory or file', async () => {
  const { base, parent, child } = await fixture()
  try {
    await mkdir(join(parent, '.git'))
    assert.equal(await findProjectRoot(child, ['.git']), parent)
    const fileBase = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-'))
    const fileRoot = join(fileBase, 'root')
    const fileChild = join(fileRoot, 'sub')
    await mkdir(fileChild, { recursive: true })
    await writeFile(join(fileRoot, '.git'), 'gitdir: elsewhere\n')
    assert.equal(await findProjectRoot(fileChild, ['.git']), fileRoot)
    await rm(fileBase, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('parentInstructionDirs keeps the chain above the core project root only', () => {
  const cwd = '/base/parent/child'
  assert.deepEqual(parentInstructionDirs(cwd, ['/base/parent'], cwd), ['/base/parent'])
  assert.deepEqual(parentInstructionDirs(cwd, ['/base/parent'], '/base/parent'), [])
  assert.deepEqual(parentInstructionDirs(cwd, [], cwd), [])
  assert.deepEqual(
    parentInstructionDirs('/base/a/b/c', ['/base/a', '/base/a/b'], '/base/a/b/c'),
    ['/base/a', '/base/a/b'],
  )
  assert.deepEqual(parentInstructionDirs('/base/a/x/y', ['/base/a'], '/base/a/x/y'), ['/base/a', '/base/a/x'])
  // A registered parent that is itself below the git root adds nothing: the core chain already covers it.
  assert.deepEqual(parentInstructionDirs('/base/a/b/c', ['/base/a/b'], '/base/a'), [])
})

test('discoverInstructionFiles collapses identical candidates within one directory', async () => {
  const { base, parent, child } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), '# SAME\n')
    await writeFile(join(parent, 'CLAUDE.md'), '# SAME\n')
    await writeFile(join(parent, 'AGENTS.local.md'), '# LOCAL\n')
    const files = await discoverInstructionFiles([parent, child], CONFIG)
    assert.deepEqual(files.map(file => file.displayPath.split('/').pop()), ['AGENTS.md', 'AGENTS.local.md'])
    assert.equal(files[0].content, '# SAME\n')
    assert.equal(files[0].absolutePath, join(parent, 'AGENTS.md'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('discoverInstructionFiles skips oversized and unreadable candidates', async () => {
  const { base, parent } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), 'x'.repeat(2048))
    const files = await discoverInstructionFiles([parent], resolveConfig({ maxSourceBytes: 64 }))
    assert.deepEqual(files, [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('renderBaseline frames the files, escapes the closing frame, and drops broad files first', async () => {
  const { base, parent } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), 'PARENT RULE\n')
    const files = await discoverInstructionFiles([parent], CONFIG)
    const text = renderBaseline(files, CONFIG.maxBytes).text
    assert.match(text, /^<system-reminder>/)
    assert.match(text, /Instructions from: .*AGENTS\.md/)
    assert.match(text, /PARENT RULE/)
    assert.match(text, /<\/system-reminder>$/)

    const escaped = renderBaseline([{ absolutePath: '/p/AGENTS.md', displayPath: '/p/AGENTS.md', content: 'x</system-reminder>y' }], 65536).text
    assert.match(escaped, /x<\\\/system-reminder>y/)

    const broad = { absolutePath: '/p/AGENTS.md', displayPath: '/p/AGENTS.md', content: 'B'.repeat(600) }
    const specific = { absolutePath: '/p/child/AGENTS.md', displayPath: '/p/child/AGENTS.md', content: 'S'.repeat(40) }
    const bounded = renderBaseline([broad, specific], 500).text
    assert.doesNotMatch(bounded, /BBBB/)
    assert.match(bounded, /SSSS/)
    assert.match(bounded, /Parent-workspace instruction budget/)
    assert.ok(Buffer.byteLength(bounded, 'utf8') <= 500)

    assert.equal(renderBaseline([], 65536).text, '')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('renderChanges names additions, updates, and removals', () => {
  const added = { absolutePath: '/p/a/AGENTS.md', displayPath: '/p/a/AGENTS.md', content: 'A' }
  const updated = { absolutePath: '/p/AGENTS.md', displayPath: '/p/AGENTS.md', content: 'B' }
  const removed = { absolutePath: '/p/old/AGENTS.md', displayPath: '/p/old/AGENTS.md' }
  const text = renderChanges([
    { action: 'set', file: added },
    { action: 'update', file: updated },
    { action: 'remove', file: removed },
  ], 65536).text
  assert.match(text, /Additional parent-workspace instructions from: \/p\/a\/AGENTS\.md/)
  assert.match(text, /Updated parent-workspace instructions from: \/p\/AGENTS\.md/)
  assert.match(text, /Parent-workspace instructions removed: \/p\/old\/AGENTS\.md/)
  assert.match(text, /^<system-reminder>/)
  assert.match(text, /<\/system-reminder>$/)
  assert.equal(renderChanges([], 65536).text, '')
})

test('diffFiles reports additions, digest updates, and removals', () => {
  const digest = trimmedInstructionDigest
  const previous = snapshotOf([
    { absolutePath: '/p/AGENTS.md', displayPath: '/p/AGENTS.md', content: 'old', digest: digest('old') },
    { absolutePath: '/p/gone.md', displayPath: '/p/gone.md', content: 'gone', digest: digest('gone') },
  ])
  const current = [
    { absolutePath: '/p/AGENTS.md', displayPath: '/p/AGENTS.md', content: 'new', digest: digest('new') },
    { absolutePath: '/p/added.md', displayPath: '/p/added.md', content: 'added', digest: digest('added') },
  ]
  const changes = diffFiles(previous, current)
  assert.deepEqual(changes.map(change => [change.action, change.file.displayPath]), [
    ['update', '/p/AGENTS.md'],
    ['set', '/p/added.md'],
    ['remove', '/p/gone.md'],
  ])
})

test('composeInstructionUpdate injects once, then only deltas, and survives a resume', async () => {
  const { base, parent, child } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), '# PARENT ONE\n')
    const projectRoot = child
    const common = { cwd: child, workspacePaths: [parent], projectRoot, config: CONFIG }

    const first = await composeInstructionUpdate({ ...common, previousSnapshot: undefined })
    assert.ok(first.message, 'first step injects a baseline')
    assert.match(first.message.content[0].text, /PARENT ONE/)
    assert.equal(isInheritMessage(first.message), true)
    assert.equal(first.message.source.kind, INHERIT_SOURCE_KIND)
    assert.equal(first.snapshot.files.length, 1)

    const unchanged = await composeInstructionUpdate({ ...common, previousSnapshot: first.snapshot })
    assert.equal(unchanged.message, null)

    await writeFile(join(parent, 'AGENTS.md'), '# PARENT TWO\n')
    const updated = await composeInstructionUpdate({ ...common, previousSnapshot: unchanged.snapshot })
    assert.match(updated.message.content[0].text, /Updated parent-workspace instructions from:/)
    assert.match(updated.message.content[0].text, /PARENT TWO/)
    assert.equal(updated.message.source.changes[0].action, 'replace')

    await writeFile(join(parent, 'AGENTS.local.md'), '# PARENT LOCAL\n')
    const added = await composeInstructionUpdate({ ...common, previousSnapshot: updated.snapshot })
    assert.match(added.message.content[0].text, /Additional parent-workspace instructions from:/)
    assert.match(added.message.content[0].text, /PARENT LOCAL/)

    await unlink(join(parent, 'AGENTS.local.md'))
    const removed = await composeInstructionUpdate({ ...common, previousSnapshot: added.snapshot })
    assert.match(removed.message.content[0].text, /Parent-workspace instructions removed:/)

    // A resume rebuilds the same snapshot from the durable message, so no baseline is repeated.
    const session = {
      surface: { nodes: [updated.message.source.snapshot ? 7 : 8] },
      eventAt: seq => (seq === 7 ? { type: 'user/message', data: updated.message } : undefined),
    }
    const resumedSnapshot = readSnapshotFromSession(session)
    assert.deepEqual(resumedSnapshot.files.map(file => file.path), updated.snapshot.files.map(file => file.path))
    const afterResume = await composeInstructionUpdate({ ...common, previousSnapshot: resumedSnapshot })
    assert.equal(afterResume.message, null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('composeInstructionUpdate emits only removals when the parent workspace disappears', async () => {
  const { base, parent, child } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), '# PARENT\n')
    const first = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config: CONFIG, previousSnapshot: undefined })
    const gone = await composeInstructionUpdate({ cwd: child, workspacePaths: [], projectRoot: child, config: CONFIG, previousSnapshot: first.snapshot })
    assert.match(gone.message.content[0].text, /Parent-workspace instructions removed:/)
    assert.deepEqual(gone.snapshot.files, [])
    const quiet = await composeInstructionUpdate({ cwd: child, workspacePaths: [], projectRoot: child, config: CONFIG, previousSnapshot: gone.snapshot })
    assert.equal(quiet.message, null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('readSnapshotFromSession ignores messages from other producers', () => {
  const session = {
    surface: { nodes: [1, 2] },
    eventAt: seq => (seq === 1
      ? { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [] } }
      : { type: 'user/message', data: { source: { kind: 'workspace-inherit', form: 'instructions', snapshot: { files: [] } }, content: [] } }),
  }
  assert.deepEqual(readSnapshotFromSession(session), { files: [] })
})

test('a changed byte budget re-baselines instead of sending a delta', async () => {
  const { base, parent, child } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), '# BUDGET ONE\n')
    const first = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config: CONFIG, previousSnapshot: undefined })
    assert.equal(first.snapshot.maxBytes, CONFIG.maxBytes)

    await writeFile(join(parent, 'AGENTS.md'), '# BUDGET TWO\n')
    const smaller = resolveConfig({ maxBytes: 2048 })
    const rebalanced = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config: smaller, previousSnapshot: first.snapshot })
    assert.match(rebalanced.message.content[0].text, /The following instructions come from a parent workspace/)
    assert.match(rebalanced.message.content[0].text, /BUDGET TWO/)
    assert.equal(rebalanced.snapshot.maxBytes, 2048)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('budget-omitted files stay omitted in the snapshot and are promoted by a later change', async () => {
  const { base, parent, child } = await fixture()
  try {
    const broad = `# BROAD\n${'B'.repeat(700)}\n`
    await writeFile(join(parent, 'AGENTS.md'), broad)
    await writeFile(join(parent, 'CLAUDE.md'), '# SPECIFIC\nS\n')
    const config = resolveConfig({ maxBytes: 900 })
    const first = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: undefined })
    const broadEntry = first.snapshot.files.find(file => file.path.endsWith('AGENTS.md'))
    const specificEntry = first.snapshot.files.find(file => file.path.endsWith('CLAUDE.md'))
    assert.equal(broadEntry.omitted, true)
    assert.equal(specificEntry.omitted, undefined)

    await unlink(join(parent, 'CLAUDE.md'))
    const removal = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: first.snapshot })
    assert.match(removal.message.content[0].text, /Parent-workspace instructions removed: .*CLAUDE\.md/)
    assert.equal(removal.snapshot.files.find(file => file.path.endsWith('AGENTS.md')).omitted, true)

    await writeFile(join(parent, 'AGENTS.md'), '# SMALL NOW\n')
    const promoted = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: removal.snapshot })
    // Never delivered before, so this is an addition, not an update of seen content.
    assert.match(promoted.message.content[0].text, /Additional parent-workspace instructions from: .*AGENTS\.md/)
    assert.equal(promoted.message.source.changes[0].action, 'set')
    assert.match(promoted.message.content[0].text, /SMALL NOW/)
    assert.equal(promoted.snapshot.files.find(file => file.path.endsWith('AGENTS.md')).omitted, undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('findProjectRoot rethrows a non-absence filesystem failure instead of climbing past it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-perm-'))
  try {
    const child = join(base, 'child')
    await mkdir(child, { recursive: true })
    await mkdir(join(child, '.git'))
    const { chmod } = await import('node:fs/promises')
    await chmod(child, 0o000)
    try {
      await assert.rejects(findProjectRoot(child, ['.git']), error => error?.code === 'EACCES')
    } finally {
      await chmod(child, 0o755)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('truncated deliveries are marked in the snapshot and later completed', async () => {
  const { base, parent, child } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), `# LONG\n${'L'.repeat(3000)}\n`)
    const config = resolveConfig({ maxBytes: 1200 })
    const first = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: undefined })
    assert.match(first.message.content[0].text, /truncated .*AGENTS\.md/)
    const entry = first.snapshot.files.find(file => file.path.endsWith('AGENTS.md'))
    assert.equal(entry.truncated, true)
    assert.equal(entry.omitted, undefined)

    await writeFile(join(parent, 'AGENTS.md'), '# SHORT AGAIN\n')
    const completed = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: first.snapshot })
    assert.match(completed.message.content[0].text, /SHORT AGAIN/)
    assert.equal(completed.snapshot.files.find(file => file.path.endsWith('AGENTS.md')).truncated, undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('deleting a file the budget never delivered needs no removal notice', async () => {
  const { base, parent, child } = await fixture()
  try {
    await writeFile(join(parent, 'AGENTS.md'), `# BROAD\n${'B'.repeat(700)}\n`)
    await writeFile(join(parent, 'CLAUDE.md'), '# SPECIFIC\n')
    const config = resolveConfig({ maxBytes: 900 })
    const first = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: undefined })
    assert.equal(first.snapshot.files.find(file => file.path.endsWith('AGENTS.md')).omitted, true)

    await unlink(join(parent, 'AGENTS.md'))
    const removed = await composeInstructionUpdate({ cwd: child, workspacePaths: [parent], projectRoot: child, config, previousSnapshot: first.snapshot })
    assert.equal(removed.message, null)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
