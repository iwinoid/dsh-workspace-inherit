/**
 * Parent-workspace skills for nested workspaces.
 *
 * `dsh-skill-filesystem` scans only the directories of the nearest project root
 * (nearest `.git`, else the working directory), so a parent workspace's
 * `.dsh/skills` and `.agents/skills` never reach a nested workspace. This module
 * contributes a second provider at ranks between the current project
 * (`100`/`200`) and runtime/custom (`250`/`300`): nearer parent workspaces win
 * over farther ones, and the current workspace's own skills always win.
 *
 * The frontmatter reader covers the documented skill keys only (name,
 * description, whenToUse, invocation flags, metadata is ignored). It handles
 * block scalars and inline comments; it is deliberately not a general YAML
 * implementation, and files it cannot read are skipped with a warning.
 *
 * @module dsh-workspace-inherit/skills
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { findProjectRoot, registeredAncestors, walkUpTo } from './paths.js'
import { SkillRootWatcher } from './watcher.js'
import { parseSkillText } from './frontmatter.js'

export { parseSkillText } from './frontmatter.js'

/** Rank of the nearest parent workspace's `.dsh/skills` root. */
export const PARENT_DSH_RANK_BASE = 210
/** Rank of the nearest parent workspace's `.agents/skills` root. */
export const PARENT_AGENTS_RANK_BASE = 211
/** Rank step per ancestor level; two slots per level keep `.dsh` ahead of `.agents`. */
export const PARENT_RANK_STEP = 2
/** Highest rank this provider may use; stays below runtime (250) and custom (300). */
export const PARENT_RANK_CAP = 248

/**
 * Rank for one ancestor distance; farther parents lose to nearer ones.
 * The cap is reached at distance 20; deeper nesting shares ranks, which the
 * registry resolves by provider/local order.
 * @param {number} distance - path segments from the working directory to the parent.
 * @param {number} base - base rank of the scanned root kind.
 * @returns the rank, capped below runtime skills.
 */
export function parentSkillRank(distance, base) {
  return Math.min(base + PARENT_RANK_STEP * Math.max(0, distance - 1), PARENT_RANK_CAP)
}

/**
 * Ancestor workspace directories whose skills a nested workspace should see.
 *
 * Every strict ancestor workspace is included, except one equal to the core
 * project root: `dsh-skill-filesystem` already scans that directory, and
 * duplicating it would double the catalog.
 * @param cwd - session working directory (canonical when available).
 * @param workspacePaths - every registered workspace path.
 * @param projectRoot - the core project root.
 * @returns `{ dir, distance }` entries in broad-to-specific order.
 */
export function parentSkillDirs(cwd, workspacePaths, projectRoot) {
  const ancestors = registeredAncestors(cwd, workspacePaths)
  const outermost = ancestors[0]
  if (outermost === undefined) return []
  const stop = resolve(projectRoot)
  return walkUpTo(cwd, outermost).slice(1)
    .filter(directory => directory !== stop)
    .reverse()
    .map(directory => ({
      dir: directory,
      distance: relative(directory, resolve(cwd)).split(sep).length,
    }))
}

/**
 * Translate ancestor directories into scannable skill roots.
 * @param dirs - `{ dir, distance }` entries in broad-to-specific order.
 * @param providerName - provider name recorded on every candidate.
 * @returns skill root descriptors in scan order.
 */
export function skillRoots(dirs, providerName) {
  return dirs.flatMap(({ dir, distance }) => [
    {
      path: join(dir, '.dsh', 'skills'),
      source: 'project-parent-dsh',
      rank: parentSkillRank(distance, PARENT_DSH_RANK_BASE),
      provider: providerName,
    },
    {
      path: join(dir, '.agents', 'skills'),
      source: 'project-parent-agents',
      rank: parentSkillRank(distance, PARENT_AGENTS_RANK_BASE),
      provider: providerName,
    },
  ])
}

async function entryKind(path) {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
  } catch {
    // Missing or unreadable entries are skipped.
  }
  return undefined
}

async function readSkillCandidate(path, locator, root, warn) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseSkillText(text)
  if (parsed === undefined) {
    warn?.(`workspace-inherit: skill file ${path} ignored: unsupported frontmatter or invalid name/description`)
    return undefined
  }
  return {
    name: parsed.name,
    description: parsed.description,
    ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
    invocation: parsed.invocation,
    provider: root.provider,
    source: root.source,
    rank: root.rank,
    locator,
    resourceBase: { kind: 'directory', path: locator.directory },
    path,
  }
}

/**
 * Discover skills under the supplied roots.
 *
 * A root holds either directory bundles (`<name>/SKILL.md`) or flat files
 * (`<name>.md`); nested scan is one level deep, matching the filesystem
 * provider's contract. Symlinked entries are followed, and every directory
 * bundle is reported through `onDirectory` even when it has no valid
 * `SKILL.md` yet, so the watcher can observe a later `SKILL.md` creation.
 * @param roots - root descriptors from {@link skillRoots}.
 * @param options - optional callbacks for watching and diagnostics.
 * @returns discovered candidates in scan order.
 */
export async function discoverSkills(roots, options = {}) {
  const candidates = []
  for (const root of roots) {
    options.signal?.throwIfAborted?.()
    let entries
    try {
      entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      options.signal?.throwIfAborted?.()
      const fullPath = join(root.path, entry.name)
      const kind = await entryKind(fullPath)
      let locator
      if (kind === 'directory') {
        locator = { path: join(fullPath, 'SKILL.md'), directory: fullPath }
        options.onDirectory?.(fullPath)
      } else if (kind === 'file' && entry.name.endsWith('.md')) {
        locator = { path: fullPath, directory: root.path }
      } else {
        continue
      }
      const candidate = await readSkillCandidate(locator.path, locator, root, options.warn)
      if (candidate !== undefined) candidates.push(candidate)
    }
  }
  return candidates
}

function envOrFallback(name, fallback) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * User-global skill roots already scanned by `dsh-skill-filesystem`.
 *
 * A parent workspace can be the home directory itself (the registry may hold
 * one), and its `.dsh/skills` / `.agents/skills` are then the user-global
 * roots. Scanning them again would only raise their rank. Blank environment
 * values are treated as unset, matching the harness home resolution.
 * @returns resolved global root paths.
 */
function userGlobalSkillRoots() {
  const dshHome = envOrFallback('DSH_HOME', join(homedir(), '.dsh'))
  const agentsHome = envOrFallback('DSH_AGENTS_HOME', join(homedir(), '.agents'))
  return new Set([
    resolve(join(dshHome, 'skills')),
    resolve(join(agentsHome, 'skills')),
  ])
}

/**
 * Create the skill provider registered on `ctx.skills`.
 *
 * The provider resolves the parent chain from the live workspace registry on
 * every catalog read, so opening a new nested workspace or registering another
 * parent needs no restart. Roots are watched through {@link SkillRootWatcher};
 * created roots and new bundles invalidate the catalog.
 * @param ctx - plugin context with optional `workspaceRegistry`.
 * @param config - resolved plugin configuration.
 * @param control - registration control owned by the skill registry.
 * @returns the provider plus a dispose hook.
 */
export function createParentSkillProvider(ctx, config, control) {
  const providerName = config.providerName ?? 'workspace-inherit'
  const watcher = new SkillRootWatcher({
    onChange: () => control?.invalidate?.(),
    logger: ctx?.logger,
  })
  const warn = message => ctx?.logger?.warn?.(message)
  const workspacePaths = () => {
    try {
      const registry = ctx?.get?.('workspaceRegistry')
      const workspaces = registry?.list?.() ?? []
      return workspaces.map(workspace => workspace?.path).filter(path => typeof path === 'string')
    } catch (error) {
      ctx?.logger?.warn?.('workspace-inherit: workspace registry unavailable: %o', error)
      return []
    }
  }

  const rootsFor = async (cwd) => {
    const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers)
    const globals = userGlobalSkillRoots()
    return skillRoots(parentSkillDirs(cwd, workspacePaths(), projectRoot), providerName)
      .filter(root => !globals.has(resolve(root.path)))
  }

  const provider = {
    name: providerName,
    /**
     * List parent-workspace skills for one working directory.
     * @param {{ cwd?: string, signal?: AbortSignal }} options - lookup options.
     * @returns candidate skills, or none when no parent workspace applies.
     */
    async list(options) {
      const cwd = options?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return []
      if (options?.signal?.aborted === true) return []
      try {
        const roots = await rootsFor(cwd)
        if (options?.signal?.aborted === true) return []
        watcher.track(roots.map(root => root.path))
        return await discoverSkills(roots, {
          onDirectory: directory => watcher.track([directory]),
          warn,
          signal: options?.signal,
        })
      } catch (error) {
        ctx?.logger?.warn?.('workspace-inherit: parent skill discovery failed: %o', error)
        return []
      }
    },
    /**
     * Load one candidate's body.
     * @param {object} candidate - candidate previously returned by `list`.
     * @returns the loaded definition, or undefined when the file disappeared.
     */
    async get(candidate) {
      const locator = candidate?.locator
      if (locator === undefined || typeof locator.path !== 'string') return undefined
      let text
      try {
        text = await readFile(locator.path, 'utf8')
      } catch {
        return undefined
      }
      const parsed = parseSkillText(text)
      // The loaded definition must still describe the candidate the registry
      // selected; a rewritten name is a different skill.
      if (parsed === undefined || parsed.name !== candidate.name) return undefined
      return {
        name: candidate.name,
        description: candidate.description,
        ...candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {},
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        ...candidate.path !== undefined ? { path: candidate.path } : {},
        resourceBase: candidate.resourceBase,
        content: parsed.body,
      }
    },
    /** Release filesystem watchers. */
    dispose() {
      watcher.dispose()
    },
  }
  return provider
}
