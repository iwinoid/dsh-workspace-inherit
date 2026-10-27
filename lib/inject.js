/**
 * Inbox and pre-step bookkeeping for the injected parent-workspace context.
 *
 * The harness gives a plugin two ways to put durable context in front of the
 * model: fold a message into the entering pre-step batch, or park it in the
 * agent inbox for the next step boundary. This module owns that distinction so
 * the listener in `index.js` stays small and the rules are testable with a
 * plain fake agent.
 *
 * @module dsh-workspace-inherit/inject
 */

import { isDeepStrictEqual } from 'node:util'

/** Source kind carried by every message this plugin injects. */
export const INHERIT_SOURCE_KIND = 'workspace-inherit'

/**
 * Whether one model message was produced by this plugin.
 * @param message - candidate message from an inbox or session log.
 * @returns whether its source kind is this plugin's.
 */
export function isInheritMessage(message) {
  return message?.source?.kind === INHERIT_SOURCE_KIND
}

/**
 * Whether two messages carry the same model-facing payload.
 * @param left - one user message.
 * @param right - another user message.
 * @returns whether content and source are deep-equal.
 */
export function samePayload(left, right) {
  return isDeepStrictEqual(left?.content, right?.content) && isDeepStrictEqual(left?.source, right?.source)
}

function historySupplies(agent, desired) {
  const nodes = agent.session?.surface?.nodes
  if (!Array.isArray(nodes) || typeof agent.session?.eventAt !== 'function') return false
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = agent.session.eventAt(nodes[index])
    if (event?.type === 'user/message' && samePayload(event.data, desired)) return true
  }
  return false
}

/**
 * Reconcile the pending inbox copy with the context the next step should carry.
 * @param agent - agent whose inbox is being reconciled.
 * @param claimed - messages already claimed for the entering step.
 * @param desired - message the next step should carry, or undefined for none.
 */
export function syncInbox(agent, claimed, desired) {
  desired = desired ?? undefined
  const pending = agent.inbox.nextStep.filter(isInheritMessage)
  const alreadySupplied = desired !== undefined
    && (claimed.some(message => samePayload(message, desired)) || historySupplies(agent, desired))
  if (desired === undefined || alreadySupplied) {
    for (const message of pending) agent.inbox.remove(message.id)
    return
  }
  const reusable = pending.find(message => samePayload(message, desired))
  if (reusable !== undefined) {
    for (const message of pending) {
      if (message !== reusable) agent.inbox.remove(message.id)
    }
    return
  }
  const replaced = pending[0]
  if (replaced === undefined) agent.inbox.prepend('next-step', desired)
  else agent.inbox.replace(replaced.id, desired)
  for (const message of pending.slice(1)) agent.inbox.remove(message.id)
}

/**
 * Enter the desired context in the current step, or park it for the next one.
 *
 * A rejected step and a message-less first step own no request, so the context
 * waits in the inbox instead of creating a standalone turn. A proceeding step
 * consumes the pending copy and folds the fresh message right after the
 * claimed batch.
 * @param agent - agent whose step is entering.
 * @param claimed - messages claimed for this step.
 * @param decision - decision produced by earlier pre-step listeners.
 * @param desired - message this step should carry, or undefined for none.
 * @param step - one-based step number of the entering step.
 * @returns the decision to hand to the loop.
 */
export function enterDesired(agent, claimed, decision, desired, step) {
  desired = desired ?? undefined
  if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
    syncInbox(agent, claimed, desired)
    return decision
  }
  const pending = agent.inbox.nextStep.filter(isInheritMessage)
  for (const message of pending) agent.inbox.remove(message.id)
  if (desired === undefined || decision.messages.some(message => samePayload(message, desired))) {
    return decision
  }
  const lastClaimedIndex = decision.messages.findLastIndex(message => claimed.includes(message))
  const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
  return { ...decision, messages: entered }
}
