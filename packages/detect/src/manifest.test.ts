/**
 * The engine, tested against synthetic manifests.
 *
 * Deliberately not against real agents' screens. herdr's rule, and the reason is that a
 * test asserting "this captured claude screen means blocked" freezes a vendor's UI into
 * the suite: it goes red when claude ships a new spinner, which is a *compatibility*
 * fact, not a regression in this code. Engine tests prove the rules execute as written.
 * Whether the rules are still true of a shipping CLI is a live smoke test — see the
 * detection log in HANDOFF.md.
 *
 * So: minimal manifests, minimal input strings, one behaviour each.
 */

import { describe, expect, it } from 'vitest'
import {
  compileManifest,
  detect,
  explain,
  MANIFEST_ENGINE_VERSION,
  ManifestError,
  MAX_GATE_DEPTH,
  parseManifest
} from './manifest.js'
import { detectionInput } from './regions.js'

function build(toml: string) {
  return compileManifest(parseManifest(toml))
}

function stateOf(toml: string, screen: string, extra: { oscTitle?: string; oscProgress?: string } = {}) {
  return detect(build(toml), detectionInput({ screen, ...extra })).state
}

const MINIMAL = `
id = "t"
[[rules]]
id = "r"
state = "working"
contains = ["busy"]
`

describe('parsing', () => {
  it('reads a manifest and its defaults', () => {
    const manifest = parseManifest(MINIMAL)
    expect(manifest.id).toBe('t')
    expect(manifest.rules).toHaveLength(1)
    const rule = manifest.rules[0]!
    expect(rule.priority).toBe(0)
    expect(rule.region).toBe('whole_recent')
    expect(rule.visibleWorking).toBe(false)
  })

  it('rejects an unknown key rather than dropping it', () => {
    // A typo in a hand-edited override would otherwise silently widen a rule.
    expect(() => parseManifest(`${MINIMAL}\ncontians = ["x"]`)).toThrow(/unknown key/u)
  })

  it('rejects a manifest with no rules', () => {
    expect(() => parseManifest('id = "t"')).toThrow(/at least one rule/u)
  })

  it('rejects a duplicate rule id', () => {
    expect(() => parseManifest(`${MINIMAL}\n[[rules]]\nid = "r"\ncontains = ["y"]`)).toThrow(/duplicate rule id/u)
  })

  it('rejects an unknown state', () => {
    expect(() => parseManifest('id = "t"\n[[rules]]\nid = "r"\nstate = "busy"\ncontains = ["x"]')).toThrow(
      /must be idle, working, blocked or unknown/u
    )
  })

  it('rejects an unknown region by name', () => {
    expect(() => parseManifest('id = "t"\n[[rules]]\nid = "r"\nregion = "the_bottom"\ncontains = ["x"]')).toThrow(
      /invalid region: the_bottom/u
    )
  })

  it('rejects a manifest that needs a newer engine', () => {
    const future = MINIMAL.replace('id = "t"', `id = "t"\nmin_engine_version = ${MANIFEST_ENGINE_VERSION + 1}`)
    expect(() => parseManifest(future)).toThrow(/requires engine/u)
  })

  it('rejects top_non_empty_lines below the engine version that introduced it', () => {
    expect(() =>
      parseManifest('id = "t"\nmin_engine_version = 2\n[[rules]]\nid = "r"\nregion = "top_non_empty_lines(3)"\ncontains = ["x"]')
    ).toThrow(/min_engine_version is below 3/u)
  })

  it('rejects an untranslatable regex at load, not at match time', () => {
    expect(() => parseManifest('id = "t"\n[[rules]]\nid = "r"\nregex = ["a(?i)b"]')).toThrow(ManifestError)
  })
})

describe('skip_state_update pairing', () => {
  it('requires state = unknown', () => {
    expect(() =>
      parseManifest('id = "t"\n[[rules]]\nid = "r"\nstate = "idle"\nskip_state_update = true\ncontains = ["x"]')
    ).toThrow(/without state = "unknown"/u)
  })

  it('forbids visible state evidence beside it', () => {
    // A viewer screen is not evidence of anything; claiming both would let a
    // transcript's own text set the pane's state.
    expect(() =>
      parseManifest(
        'id = "t"\n[[rules]]\nid = "r"\nstate = "unknown"\nskip_state_update = true\nvisible_idle = true\ncontains = ["x"]'
      )
    ).toThrow(/with visible state evidence/u)
  })
})

describe('gate shapes', () => {
  const gated = (body: string) => `id = "t"\n[[rules]]\nid = "r"\nstate = "blocked"\n${body}`

  it('ANDs the direct matchers', () => {
    const toml = gated('contains = ["proceed?", "esc to cancel"]')
    expect(stateOf(toml, 'proceed? esc to cancel')).toBe('blocked')
    expect(stateOf(toml, 'proceed?')).toBe('idle')
  })

  it('matches contains case-insensitively and regex case-sensitively', () => {
    expect(stateOf(gated('contains = ["Proceed?"]'), 'PROCEED?')).toBe('blocked')
    expect(stateOf(gated('regex = ["Proceed"]'), 'proceed')).toBe('idle')
    expect(stateOf(gated("regex = ['(?i)Proceed']"), 'proceed')).toBe('blocked')
  })

  it('anchors line_regex per line, not across the whole region', () => {
    const toml = gated("line_regex = ['^yes$']")
    expect(stateOf(toml, 'pick one\nyes\nno')).toBe('blocked')
    expect(stateOf(toml, 'pick one: yes please')).toBe('idle')
  })

  it('ORs an any gate and ANDs an all gate', () => {
    const toml = gated('contains = ["prompt"]\nany = [{ contains = ["yes"] }, { contains = ["no"] }]')
    expect(stateOf(toml, 'prompt yes')).toBe('blocked')
    expect(stateOf(toml, 'prompt no')).toBe('blocked')
    expect(stateOf(toml, 'prompt maybe')).toBe('idle')

    const both = gated('all = [{ contains = ["a"] }, { contains = ["b"] }]')
    expect(stateOf(both, 'a b')).toBe('blocked')
    expect(stateOf(both, 'a')).toBe('idle')
  })

  it('an empty any gate list is not a veto', () => {
    // `any = []` means "nobody asked", not "nothing can match".
    expect(stateOf(gated('contains = ["x"]\nany = []'), 'x')).toBe('blocked')
  })

  it('vetoes on a not gate', () => {
    const toml = gated('contains = ["proceed?"]\nnot = [{ contains = ["transcript"] }]')
    expect(stateOf(toml, 'proceed?')).toBe('blocked')
    expect(stateOf(toml, 'proceed? in the transcript')).toBe('idle')
  })

  it('nests gates to the documented depth and refuses one deeper', () => {
    const nest = (depth: number): string => {
      let body = '{ contains = ["x"] }'
      for (let i = 0; i < depth; i++) body = `{ all = [${body}] }`
      return `id = "t"\n[[rules]]\nid = "r"\nall = [${body}]`
    }
    expect(() => parseManifest(nest(MAX_GATE_DEPTH - 2))).not.toThrow()
    expect(() => parseManifest(nest(MAX_GATE_DEPTH + 2))).toThrow(/max gate depth/u)
  })

  it('refuses a gate with no positive matcher', () => {
    // It would match everything, which is never what the author meant.
    expect(() => parseManifest('id = "t"\n[[rules]]\nid = "r"\nnot = [{ contains = ["x"] }]')).toThrow(
      /must contain a positive matcher/u
    )
  })

  it('refuses an empty not gate', () => {
    expect(() => parseManifest('id = "t"\n[[rules]]\nid = "r"\ncontains = ["x"]\nnot = [{}]')).toThrow(
      /empty not gate/u
    )
  })
})

describe('priority', () => {
  const TOML = `
id = "t"
[[rules]]
id = "low"
state = "idle"
priority = 10
contains = ["prompt"]
[[rules]]
id = "high"
state = "blocked"
priority = 900
contains = ["prompt", "proceed?"]
`

  it('the highest matching priority wins, whatever the file order', () => {
    expect(stateOf(TOML, 'prompt')).toBe('idle')
    expect(stateOf(TOML, 'prompt proceed?')).toBe('blocked')
  })

  it('a tie keeps the rule that came first in the file', () => {
    const tied = `
id = "t"
[[rules]]
id = "first"
state = "working"
priority = 5
contains = ["x"]
[[rules]]
id = "second"
state = "blocked"
priority = 5
contains = ["x"]
`
    expect(explain(build(tied), detectionInput({ screen: 'x' })).matchedRule?.id).toBe('first')
  })

  it('a known agent that matches nothing is idle, and says so', () => {
    const result = explain(build(MINIMAL), detectionInput({ screen: 'nothing here' }))
    expect(result.state).toBe('idle')
    expect(result.matchedRule).toBeNull()
    expect(result.fallbackReason).toBe('default_known_agent_idle_fallback')
  })
})

describe('visible_* evidence', () => {
  it('is reported only when it agrees with the rule state', () => {
    const agree = build('id = "t"\n[[rules]]\nid = "r"\nstate = "blocked"\nvisible_blocker = true\ncontains = ["x"]')
    expect(detect(agree, detectionInput({ screen: 'x' })).visibleBlocker).toBe(true)

    // A rule claiming `visible_blocker` on a working state is claiming nothing.
    const disagree = build('id = "t"\n[[rules]]\nid = "r"\nstate = "working"\nvisible_blocker = true\ncontains = ["x"]')
    expect(detect(disagree, detectionInput({ screen: 'x' })).visibleBlocker).toBe(false)
    expect(detect(disagree, detectionInput({ screen: 'x' })).visibleWorking).toBe(false)
  })

  it('carries skip_state_update and its reason', () => {
    const toml = 'id = "t"\n[[rules]]\nid = "viewer"\nstate = "unknown"\nskip_state_update = true\ncontains = ["transcript"]'
    const result = explain(build(toml), detectionInput({ screen: 'transcript' }))
    expect(result.skipStateUpdate).toBe(true)
    expect(result.skippedUpdateReason).toBe('matched_rule:viewer')
  })
})

describe('OSC regions', () => {
  const TOML = `
id = "t"
[[rules]]
id = "title"
state = "working"
priority = 100
region = "osc_title"
regex = ['^\\x{2801} ']
[[rules]]
id = "progress"
state = "idle"
priority = 50
region = "osc_progress"
regex = ['^4;0']
`

  it('reads the title and progress strings, never the screen', () => {
    expect(stateOf(TOML, '⠁ busy')).toBe('idle') // the screen is not the title
    expect(stateOf(TOML, '', { oscTitle: '⠁ thinking' })).toBe('working')
    expect(stateOf(TOML, '', { oscProgress: '4;0' })).toBe('idle')
  })
})

describe('explain', () => {
  it('reports every rule with what it saw', () => {
    const result = explain(build(MINIMAL), detectionInput({ screen: 'busy here' }))
    expect(result.evaluatedRules).toHaveLength(1)
    const rule = result.evaluatedRules[0]!
    expect(rule.matched).toBe(true)
    expect(rule.regionBytes).toBe(9)
    expect(rule.regionPreview).toBe('busy here')
  })

  it('measures the region in UTF-8 bytes, so a preview is not mistaken for a length', () => {
    const result = explain(build(MINIMAL), detectionInput({ screen: 'busy ✳' }))
    expect(result.evaluatedRules[0]!.regionBytes).toBe(8)
  })

  it('costs nothing on the detect path', () => {
    // `detect` must not build the evidence array: it runs per pane per poll.
    const quiet = detect(build(MINIMAL), detectionInput({ screen: 'busy' }))
    expect(Object.hasOwn(quiet, 'evaluatedRules')).toBe(false)
  })
})
