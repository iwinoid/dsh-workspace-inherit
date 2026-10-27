import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PARENT_AGENTS_RANK_BASE,
  PARENT_DSH_RANK_BASE,
  PARENT_RANK_CAP,
  createParentSkillProvider,
  discoverSkills,
  parentSkillDirs,
  parentSkillRank,
  parseSkillText,
  skillRoots,
} from '../lib/skills.js'
import { resolveConfig } from '../lib/config.js'

const CONFIG = resolveConfig({})
const SKILL = (name, extra = '') => `---\nname: ${name}\ndescription: ${name} fixture\n${extra}---\n# ${name}\nbody\n`

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-skills-'))
  const parent = join(base, 'parent-workspace')
  const child = join(parent, 'nested-workspace')
  await mkdir(child, { recursive: true })
  return { base, parent, child }
}

test('parentSkillDirs orders ancestor workspace roots from broad to specific', () => {
  assert.deepEqual(parentSkillDirs('/base/parent/child', ['/base/parent'], '/base/parent/child'), [
    { dir: '/base/parent', distance: 1 },
  ])
  assert.deepEqual(parentSkillDirs('/base/parent/child', ['/base/parent'], '/base/parent'), [])
  assert.deepEqual(parentSkillDirs('/base/a/b/c', ['/base/a', '/base/a/b'], '/base/a/b/c'), [
    { dir: '/base/a', distance: 2 },
    { dir: '/base/a/b', distance: 1 },
  ])
  assert.deepEqual(parentSkillDirs('/base/parent/child', [], '/base/parent/child'), [])
})

test('parseSkillText reads the subset of frontmatter skills need', () => {
  const parsed = parseSkillText(SKILL('hello', 'whenToUse: when x\ndisable-model-invocation: true\nuser-invocable: false\n'))
  assert.equal(parsed.name, 'hello')
  assert.equal(parsed.description, 'hello fixture')
  assert.equal(parsed.whenToUse, 'when x')
  assert.deepEqual(parsed.invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(parsed.body, '# hello\nbody')

  const quoted = parseSkillText('---\nname: "quoted"\ndescription: \'quoted desc\'\n---\nbody\n')
  assert.equal(quoted.name, 'quoted')
  assert.equal(quoted.description, 'quoted desc')

  assert.equal(parseSkillText('no frontmatter\n'), undefined)
  assert.equal(parseSkillText('---\nname: Bad Name\ndescription: x\n---\n'), undefined)
  assert.equal(parseSkillText('---\nname: fine\n---\n'), undefined)
  assert.equal(parseSkillText('---\nname: fine\ndescription: x\n'), undefined)
})

test('discoverSkills finds directory bundles and flat files under parent roots', async () => {
  const { base, parent } = await fixture()
  try {
    await mkdir(join(parent, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(parent, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL('alpha'))
    await writeFile(join(parent, '.dsh', 'skills', 'flat.md'), SKILL('flat'))
    await mkdir(join(parent, '.agents', 'skills', 'gamma'), { recursive: true })
    await writeFile(join(parent, '.agents', 'skills', 'gamma', 'SKILL.md'), SKILL('gamma'))
    await mkdir(join(parent, '.dsh', 'skills', 'broken'), { recursive: true })
    await writeFile(join(parent, '.dsh', 'skills', 'broken', 'SKILL.md'), 'not a skill\n')

    const roots = skillRoots(parentSkillDirs(join(parent, 'nested'), [parent], join(parent, 'nested')), 'workspace-inherit')
    assert.deepEqual(roots.map(root => root.source), ['project-parent-dsh', 'project-parent-agents'])
    const candidates = await discoverSkills(roots)
    assert.deepEqual(candidates.map(candidate => candidate.name), ['alpha', 'flat', 'gamma'])
    const alpha = candidates.find(candidate => candidate.name === 'alpha')
    assert.equal(alpha.rank, PARENT_DSH_RANK_BASE)
    assert.equal(alpha.provider, 'workspace-inherit')
    assert.equal(alpha.resourceBase.kind, 'directory')
    assert.equal(alpha.resourceBase.path, join(parent, '.dsh', 'skills', 'alpha'))
    assert.equal(alpha.path, join(parent, '.dsh', 'skills', 'alpha', 'SKILL.md'))
    assert.equal(candidates.find(candidate => candidate.name === 'gamma').rank, PARENT_AGENTS_RANK_BASE)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('createParentSkillProvider lists parent skills for a nested cwd and loads their bodies', async () => {
  const { base, parent, child } = await fixture()
  try {
    await mkdir(join(parent, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(parent, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL('alpha'))
    await mkdir(join(child, '.dsh', 'skills', 'child-only'), { recursive: true })
    await writeFile(join(child, '.dsh', 'skills', 'child-only', 'SKILL.md'), SKILL('child-only'))

    const ctx = {
      get: name => (name === 'workspaceRegistry' ? { list: () => [{ path: parent }] } : undefined),
      logger: { warn() {} },
    }
    const provider = createParentSkillProvider(ctx, { ...CONFIG, providerName: 'workspace-inherit' })
    assert.equal(provider.name, 'workspace-inherit')

    const candidates = await provider.list({ cwd: child, signal: new AbortController().signal })
    assert.deepEqual(candidates.map(candidate => candidate.name), ['alpha'])
    assert.ok(candidates.every(candidate => candidate.rank >= PARENT_DSH_RANK_BASE))
    assert.ok(candidates.every(candidate => candidate.rank < 250))

    const loaded = await provider.get(candidates[0], { cwd: child })
    assert.equal(loaded.name, 'alpha')
    assert.match(loaded.content, /# alpha/)
    assert.equal(loaded.provider, 'workspace-inherit')
    provider.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('createParentSkillProvider returns nothing without a workspace registry', async () => {
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const provider = createParentSkillProvider(ctx, CONFIG)
  assert.deepEqual(await provider.list({ cwd: '/tmp' }), [])
  provider.dispose?.()
})

test('createParentSkillProvider does not rescan the user-global skill roots as a parent workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-home-'))
  const previousDshHome = process.env.DSH_HOME
  const previousAgentsHome = process.env.DSH_AGENTS_HOME
  try {
    process.env.DSH_HOME = join(base, '.dsh')
    process.env.DSH_AGENTS_HOME = join(base, '.agents')
    const child = join(base, 'parent', 'child')
    await mkdir(child, { recursive: true })
    await mkdir(join(base, '.agents', 'skills', 'global-agents'), { recursive: true })
    await writeFile(join(base, '.agents', 'skills', 'global-agents', 'SKILL.md'), SKILL('global-agents'))
    await mkdir(join(base, '.dsh', 'skills', 'global-dsh'), { recursive: true })
    await writeFile(join(base, '.dsh', 'skills', 'global-dsh', 'SKILL.md'), SKILL('global-dsh'))
    await mkdir(join(base, 'parent', '.dsh', 'skills', 'parent-skill'), { recursive: true })
    await writeFile(join(base, 'parent', '.dsh', 'skills', 'parent-skill', 'SKILL.md'), SKILL('parent-skill'))

    const ctx = { get: name => (name === 'workspaceRegistry' ? { list: () => [{ path: base }, { path: join(base, 'parent') }] } : undefined), logger: { warn() {} } }
    const provider = createParentSkillProvider(ctx, CONFIG)
    const candidates = await provider.list({ cwd: child })
    assert.deepEqual(candidates.map(candidate => candidate.name), ['parent-skill'])
    provider.dispose()
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(base, { recursive: true, force: true })
  }
})

test('parseSkillText reads folded and literal block scalars and strips inline comments', () => {
  const folded = parseSkillText('---\nname: folded\ndescription: >\n  first line\n  second line\n---\nbody\n')
  assert.equal(folded.description, 'first line second line')

  const literal = parseSkillText('---\nname: literal\ndescription: |\n  first line\n  second line\n---\nbody\n')
  assert.equal(literal.description, 'first line\nsecond line')

  const commented = parseSkillText('---\nname: commented\ndescription: plain text # trailing comment\nwhenToUse: use it # note\n---\nbody\n')
  assert.equal(commented.description, 'plain text')
  assert.equal(commented.whenToUse, 'use it')
})

test('parseSkillText accepts on/off booleans and rejects legacy invocation keys', () => {
  const onOff = parseSkillText('---\nname: on-off\ndescription: x\ndisable-model-invocation: on\nuser-invocable: off\n---\nbody\n')
  assert.deepEqual(onOff.invocation, { modelInvocable: false, userInvocable: false })

  assert.equal(parseSkillText('---\nname: legacy\ndescription: x\ndisableModelInvocation: true\n---\nbody\n'), undefined)
  assert.equal(parseSkillText('---\nname: legacy2\ndescription: x\nuserInvocable: false\n---\nbody\n'), undefined)
})

test('parentSkillRank keeps nearer ancestors ahead and caps below runtime', () => {
  assert.ok(parentSkillRank(1, PARENT_DSH_RANK_BASE) < parentSkillRank(2, PARENT_DSH_RANK_BASE))
  assert.ok(parentSkillRank(2, PARENT_DSH_RANK_BASE) < parentSkillRank(3, PARENT_DSH_RANK_BASE))
  assert.ok(parentSkillRank(10, PARENT_DSH_RANK_BASE) < parentSkillRank(19, PARENT_DSH_RANK_BASE))
  assert.equal(parentSkillRank(30, PARENT_DSH_RANK_BASE), PARENT_RANK_CAP)
  assert.equal(parentSkillRank(30, PARENT_AGENTS_RANK_BASE), PARENT_RANK_CAP)
})

test('discoverSkills reports bundle directories without a SKILL.md so a later file is watched', async () => {
  const { base, parent } = await fixture()
  try {
    await mkdir(join(parent, '.dsh', 'skills', 'empty-bundle'), { recursive: true })
    const roots = skillRoots(parentSkillDirs(join(parent, 'nested'), [parent], join(parent, 'nested')), 'workspace-inherit')
    const reported = []
    const candidates = await discoverSkills(roots, { onDirectory: directory => reported.push(directory) })
    assert.deepEqual(candidates, [])
    assert.deepEqual(reported, [join(parent, '.dsh', 'skills', 'empty-bundle')])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('discoverSkills follows symlinked skill bundles and flat files', async () => {
  const { base, parent } = await fixture()
  try {
    const real = join(base, 'real-skill')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'SKILL.md'), SKILL('linked-skill'))
    await mkdir(join(parent, '.dsh', 'skills'), { recursive: true })
    await symlink(real, join(parent, '.dsh', 'skills', 'linked'))
    const roots = skillRoots(parentSkillDirs(join(parent, 'nested'), [parent], join(parent, 'nested')), 'workspace-inherit')
    const candidates = await discoverSkills(roots)
    assert.deepEqual(candidates.map(candidate => candidate.name), ['linked-skill'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('blank DSH_HOME and DSH_AGENTS_HOME values count as unset for global-root filtering', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-inherit-blankenv-'))
  const previousDshHome = process.env.DSH_HOME
  const previousAgentsHome = process.env.DSH_AGENTS_HOME
  try {
    process.env.DSH_HOME = '   '
    process.env.DSH_AGENTS_HOME = ''
    const parent = join(base, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await mkdir(join(parent, '.dsh', 'skills', 'parent-skill'), { recursive: true })
    await writeFile(join(parent, '.dsh', 'skills', 'parent-skill', 'SKILL.md'), SKILL('parent-skill'))
    const ctx = { get: name => (name === 'workspaceRegistry' ? { list: () => [{ path: parent }] } : undefined), logger: { warn() {} } }
    const provider = createParentSkillProvider(ctx, CONFIG)
    const candidates = await provider.list({ cwd: child })
    assert.deepEqual(candidates.map(candidate => candidate.name), ['parent-skill'])
    provider.dispose()
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(base, { recursive: true, force: true })
  }
})

test('parseSkillText handles quoted values with trailing comments, chomping indicators, and escapes', () => {
  const quoted = parseSkillText('---\nname: "quoted-comment"\ndescription: "x" # note\n---\nbody\n')
  assert.equal(quoted.name, 'quoted-comment')
  assert.equal(quoted.description, 'x')

  const escaped = parseSkillText('---\nname: escaped\ndescription: "line\\nnext \\u00e9"\n---\nbody\n')
  assert.equal(escaped.description, 'line\nnext é')

  const chomped = parseSkillText('---\nname: chomped\ndescription: |+\n  keep me\n---\nbody\n')
  assert.equal(chomped.description, 'keep me')
})

test('parseSkillText rejects invalid booleans, indented fences, and duplicate keys like core', () => {
  assert.equal(parseSkillText('---\nname: bad-bool\ndescription: x\ndisable-model-invocation: maybe\n---\nbody\n'), undefined)
  assert.equal(parseSkillText(' ---\nname: indented\ndescription: x\n---\nbody\n'), undefined)
  assert.equal(parseSkillText('---\nname: duplicate\ndescription: x\ndescription: y\n---\nbody\n'), undefined)
})

test('createParentSkillProvider rejects a definition whose name no longer matches the candidate', async () => {
  const { base, parent, child } = await fixture()
  try {
    await mkdir(join(parent, '.dsh', 'skills', 'renamed'), { recursive: true })
    await writeFile(join(parent, '.dsh', 'skills', 'renamed', 'SKILL.md'), SKILL('renamed'))
    const ctx = { get: name => (name === 'workspaceRegistry' ? { list: () => [{ path: parent }] } : undefined), logger: { warn() {} } }
    const provider = createParentSkillProvider(ctx, CONFIG)
    const candidates = await provider.list({ cwd: child })
    assert.deepEqual(candidates.map(candidate => candidate.name), ['renamed'])
    await writeFile(join(parent, '.dsh', 'skills', 'renamed', 'SKILL.md'), SKILL('different'))
    assert.equal(await provider.get(candidates[0]), undefined)
    provider.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
