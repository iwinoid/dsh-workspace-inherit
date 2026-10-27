/**
 * Plugin configuration for dsh-workspace-inherit.
 *
 * The plugin is intentionally dependency-free: this module validates the row
 * config itself instead of pulling in a schema library, so the installed bundle
 * has no runtime dependencies at all.
 *
 * @module dsh-workspace-inherit/config
 */

/** Default configuration values. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  includeInstructions: true,
  includeSkills: true,
  maxBytes: 65536,
  maxSourceBytes: 1048576,
  instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
  localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
  projectRootMarkers: ['.git'],
})

function fail(message) {
  throw new TypeError(`dsh-workspace-inherit: ${message}`)
}

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function booleanField(input, key) {
  if (input[key] === undefined) return DEFAULTS[key]
  if (typeof input[key] !== 'boolean') fail(`"${key}" must be a boolean`)
  return input[key]
}

function positiveIntegerField(input, key) {
  if (input[key] === undefined) return DEFAULTS[key]
  const value = input[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    fail(`"${key}" must be a positive integer`)
  }
  return value
}

function fileNameListField(input, key) {
  if (input[key] === undefined) return [...DEFAULTS[key]]
  const value = input[key]
  if (!Array.isArray(value)) fail(`"${key}" must be an array of file names`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.includes('/') || entry.includes('\\')) {
      fail(`"${key}" entries must be non-empty file names without path separators`)
    }
    return entry
  })
}

/**
 * Resolve one row config into the complete plugin configuration.
 * @param input - raw row config, as supplied by the Loader.
 * @returns the resolved configuration with every default applied.
 * @throws {TypeError} when a field has the wrong shape or value.
 */
export function resolveConfig(input) {
  if (input === undefined) input = {}
  if (!plainObject(input)) fail('config must be an object')

  const config = {
    enabled: booleanField(input, 'enabled'),
    includeInstructions: booleanField(input, 'includeInstructions'),
    includeSkills: booleanField(input, 'includeSkills'),
    maxBytes: positiveIntegerField(input, 'maxBytes'),
    maxSourceBytes: positiveIntegerField(input, 'maxSourceBytes'),
    instructionFileCandidates: fileNameListField(input, 'instructionFileCandidates'),
    localInstructionFileCandidates: fileNameListField(input, 'localInstructionFileCandidates'),
  }
  const markers = input.projectRootMarkers === undefined ? [...DEFAULTS.projectRootMarkers] : input.projectRootMarkers
  if (!Array.isArray(markers) || markers.length === 0) fail('"projectRootMarkers" must be a non-empty array')
  config.projectRootMarkers = markers.map((marker) => {
    if (typeof marker !== 'string' || marker.trim().length === 0 || marker.includes('/') || marker.includes('\\')) {
      fail('"projectRootMarkers" entries must be non-empty directory names')
    }
    if (marker === '.' || marker === '..') fail('"projectRootMarkers" cannot use "." or ".."')
    return marker
  })
  return config
}
