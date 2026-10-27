/**
 * Parent-workspace instruction discovery, rendering, and refresh state.
 *
 * The core `dsh-agent-instructions` plugin owns the chain from the nearest
 * project-root marker (`.git`) down to the session working directory. A nested
 * workspace at or below that root is therefore already covered, but a parent
 * workspace *above* the project root is invisible to the core chain. This module
 * computes exactly the missing directories, renders their instruction files in a
 * broad-to-specific order, and diffs the result against the last injected
 * snapshot so later steps only receive additions, updates, and removals.
 *
 * A snapshot records every discovered file with an `omitted` flag: files the byte
 * budget dropped are not claimed as delivered, so a later change can promote
 * them instead of losing them silently.
 *
 * @module dsh-workspace-inherit/instructions
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { INHERIT_SOURCE_KIND } from './inject.js'
import { renderBaseline, renderChanges } from './render.js'

export { renderBaseline, renderChanges } from './render.js'
import { isWithin, registeredAncestors, walkUpTo } from './paths.js'

export { INHERIT_SOURCE_KIND } from './inject.js'


/**
 * Directories whose instruction files the core chain cannot see.
 *
 * They are the part of the registered-parent chain that sits above the core
 * project root. A parent at or below that root is already loaded by the core
 * chain, so it is skipped rather than duplicated.
 * @param cwd - session working directory.
 * @param workspacePaths - every registered workspace path.
 * @param projectRoot - the core project root (nearest marker ancestor, else cwd).
 * @returns instruction directories in broad-to-specific order.
 */
export function parentInstructionDirs(cwd, workspacePaths, projectRoot) {
  const ancestors = registeredAncestors(cwd, workspacePaths)
  const outermost = ancestors[0]
  if (outermost === undefined) return []
  const stop = resolve(projectRoot)
  if (!isWithin(outermost, stop)) return []
  if (outermost === stop) return []
  return walkUpTo(dirname(stop), outermost).reverse()
}

/** Digest that ignores surrounding whitespace, matching the core duplicate rule. */
export function trimmedInstructionDigest(content) {
  return createHash('sha1').update(content.trim()).digest('hex')
}

async function statCandidate(absolutePath) {
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) return undefined
    return { size: info.size }
  } catch {
    return undefined
  }
}

/**
 * Discover instruction files in the supplied directories.
 *
 * Within one directory the candidates render broad-to-specific in the
 * configured order (base files first, then local overlays), and files whose
 * trimmed content is identical collapse to the earliest one, matching the core
 * per-directory duplicate rule.
 * @param dirs - directories in broad-to-specific order.
 * @param config - resolved plugin configuration.
 * @returns loaded files with content and freshness metadata.
 */
export async function discoverInstructionFiles(dirs, config, signal) {
  const files = []
  for (const dir of dirs) {
    signal?.throwIfAborted?.()
    const seen = new Set()
    for (const group of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const name of group) {
        signal?.throwIfAborted?.()
        const absolutePath = join(dir, name)
        const info = await statCandidate(absolutePath)
        if (info === undefined || info.size > config.maxSourceBytes) continue
        let content
        try {
          content = await readFile(absolutePath, 'utf8')
        } catch {
          continue
        }
        const digest = trimmedInstructionDigest(content)
        if (seen.has(digest)) continue
        seen.add(digest)
        files.push({
          absolutePath,
          displayPath: absolutePath,
          content,
          digest,
          size: info.size,
        })
      }
    }
  }
  return files
}

/**
 * Strip loaded files down to the durable snapshot stored on each injected message.
 * @param files - loaded instruction files.
 * @param maxBytes - rendering budget that produced this snapshot.
 * @param includedPaths - files the rendered text actually represents; others are marked omitted.
 * @returns the serializable snapshot.
 */
export function snapshotOf(files, maxBytes, includedPaths, truncatedPaths) {
  const included = includedPaths ?? new Set(files.map(file => file.absolutePath))
  const truncated = truncatedPaths ?? new Set()
  return {
    maxBytes,
    files: files.map(file => ({
      path: file.absolutePath,
      displayPath: file.displayPath,
      digest: file.digest,
      ...included.has(file.absolutePath)
        ? truncated.has(file.absolutePath) ? { truncated: true } : {}
        : { omitted: true },
    })),
  }
}

/**
 * Compute additions, updates, and removals between two instruction states.
 * An unchanged file stays quiet whether or not it was delivered; files the
 * budget omitted are promoted only by {@link composeInstructionUpdate}.
 * @param previousSnapshot - snapshot stored on the last delivered message.
 * @param files - currently discovered files.
 * @returns change records in refresh order.
 */
export function diffFiles(previousSnapshot, files) {
  const previous = new Map((previousSnapshot?.files ?? []).map(file => [file.path, file]))
  const current = new Set(files.map(file => file.absolutePath))
  const changes = []
  for (const file of files) {
    const before = previous.get(file.absolutePath)
    if (before === undefined) changes.push({ action: 'set', file })
    else if (before.digest !== file.digest) {
      changes.push({ action: before.omitted === true ? 'set' : 'update', file })
    }
  }
  for (const file of previousSnapshot?.files ?? []) {
    if (current.has(file.path)) continue
    // A file the budget never delivered needs no removal notice.
    if (file.omitted === true) continue
    changes.push({ action: 'remove', file: { ...file, absolutePath: file.path, displayPath: file.displayPath } })
  }
  return changes
}

/**
 * Recover the newest injected state from the durable session log.
 * @param session - live session with a model-visible surface.
 * @returns the newest snapshot, its session sequence, and whether a baseline frame was ever delivered.
 */
export function readContextStateFromSession(session) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || typeof session?.eventAt !== 'function') return undefined
  let snapshot
  let seq
  let baseline = false
  let baselineSeq
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== INHERIT_SOURCE_KIND) continue
    if (snapshot === undefined && source.snapshot !== undefined) {
      snapshot = source.snapshot
      seq = nodes[index]
    }
    if (source.baseline === true) {
      baseline = true
      if (baselineSeq === undefined) baselineSeq = nodes[index]
    }
  }
  if (snapshot === undefined) return undefined
  return { snapshot, seq, baseline, baselineSeq }
}

/**
 * Build one injectable context message.
 * @param text - rendered model-facing text.
 * @param snapshot - complete instruction state after this message.
 * @param changes - change records this message represents.
 * @param baseline - whether this message carries the first baseline frame.
 * @returns a user-role message tagged with this plugin's source kind.
 */
export function instructionMessage(text, snapshot, changes, baseline = false) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: INHERIT_SOURCE_KIND,
      form: 'instructions',
      ...baseline ? { baseline: true } : {},
      snapshot,
      changes,
    },
  }
}

/**
 * Compose the message the next step should carry, or nothing when unchanged.
 * @param input - working directory, registered workspace paths, core project root, prior snapshot, and config.
 * @returns the message to inject (if any) and the state to record once it is durable.
 */
export async function composeInstructionUpdate(input) {
  const { cwd, workspacePaths, projectRoot, previousSnapshot, config, signal } = input
  const dirs = parentInstructionDirs(cwd, workspacePaths, projectRoot)
  const files = await discoverInstructionFiles(dirs, config, signal)
  const identityChanged = previousSnapshot === undefined
    || previousSnapshot === null
    || previousSnapshot.maxBytes !== config.maxBytes

  if (identityChanged) {
    const rendered = renderBaseline(files, config.maxBytes)
    const snapshot = snapshotOf(files, config.maxBytes, new Set(rendered.included), new Set(rendered.truncated))
    if (rendered.text.length === 0) return { message: null, snapshot }
    const changes = rendered.included.map(path => ({ action: 'set', path: files.find(file => file.absolutePath === path)?.displayPath ?? path }))
    return { message: instructionMessage(rendered.text, snapshot, changes, true), snapshot }
  }

  const previousByPath = new Map(previousSnapshot.files.map(file => [file.path, file]))
  const included = new Set()
  const truncated = new Set()
  for (const file of files) {
    const before = previousByPath.get(file.absolutePath)
    if (before === undefined || before.omitted === true || before.digest !== file.digest) continue
    included.add(file.absolutePath)
    if (before.truncated === true) truncated.add(file.absolutePath)
  }
  const changes = diffFiles(previousSnapshot, files)
  const contentChanges = changes.filter(change => change.action !== 'remove')
  const removals = changes.filter(change => change.action === 'remove')
  const candidates = changes.length > 0
    ? [
        ...contentChanges.map(change => ({ action: change.action, file: change.file })),
        ...files
          .filter(file => {
            const before = previousByPath.get(file.absolutePath)
            return before !== undefined && before.digest === file.digest && (before.omitted === true || before.truncated === true)
          })
          .map(file => {
            const before = previousByPath.get(file.absolutePath)
            return { action: before?.truncated === true ? 'update' : 'set', file }
          }),
        ...removals.map(change => ({ action: change.action, file: change.file })),
      ]
    : []
  if (candidates.length === 0) return { message: null, snapshot: snapshotOf(files, config.maxBytes, included, truncated) }
  const rendered = renderChanges(candidates, config.maxBytes)
  for (const path of rendered.included) {
    included.add(path)
    truncated.delete(path)
  }
  for (const path of rendered.truncated) {
    included.add(path)
    truncated.add(path)
  }
  const snapshot = snapshotOf(files, config.maxBytes, included, truncated)
  if (rendered.text.length === 0) return { message: null, snapshot }
  const recorded = candidates
    .filter(candidate => rendered.included.includes(candidate.file.absolutePath))
    .map(candidate => ({
      action: candidate.action === 'update' ? 'replace' : candidate.action,
      path: candidate.file.displayPath,
    }))
  return { message: instructionMessage(rendered.text, snapshot, recorded), snapshot }
}
