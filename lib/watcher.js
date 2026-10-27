/**
 * Small filesystem watcher for parent-workspace skill roots.
 *
 * The skill registry caches provider catalogs until a provider invalidates
 * them. This watcher owns that invalidation: it watches every root that has
 * appeared, polls roots that do not exist yet (a workspace may gain
 * `.dsh/skills` later), and coalesces bursts into one callback.
 *
 * Only directory-level events matter: a root changing means a bundle or a flat
 * `.md` appeared, was renamed, or disappeared. Bundle directories are watched
 * for their `SKILL.md` so editing frontmatter also refreshes the catalog.
 *
 * @module dsh-workspace-inherit/watcher
 */

import { watch } from 'node:fs'
import { stat } from 'node:fs/promises'

/** Upper bound on tracked roots/bundle directories per provider instance. */
const MAX_TRACKED = 512

/** Watches skill roots and reports coalesced changes. */
export class SkillRootWatcher {
  /** @type {Map<string, import('node:fs').FSWatcher>} */
  #watchers = new Map()
  /** @type {Set<string>} */
  #missing = new Set()
  /** @type {Set<string>} */
  #tracked = new Set()
  /** @type {NodeJS.Timeout | undefined} */
  #poll
  /** @type {NodeJS.Timeout | undefined} */
  #debounce
  #disposed = false

  /**
   * @param {object} options - callbacks and timings.
   * @param {() => void} options.onChange - called after a coalesced change burst.
   * @param {{ warn: (...args: unknown[]) => void }} [options.logger] - diagnostics sink.
   * @param {number} [options.pollIntervalMs] - how often absent roots are probed.
   * @param {number} [options.debounceMs] - burst coalescing window.
   */
  constructor({ onChange, logger, pollIntervalMs = 3000, debounceMs = 100 }) {
    this.onChange = onChange
    this.logger = logger
    this.pollIntervalMs = pollIntervalMs
    this.debounceMs = debounceMs
  }

  /**
   * Track root directories; absent ones are probed until they appear.
   * @param {readonly string[]} paths - absolute skill root directories.
   */
  track(paths) {
    if (this.#disposed) return
    let added = false
    for (const path of paths ?? []) {
      if (typeof path !== 'string' || path.length === 0 || this.#tracked.has(path)) continue
      if (this.#tracked.size >= MAX_TRACKED) {
        this.logger?.warn?.(`workspace-inherit: skill watcher tracked-path cap (${MAX_TRACKED}) reached; further roots are not watched`)
        break
      }
      this.#tracked.add(path)
      added = true
      this.#attach(path)
    }
    if (added) this.#ensurePolling()
  }

  #attach(path) {
    if (this.#disposed || this.#watchers.has(path)) return
    try {
      const watcher = watch(path, { persistent: false }, () => this.#schedule())
      watcher.on('error', () => {
        this.#detach(path)
        this.#missing.add(path)
        this.#ensurePolling()
      })
      this.#watchers.set(path, watcher)
      this.#missing.delete(path)
    } catch {
      this.#missing.add(path)
    }
  }

  #detach(path) {
    const watcher = this.#watchers.get(path)
    if (watcher === undefined) return
    this.#watchers.delete(path)
    try {
      watcher.close()
    } catch {
      // Already closed.
    }
  }

  #ensurePolling() {
    if (this.#disposed || this.#poll !== undefined || this.#missing.size === 0) return
    this.#poll = setInterval(() => {
      void this.#probeMissing()
    }, this.pollIntervalMs)
    this.#poll.unref?.()
  }

  async #probeMissing() {
    if (this.#disposed) return
    for (const path of [...this.#missing]) {
      try {
        const info = await stat(path)
        if (!info.isDirectory()) continue
        this.#missing.delete(path)
        this.#attach(path)
        this.#schedule()
      } catch {
        // Still absent.
      }
    }
    if (this.#missing.size === 0 && this.#poll !== undefined) {
      clearInterval(this.#poll)
      this.#poll = undefined
    }
  }

  #schedule() {
    if (this.#disposed) return
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined
      if (!this.#disposed) this.onChange()
    }, this.debounceMs)
    this.#debounce.unref?.()
  }

  /** Stop watching and release every handle. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#poll !== undefined) clearInterval(this.#poll)
    if (this.#debounce !== undefined) clearTimeout(this.#debounce)
    this.#poll = undefined
    this.#debounce = undefined
    for (const path of [...this.#watchers.keys()]) this.#detach(path)
    this.#missing.clear()
    this.#tracked.clear()
  }
}
