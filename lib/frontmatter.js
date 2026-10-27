/**
 * The subset of SKILL.md frontmatter this provider needs.
 *
 * The core filesystem provider keeps its own reader, and neither that reader
 * nor the package source is published, so this copy stays local.
 *
 * @module dsh-workspace-inherit/frontmatter
 */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

const INVALID_BOOLEAN = Symbol('invalid-boolean')

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1)
    return inner.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_match, escape) => {
      if (escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16))
      return { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape]
    })
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function closingQuoteIndex(value) {
  const quote = value[0]
  for (let index = 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === quote) return index
  }
  return -1
}

function stripInlineComment(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const end = closingQuoteIndex(trimmed)
    return end < 0 ? trimmed : trimmed.slice(0, end + 1)
  }
  const match = trimmed.match(/\s#/)
  return match === null ? trimmed : trimmed.slice(0, match.index).trim()
}

function frontmatterBoolean(raw) {
  if (raw === undefined) return undefined
  const value = String(raw).trim().toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return INVALID_BOOLEAN
}

function blockValue(lines, start, end, folded) {
  const block = []
  let index = start
  while (index < end) {
    const line = lines[index]
    if (line.trim().length > 0 && !/^\s/.test(line)) break
    block.push(line)
    index += 1
  }
  const indents = block.filter(line => line.trim().length > 0).map(line => line.match(/^\s*/)[0].length)
  const cut = indents.length > 0 ? Math.min(...indents) : 0
  const body = block.map(line => line.slice(cut))
  const value = folded ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n').trim()
  return { value, next: index }
}

function parseFrontmatterData(lines, start, end) {
  const data = new Map()
  for (let index = start; index < end; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (match === null) continue
    const key = match[1]
    if (data.has(key)) return undefined
    const rawValue = match[2].trim()
    if (/^[|>][+-]?$/.test(rawValue)) {
      const block = blockValue(lines, index + 1, end, rawValue.startsWith('>'))
      data.set(key, block.value)
      index = block.next - 1
      continue
    }
    data.set(key, unquote(stripInlineComment(rawValue)))
  }
  return data
}

/**
 * Parse the subset of `SKILL.md` frontmatter this provider needs.
 *
 * Malformed files and files using the legacy invocation keys are rejected, like
 * the core filesystem provider; callers skip the skill instead of failing a
 * catalog read.
 * @param text - complete `SKILL.md` text.
 * @returns parsed fields with the body, or undefined when the file is not a usable skill.
 */
export function parseSkillText(text) {
  if (typeof text !== 'string') return undefined
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return undefined
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      end = index
      break
    }
  }
  if (end < 0) return undefined
  const data = parseFrontmatterData(lines, 1, end)
  if (data === undefined) return undefined
  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (data.has(legacy)) return undefined
  }
  const name = unquote(data.get('name') ?? '')
  const description = unquote(data.get('description') ?? '')
  if (name.length === 0 || description.length === 0) return undefined
  if (!SKILL_NAME.test(name)) return undefined
  const whenToUse = unquote(data.get('whenToUse') ?? '')
  const disableModelInvocation = frontmatterBoolean(data.get('disable-model-invocation'))
  const userInvocableFlag = frontmatterBoolean(data.get('user-invocable'))
  if (disableModelInvocation === INVALID_BOOLEAN || userInvocableFlag === INVALID_BOOLEAN) return undefined
  const invocation = {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocableFlag !== false,
  }
  return {
    name,
    description,
    ...whenToUse.length > 0 ? { whenToUse } : {},
    invocation,
    body: lines.slice(end + 1).join('\n').trim(),
  }
}

