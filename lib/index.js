/**
 * dsh-workspace-inherit: nested workspaces inherit their parent workspace's
 * AGENTS.md files and `.dsh` / `.agents` skills.
 *
 * The core harness resolves both kinds of workspace context from the session
 * working directory alone, stopping at the nearest `.git` project root. The Web
 * UI nevertheless nests workspaces that live inside other workspaces, so this
 * plugin contributes the missing parent layer:
 *
 * - instructions: one durable user message with the parent chain's AGENTS.md /
 *   CLAUDE.md files, refreshed on every pre-step (in-place additions, updates,
 *   and removal notices);
 * - skills: a second `ctx.skills` provider whose ranks sit between the current
 *   project and runtime/custom skills.
 *
 * Delivery state is reconstructed from the session log and advanced only when a
 * context message is actually committed, so aborted steps and compaction cannot
 * leave a stale "already delivered" snapshot behind.
 *
 * Both capabilities are optional: without `ctx.workspaceRegistry` (headless
 * compositions) nothing is injected and no provider roots are resolved.
 *
 * @module dsh-workspace-inherit
 */

import { resolveConfig } from './config.js'
import { INHERIT_SOURCE_KIND, enterDesired } from './inject.js'
import { canonicalPath, findProjectRoot } from './paths.js'
import { composeInstructionUpdate, readContextStateFromSession } from './instructions.js'
import { createParentSkillProvider } from './skills.js'

export const name = 'workspace-inherit'

function registerInstructionContext(ctx, config) {
  /** Snapshot of the newest context message the durable log confirmed, per session. */
  const committed = new WeakMap()
  /** Durable sequence of the newest context message this process observed. */
  const lastContextSeq = new WeakMap()

  // Compaction appends `compaction/summary` without a surfaceOp, then appends the
  // replacement as a `user/message` checkpoint carrying `surfaceOp.replace`.
  // Inspect the surfaceOp on every event type: when the replacement shadows our
  // context the model can no longer see it, so forget the snapshot and let the
  // next step re-inject the baseline. When a newer context message commits,
  // record its exact snapshot (this is also the only point delivery advances).
  ctx.on('session/event', (session, event) => {
    const surfaceOp = event?.surfaceOp
    if (surfaceOp !== null && typeof surfaceOp === 'object' && surfaceOp.op === 'replace') {
      const seq = lastContextSeq.get(session)
      const baselineSeq = committed.get(session)?.baselineSeq
      const covers = value => value !== undefined && surfaceOp.startSeq <= value && value <= surfaceOp.endSeq
      if (seq === undefined || covers(seq)) lastContextSeq.delete(session)
      // A replacement that shadows the baseline (even when a newer delta
      // survived) makes the model miss the broader instructions, so re-baseline.
      if (seq === undefined || covers(seq) || covers(baselineSeq)) committed.delete(session)
    }
    if (event?.type !== 'user/message') return
    const source = event.data?.source
    if (source?.kind !== INHERIT_SOURCE_KIND) return
    lastContextSeq.set(session, event.seq)
    if (source.snapshot === undefined) return
    const baseline = source.baseline === true || committed.get(session)?.baseline === true
    const baselineSeq = source.baseline === true ? event.seq : committed.get(session)?.baselineSeq
    committed.set(session, { snapshot: source.snapshot, baseline, baselineSeq })
  })

  const composeFor = async (agent, signal) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return undefined
    signal?.throwIfAborted?.()
    const cwd = await canonicalPath(await ctx.workingDirectory.ensure(agent, signal))
    const workspacePaths = registry.list()
      .map(workspace => workspace?.path)
      .filter(path => typeof path === 'string' && path.length > 0)
    const projectRoot = await findProjectRoot(cwd, config.projectRootMarkers)
    let state = committed.get(agent.session)
    if (state === undefined) {
      const recovered = readContextStateFromSession(agent.session)
      if (recovered !== undefined) {
        state = {
          snapshot: recovered.snapshot,
          baseline: recovered.baseline,
          baselineSeq: recovered.baselineSeq,
        }
        committed.set(agent.session, state)
        lastContextSeq.set(agent.session, recovered.seq)
      }
    }
    const composed = await composeInstructionUpdate({
      cwd,
      workspacePaths,
      projectRoot,
      previousSnapshot: state?.baseline === true ? state.snapshot : undefined,
      config,
      signal,
    })
    signal?.throwIfAborted?.()
    return composed.message
  }

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    let desired
    try {
      desired = await composeFor(agent, signal)
    } catch (error) {
      if (signal === undefined || !signal.aborted) {
        ctx.logger?.warn?.('workspace-inherit: parent instruction refresh failed: %o', error)
      }
      return decision
    }
    return enterDesired(agent, messages, decision, desired, step)
  })
}

function registerSkillProvider(ctx, config) {
  ctx.effect(() => ctx.skills.registerProvider(control => {
    const provider = createParentSkillProvider(ctx, config, control)
    control?.signal?.addEventListener?.('abort', () => provider.dispose(), { once: true })
    return provider
  }), 'workspace-inherit.skillProvider')
}

/**
 * Mount the plugin.
 * @param ctx - the plugin fiber's context.
 * @param config - raw row config; see `resolveConfig` for accepted fields.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  if (resolved.includeInstructions) {
    ctx.inject(['workingDirectory'], scoped => registerInstructionContext(scoped, resolved))
  }
  if (resolved.includeSkills) {
    ctx.inject(['skills'], scoped => registerSkillProvider(scoped, { ...resolved, providerName: name }))
  }
}
