/**
 * Path primitives shared by the instruction half and the skill half.
 *
 * Both halves ask the same three questions — "is B inside A", "which registered
 * workspaces strictly contain the cwd", "where does the core project root sit" —
 * and both then walk the directory chain between two known bounds. Keeping the
 * primitives here means `skills.js` no longer imports `instructions.js`.
 *
 * @module dsh-workspace-inherit/paths
 */

import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Whether `parent` is `child` itself or one of its ancestors.
 * @param parent - candidate ancestor directory.
 * @param child - descendant directory.
 * @returns whether the child path is inside the parent path.
 */
export function isWithin(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child))
  if (relativePath.length === 0) return true
  if (isAbsolute(relativePath)) return false
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
}

/**
 * Canonical filesystem spelling of a path, falling back to the input on failure.
 * @param path - absolute or relative path.
 * @returns the realpath when it resolves, else the resolved input.
 */
export async function canonicalPath(path) {
  const resolved = resolve(path)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

/**
 * Registered workspace directories that strictly contain the working directory.
 * @param cwd - session working directory (already canonical when available).
 * @param workspacePaths - every registered workspace path.
 * @returns unique strict ancestors in broad-to-specific order.
 */
export function registeredAncestors(cwd, workspacePaths) {
  const directory = resolve(cwd)
  const seen = new Set()
  const ancestors = []
  for (const workspacePath of workspacePaths ?? []) {
    if (typeof workspacePath !== 'string' || workspacePath.length === 0) continue
    const candidate = resolve(workspacePath)
    if (candidate === directory || !isWithin(candidate, directory) || seen.has(candidate)) continue
    seen.add(candidate)
    ancestors.push(candidate)
  }
  ancestors.sort((left, right) => left.length - right.length)
  return ancestors
}

/**
 * Walk from one directory up to an ancestor, inclusive, stopping on any escape.
 * @param from - directory to start at (included in the result).
 * @param stopInclusive - ancestor to stop at (included in the result).
 * @returns the directories from `from` up to `stopInclusive`, specific first.
 */
export function walkUpTo(from, stopInclusive) {
  const stop = resolve(stopInclusive)
  const dirs = []
  let current = resolve(from)
  for (;;) {
    if (!isWithin(stop, current)) break
    dirs.push(current)
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function isAbsent(error) {
  return error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/**
 * Resolve the core project root by climbing to the nearest marker directory.
 *
 * A missing marker means "keep climbing"; any other filesystem failure is
 * rethrown so a permission or I/O error cannot silently select a wrong root
 * (the core plugin follows the same rule).
 * @param cwd - session working directory.
 * @param markers - directory or file names that mark a project root.
 * @returns the nearest ancestor holding a marker, or the working directory itself.
 */
export async function findProjectRoot(cwd, markers) {
  const start = resolve(cwd)
  let current = start
  for (;;) {
    for (const marker of markers) {
      try {
        await stat(join(current, marker))
        return current
      } catch (error) {
        if (!isAbsent(error)) throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}
