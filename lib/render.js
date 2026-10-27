/**
 * Rendering and byte-budget for the injected instruction frames.
 *
 * A message is always one framed <system-reminder> block. The budget drops
 * whole broad entries before truncating the most specific one, and the marker
 * text names what was dropped so a later refresh can promote it.
 *
 * @module dsh-workspace-inherit/render
 */

import { dirname } from 'node:path'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const BASELINE_INTRO = 'The following instructions come from a parent workspace: this workspace is nested inside another workspace, and those broader instructions apply here too. More specific instructions from the current workspace take precedence. They do not override system, developer, or direct user instructions.'
const UPDATE_INTRO = 'Parent-workspace instructions changed since they were last loaded. Use the following entries as the current state; entries marked removed no longer apply.'

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function escapeFrameBody(body) {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function budgetMarker(maxBytes, omitted, truncated) {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts = []
  if (omitted.length > 0) parts.push(`omitted ${omitted.join(', ')}`)
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map(item => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`)
  }
  return `Parent-workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function frame(sections, intro, markerText) {
  const body = [markerText, intro, ...sections].filter(block => block.length > 0).join('\n\n')
  return [SYSTEM_REMINDER_OPEN, escapeFrameBody(body), SYSTEM_REMINDER_CLOSE].join('\n')
}

/**
 * Render a framed batch within a byte budget, dropping whole broad entries
 * before truncating the most specific one.
 * @param entries - `{ pathKey, displayPath, content, render(content) }` in broad-to-specific order.
 * @param maxBytes - UTF-8 byte budget for the complete framed message.
 * @param intro - leading guidance for the batch, or an empty string.
 * @returns the framed text and the keys of entries the text actually represents.
 */
export function renderFramed(entries, maxBytes, intro) {
  if (entries.length === 0) return { text: '', included: [], truncated: [] }
  const full = frame(entries.map(entry => entry.render(entry.content)), intro, '')
  if (byteLength(full) <= maxBytes) {
    return { text: full, included: entries.map(entry => entry.pathKey), truncated: [] }
  }
  for (let start = 1; start < entries.length; start += 1) {
    const kept = entries.slice(start)
    const omitted = entries.slice(0, start).map(entry => entry.displayPath)
    const text = frame(kept.map(entry => entry.render(entry.content)), intro, budgetMarker(maxBytes, omitted, []))
    if (byteLength(text) <= maxBytes) {
      return { text, included: kept.map(entry => entry.pathKey), truncated: [] }
    }
  }
  const mostSpecific = entries.at(-1)
  const omitted = entries.slice(0, -1).map(entry => entry.displayPath)
  const originalBytes = byteLength(mostSpecific.content)
  let low = 0
  let high = originalBytes
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const content = truncateUtf8(mostSpecific.content, middle)
    const includedBytes = byteLength(content)
    const truncated = [{ displayPath: mostSpecific.displayPath, originalBytes, includedBytes }]
    const text = frame([mostSpecific.render(content)], intro, budgetMarker(maxBytes, omitted, truncated))
    if (byteLength(text) <= maxBytes) {
      best = text
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best.length > 0) return { text: best, included: [mostSpecific.pathKey], truncated: [mostSpecific.pathKey] }
  const notice = budgetMarker(maxBytes, omitted, [{ displayPath: mostSpecific.displayPath, originalBytes, includedBytes: 0 }])
  return { text: byteLength(notice) <= maxBytes ? notice : truncateUtf8(notice, maxBytes), included: [], truncated: [] }
}

function baselineSection(file) {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

/**
 * Render the first parent-workspace message.
 * @param files - discovered files in broad-to-specific order.
 * @param maxBytes - byte budget for the rendered message.
 * @returns the framed baseline text (empty when nothing to show) and the delivered paths.
 */
export function renderBaseline(files, maxBytes) {
  return renderFramed(files.map(file => ({
    pathKey: file.absolutePath,
    displayPath: file.displayPath,
    content: file.content,
    render: content => baselineSection({ ...file, content }),
  })), maxBytes, BASELINE_INTRO)
}

function changeSection(change, content) {
  const file = change.file
  if (change.action === 'remove') {
    return `Parent-workspace instructions removed: ${file.displayPath}\n\nThe previously loaded instructions from this file no longer apply.`
  }
  if (change.action === 'update') {
    return `Updated parent-workspace instructions from: ${file.displayPath}\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n${content}`
  }
  const directory = dirname(file.displayPath)
  return `Additional parent-workspace instructions from: ${file.displayPath}\n\nThese instructions apply to work under \`${directory}\`. More specific instructions take precedence. They do not override system, developer, or direct user instructions.\n\n${content}`
}

/**
 * Render one refresh batch of additions, updates, and removals.
 * @param changes - change records in refresh order.
 * @param maxBytes - byte budget for the rendered message.
 * @returns the framed text (empty when nothing fits) and the delivered paths.
 */
export function renderChanges(changes, maxBytes) {
  return renderFramed(changes.map(change => ({
    pathKey: change.file.absolutePath,
    displayPath: change.file.displayPath,
    content: change.file.content ?? '',
    render: content => changeSection(change, content),
  })), maxBytes, UPDATE_INTRO)
}

