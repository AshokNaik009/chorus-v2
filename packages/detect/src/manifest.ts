/**
 * The manifest engine: TOML rules in, an agent state out.
 *
 * Ported from herdr's `src/detect/manifest.rs` (Apache-2.0, herdr 3f2a6e74). The design
 * is herdr's and is kept deliberately: a rule names a *region* of the screen and a tree
 * of AND/OR/NOT gates over it, and the highest-priority matching rule wins. Detection
 * is then data, versioned per agent, and a new agent release is a TOML edit rather than
 * a code change — which matters because these rules go stale whenever a vendor ships a
 * new spinner.
 *
 * What is *not* ported is how the signals are obtained: herdr reads them through
 * Ghostty's API, we read them off `@xterm/headless` and an `ps` snapshot. Nothing in
 * this file knows either — it takes strings.
 *
 * ## Rule evaluation, exactly
 *
 * Every rule is evaluated (there is no short circuit across rules, because `explain`
 * has to report what each one saw), and the winner is the matching rule with the
 * highest `priority`. Ties go to the *first* in file order, which is herdr's `>=`
 * comparison and is why manifests are written most-specific-first within a priority
 * band.
 *
 * A gate matches when **all** of its `contains`, `regex` and `line_regex` matchers
 * match, **all** of its `all` children match, **at least one** of its `any` children
 * matches (when there are any), and **none** of its `not` children match. `contains` is
 * case-insensitive; the regexes are not, unless they say `(?i)`.
 */

import { parseToml } from '@leap-chorus/config-loader'
import { compileRustRegex } from './regex.js'
import {
  parseRegionSpec,
  region,
  splitLines,
  TOP_NON_EMPTY_LINES_ENGINE_VERSION,
  type DetectionInput
} from './regions.js'

export type AgentState = 'idle' | 'working' | 'blocked' | 'unknown'

/** The engine generation. A manifest may require a newer one; it never requires older. */
export const MANIFEST_ENGINE_VERSION = 3

// The complexity ceilings are herdr's, unchanged. They exist because a manifest can
// come from a file the user (or a future remote catalog) wrote, and a pathological one
// must cost a load error rather than a poll that never returns.
export const MAX_RULES_PER_MANIFEST = 128
export const MAX_GATE_DEPTH = 8
export const MAX_TOTAL_GATES = 512
export const MAX_MATCHERS_PER_GATE = 32
export const MAX_TOTAL_MATCHERS = 1024
export const MAX_MATCHER_CHARS = 512

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ManifestGate {
  readonly all: readonly ManifestGate[]
  readonly any: readonly ManifestGate[]
  readonly not: readonly ManifestGate[]
  readonly contains: readonly string[]
  readonly regex: readonly string[]
  readonly lineRegex: readonly string[]
}

export interface ManifestRule extends ManifestGate {
  readonly id: string
  readonly state: AgentState
  readonly priority: number
  readonly region: string
  /** This rule's match is visible live chrome, not text that scrolled past. */
  readonly visibleIdle: boolean
  readonly visibleBlocker: boolean
  readonly visibleWorking: boolean
  /** The screen is a viewer (a transcript, a picker): report nothing, change nothing. */
  readonly skipStateUpdate: boolean
}

export interface AgentManifest {
  readonly id: string
  readonly version: string | null
  readonly minEngineVersion: number | null
  readonly updatedAt: string | null
  readonly aliases: readonly string[]
  readonly rules: readonly ManifestRule[]
}

interface CompiledGate {
  readonly all: readonly CompiledGate[]
  readonly any: readonly CompiledGate[]
  readonly not: readonly CompiledGate[]
  /** Lower-cased once at compile time; the haystack is lower-cased once per rule. */
  readonly contains: readonly string[]
  readonly regex: readonly RegExp[]
  readonly lineRegex: readonly RegExp[]
}

export interface CompiledManifest {
  readonly manifest: AgentManifest
  readonly gates: readonly CompiledGate[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, where: string, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ManifestError(`${where}: \`${field}\` must be an array of strings`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new ManifestError(`${where}: \`${field}\` must be an array of strings`)
    return entry
  })
}

function gateArray(value: unknown, where: string, field: string): ManifestGate[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ManifestError(`${where}: \`${field}\` must be an array of gates`)
  return value.map((entry, index) => readGate(entry, `${where}.${field}[${index}]`))
}

/**
 * Unknown keys are an error, as they are in herdr (`deny_unknown_fields`).
 *
 * A typo in a hand-written override would otherwise silently drop a matcher and leave
 * a rule that matches far more than its author intended.
 */
const GATE_KEYS = new Set(['all', 'any', 'not', 'contains', 'regex', 'line_regex'])
const RULE_KEYS = new Set([
  ...GATE_KEYS,
  'id',
  'state',
  'priority',
  'region',
  'visible_idle',
  'visible_blocker',
  'visible_working',
  'skip_state_update'
])
const MANIFEST_KEYS = new Set(['id', 'version', 'min_engine_version', 'updated_at', 'aliases', 'rules'])

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ManifestError(`${where}: unknown key \`${key}\``)
  }
}

function readGate(value: unknown, where: string): ManifestGate {
  if (!isRecord(value)) throw new ManifestError(`${where}: expected a table`)
  rejectUnknown(value, GATE_KEYS, where)
  return {
    all: gateArray(value['all'], where, 'all'),
    any: gateArray(value['any'], where, 'any'),
    not: gateArray(value['not'], where, 'not'),
    contains: stringArray(value['contains'], where, 'contains'),
    regex: stringArray(value['regex'], where, 'regex'),
    lineRegex: stringArray(value['line_regex'], where, 'line_regex')
  }
}

function readState(value: unknown, where: string): AgentState {
  if (value === undefined) return 'unknown'
  if (value === 'idle' || value === 'working' || value === 'blocked' || value === 'unknown') return value
  throw new ManifestError(`${where}: \`state\` must be idle, working, blocked or unknown`)
}

function readBoolean(value: unknown, where: string, field: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new ManifestError(`${where}: \`${field}\` must be a boolean`)
  return value
}

function readRule(value: unknown, index: number): ManifestRule {
  if (!isRecord(value)) throw new ManifestError(`rule ${index}: expected a table`)
  const id = value['id']
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new ManifestError(`rule ${index}: \`id\` must be a non-empty string`)
  }
  const where = `rule ${id}`
  rejectUnknown(value, RULE_KEYS, where)
  const priority = value['priority']
  if (priority !== undefined && (typeof priority !== 'number' || !Number.isInteger(priority))) {
    throw new ManifestError(`${where}: \`priority\` must be an integer`)
  }
  const regionSpec = value['region']
  if (regionSpec !== undefined && typeof regionSpec !== 'string') {
    throw new ManifestError(`${where}: \`region\` must be a string`)
  }
  const gate = readGate(
    Object.fromEntries(Object.entries(value).filter(([key]) => GATE_KEYS.has(key))),
    where
  )
  return {
    ...gate,
    id,
    state: readState(value['state'], where),
    priority: priority ?? 0,
    region: regionSpec ?? 'whole_recent',
    visibleIdle: readBoolean(value['visible_idle'], where, 'visible_idle'),
    visibleBlocker: readBoolean(value['visible_blocker'], where, 'visible_blocker'),
    visibleWorking: readBoolean(value['visible_working'], where, 'visible_working'),
    skipStateUpdate: readBoolean(value['skip_state_update'], where, 'skip_state_update')
  }
}

export function parseManifest(content: string): AgentManifest {
  let document: unknown
  try {
    document = parseToml(content)
  } catch (error) {
    throw new ManifestError(`manifest is not valid TOML: ${String(error)}`)
  }
  if (!isRecord(document)) throw new ManifestError('manifest must be a table')
  rejectUnknown(document, MANIFEST_KEYS, 'manifest')

  const id = document['id']
  if (typeof id !== 'string' || id.length === 0) throw new ManifestError('manifest `id` is required')
  const version = document['version']
  if (version !== undefined && typeof version !== 'string') throw new ManifestError('`version` must be a string')
  const minEngine = document['min_engine_version']
  if (minEngine !== undefined && (typeof minEngine !== 'number' || !Number.isInteger(minEngine))) {
    throw new ManifestError('`min_engine_version` must be an integer')
  }
  const updatedAt = document['updated_at']
  if (updatedAt !== undefined && typeof updatedAt !== 'string') throw new ManifestError('`updated_at` must be a string')

  const rawRules = document['rules']
  if (rawRules !== undefined && !Array.isArray(rawRules)) throw new ManifestError('`rules` must be an array')
  const rules = (rawRules ?? []).map((rule, index) => readRule(rule, index))

  const manifest: AgentManifest = {
    id,
    version: version ?? null,
    minEngineVersion: minEngine ?? null,
    updatedAt: updatedAt ?? null,
    aliases: stringArray(document['aliases'], 'manifest', 'aliases'),
    rules
  }
  validateManifest(manifest)
  return manifest
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface Complexity {
  gates: number
  matchers: number
}

export function validateManifest(manifest: AgentManifest): void {
  if (manifest.rules.length === 0) throw new ManifestError('manifest must contain at least one rule')
  if (manifest.rules.length > MAX_RULES_PER_MANIFEST) {
    throw new ManifestError(`manifest contains ${manifest.rules.length} rules, max is ${MAX_RULES_PER_MANIFEST}`)
  }
  if (manifest.minEngineVersion !== null && manifest.minEngineVersion > MANIFEST_ENGINE_VERSION) {
    throw new ManifestError(
      `manifest requires engine ${manifest.minEngineVersion}, this engine is ${MANIFEST_ENGINE_VERSION}`
    )
  }

  const complexity: Complexity = { gates: 0, matchers: 0 }
  const seen = new Set<string>()
  for (const rule of manifest.rules) {
    if (seen.has(rule.id)) throw new ManifestError(`duplicate rule id ${rule.id}`)
    seen.add(rule.id)

    if (rule.skipStateUpdate) {
      // The pairing is load-bearing: a viewer rule must not also claim to be evidence
      // of a state, or "showing the transcript" would set the pane to whatever the
      // transcript happens to contain.
      if (rule.state !== 'unknown') {
        throw new ManifestError(`rule ${rule.id} uses skip_state_update without state = "unknown"`)
      }
      if (rule.visibleIdle || rule.visibleBlocker || rule.visibleWorking) {
        throw new ManifestError(`rule ${rule.id} uses skip_state_update with visible state evidence`)
      }
    }

    const parsed = parseRegionSpec(rule.region)
    if (parsed === null) throw new ManifestError(`rule ${rule.id} uses invalid region: ${rule.region}`)
    if (
      parsed.kind === 'top_non_empty_lines' &&
      manifest.minEngineVersion !== null &&
      manifest.minEngineVersion < TOP_NON_EMPTY_LINES_ENGINE_VERSION
    ) {
      throw new ManifestError(
        `rule ${rule.id} uses top_non_empty_lines but min_engine_version is below ${TOP_NON_EMPTY_LINES_ENGINE_VERSION}`
      )
    }

    validateGate(rule, `rule ${rule.id}`, 0, complexity, false)
  }
}

function hasPositiveMatcher(gate: ManifestGate): boolean {
  return (
    gate.contains.length > 0 ||
    gate.regex.length > 0 ||
    gate.lineRegex.length > 0 ||
    gate.all.length > 0 ||
    gate.any.length > 0
  )
}

function hasAnyMatcher(gate: ManifestGate): boolean {
  return hasPositiveMatcher(gate) || gate.not.length > 0
}

function validateGate(
  gate: ManifestGate,
  where: string,
  depth: number,
  complexity: Complexity,
  negated: boolean
): void {
  if (depth > MAX_GATE_DEPTH) throw new ManifestError(`${where} exceeds max gate depth ${MAX_GATE_DEPTH}`)
  complexity.gates += 1
  if (complexity.gates > MAX_TOTAL_GATES) throw new ManifestError(`manifest exceeds max gate count ${MAX_TOTAL_GATES}`)

  const matchers = gate.contains.length + gate.regex.length + gate.lineRegex.length
  if (matchers > MAX_MATCHERS_PER_GATE) {
    throw new ManifestError(`${where} has ${matchers} direct matchers, max is ${MAX_MATCHERS_PER_GATE}`)
  }
  complexity.matchers += matchers
  if (complexity.matchers > MAX_TOTAL_MATCHERS) {
    throw new ManifestError(`manifest exceeds max matcher count ${MAX_TOTAL_MATCHERS}`)
  }
  for (const value of [...gate.contains, ...gate.regex, ...gate.lineRegex]) {
    if ([...value].length > MAX_MATCHER_CHARS) {
      throw new ManifestError(`${where} matcher exceeds max length ${MAX_MATCHER_CHARS}`)
    }
  }

  // A gate with nothing positive in it matches everything, which under `not` means it
  // matches nothing. Both readings are accidents, so neither is allowed.
  if (negated ? !hasAnyMatcher(gate) : !hasPositiveMatcher(gate)) {
    throw new ManifestError(negated ? `${where} contains an empty not gate` : `${where} must contain a positive matcher`)
  }

  for (const pattern of [...gate.regex, ...gate.lineRegex]) {
    try {
      compileRustRegex(pattern)
    } catch (error) {
      throw new ManifestError(`${where}: ${String(error)}`)
    }
  }

  for (const nested of gate.all) validateGate(nested, `${where} > all`, depth + 1, complexity, false)
  for (const nested of gate.any) validateGate(nested, `${where} > any`, depth + 1, complexity, false)
  for (const nested of gate.not) validateGate(nested, `${where} > not`, depth + 1, complexity, true)
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export function compileManifest(manifest: AgentManifest): CompiledManifest {
  return { manifest, gates: manifest.rules.map((rule) => compileGate(rule)) }
}

function compileGate(gate: ManifestGate): CompiledGate {
  return {
    all: gate.all.map(compileGate),
    any: gate.any.map(compileGate),
    not: gate.not.map(compileGate),
    contains: gate.contains.map((needle) => needle.toLowerCase()),
    regex: gate.regex.map(compileRustRegex),
    lineRegex: gate.lineRegex.map(compileRustRegex)
  }
}

function gateMatches(gate: CompiledGate, text: string, lowerText: string, lines: readonly string[]): boolean {
  for (const needle of gate.contains) if (!lowerText.includes(needle)) return false
  for (const pattern of gate.regex) if (!pattern.test(text)) return false
  for (const pattern of gate.lineRegex) {
    if (!lines.some((line) => pattern.test(line))) return false
  }
  for (const nested of gate.all) if (!gateMatches(nested, text, lowerText, lines)) return false
  if (gate.any.length > 0 && !gate.any.some((nested) => gateMatches(nested, text, lowerText, lines))) return false
  for (const nested of gate.not) if (gateMatches(nested, text, lowerText, lines)) return false
  return true
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface Detection {
  readonly state: AgentState
  readonly skipStateUpdate: boolean
  readonly visibleIdle: boolean
  readonly visibleBlocker: boolean
  readonly visibleWorking: boolean
}

export interface EvaluatedRule {
  readonly id: string
  readonly priority: number
  readonly region: string
  readonly state: AgentState
  readonly matched: boolean
  readonly regionBytes: number
  readonly regionPreview: string
}

export interface DetectionExplain extends Detection {
  readonly agent: string
  readonly matchedRule: { readonly id: string; readonly priority: number; readonly region: string } | null
  readonly fallbackReason: string | null
  readonly skippedUpdateReason: string | null
  readonly manifestVersion: string | null
  readonly evaluatedRules: readonly EvaluatedRule[]
}

/**
 * A known agent whose manifest matched nothing is idle, not unknown.
 *
 * herdr's `DEFAULT_KNOWN_AGENT_IDLE_FALLBACK`, kept for the same reason: the manifests
 * are written to recognize *activity*, so the absence of every working and blocked
 * signal is the evidence that the agent is sitting at its prompt.
 */
export const DEFAULT_KNOWN_AGENT_IDLE_FALLBACK = 'default_known_agent_idle_fallback'

const PREVIEW_CHARS = 240

/**
 * The poll path: a state and four flags, and nothing else built.
 *
 * Projected to exactly {@link Detection} rather than returned wide, so the type is not
 * quietly carrying an `evaluatedRules` the caller must know is empty. `evaluate` skips
 * building the per-rule evidence entirely when it is not asked for them.
 */
export function detect(compiled: CompiledManifest, input: DetectionInput): Detection {
  const result = evaluate(compiled, input, false)
  return {
    state: result.state,
    skipStateUpdate: result.skipStateUpdate,
    visibleIdle: result.visibleIdle,
    visibleBlocker: result.visibleBlocker,
    visibleWorking: result.visibleWorking
  }
}

export function explain(compiled: CompiledManifest, input: DetectionInput): DetectionExplain {
  return evaluate(compiled, input, true)
}

function evaluate(compiled: CompiledManifest, input: DetectionInput, verbose: boolean): DetectionExplain {
  const { manifest } = compiled
  let winner: ManifestRule | null = null
  const evaluated: EvaluatedRule[] = []
  // One region text per distinct spec: sibling rules routinely share `whole_recent`,
  // and slicing plus lower-casing it per rule is the whole per-poll cost of a manifest.
  const cache = new Map<string, { text: string; lower: string; lines: string[] }>()

  for (let i = 0; i < manifest.rules.length; i++) {
    const rule = manifest.rules[i] as ManifestRule
    let entry = cache.get(rule.region)
    if (entry === undefined) {
      const text = region(input, rule.region)
      entry = { text, lower: text.toLowerCase(), lines: splitLines(text).text }
      cache.set(rule.region, entry)
    }
    const matched = gateMatches(compiled.gates[i] as CompiledGate, entry.text, entry.lower, entry.lines)
    if (verbose) {
      evaluated.push({
        id: rule.id,
        priority: rule.priority,
        region: rule.region,
        state: rule.state,
        matched,
        regionBytes: Buffer.byteLength(entry.text, 'utf8'),
        regionPreview: preview(entry.text)
      })
    }
    // `>` and not `>=`: a tie keeps the rule that appeared first in the file.
    if (matched && (winner === null || rule.priority > winner.priority)) winner = rule
  }

  if (winner === null) {
    return {
      agent: manifest.id,
      state: 'idle',
      skipStateUpdate: false,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      matchedRule: null,
      fallbackReason: DEFAULT_KNOWN_AGENT_IDLE_FALLBACK,
      skippedUpdateReason: null,
      manifestVersion: manifest.version,
      evaluatedRules: evaluated
    }
  }

  return {
    agent: manifest.id,
    state: winner.state,
    skipStateUpdate: winner.skipStateUpdate,
    // The `visible_*` flags are claims about the state the rule reports, so a rule that
    // sets `visible_blocker` on a working state says nothing.
    visibleIdle: winner.visibleIdle && winner.state === 'idle',
    visibleBlocker: winner.visibleBlocker && winner.state === 'blocked',
    visibleWorking: winner.visibleWorking && winner.state === 'working',
    matchedRule: { id: winner.id, priority: winner.priority, region: winner.region },
    fallbackReason: null,
    skippedUpdateReason: winner.skipStateUpdate ? `matched_rule:${winner.id}` : null,
    manifestVersion: manifest.version,
    evaluatedRules: evaluated
  }
}

function preview(text: string): string {
  const chars = [...text]
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}...` : text
}
