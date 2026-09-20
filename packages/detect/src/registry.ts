/**
 * Which manifest is in force for an agent, and how it gets replaced.
 *
 * Two sources, in precedence order:
 *
 * 1. a local override at `<config dir>/agent-detection/<id>.toml`
 * 2. the bundled manifest
 *
 * herdr has a third — a remotely published catalog it caches between the two — and
 * this deliberately does not. A remote catalog is a supply chain: it means a rule file
 * fetched over the network decides what runs a regex against a user's terminal, and it
 * needs signing, pinning and a rollback story before it is worth having. The override
 * path is what makes the hot-reload development loop work, which is the part that
 * earns its keep today.
 *
 * ## Why an override at all
 *
 * Detection goes stale the day an agent ships a new spinner. An override plus
 * `server.reload_agent_manifests` lets someone fix their own machine in a minute,
 * without a release, and is how a fix is *developed* before it is bundled.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { BUNDLED_MANIFESTS } from './bundled.js'
import { compileManifest, parseManifest, type CompiledManifest } from './manifest.js'

export type ManifestSourceKind = 'bundled' | 'override'

export interface LoadedManifest {
  readonly compiled: CompiledManifest
  readonly source: ManifestSourceKind
  /** Where an override came from. Null for bundled. */
  readonly path: string | null
  /** Why an override was ignored, if one was. Surfaced by `agent.explain`. */
  readonly warning: string | null
}

export interface ManifestRegistryOptions {
  /** Where overrides live. Defaults to the XDG config dir. */
  readonly overrideDir?: string
  /** Injected in tests. Returns the file's text, or throws. */
  readonly readFile?: (path: string) => string
}

/** `$XDG_CONFIG_HOME/leap-chorus/agent-detection`, else `~/.config/leap-chorus/...`. */
export function defaultOverrideDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME']
  const base = xdg !== undefined && xdg.length > 0 && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(base, 'leap-chorus', 'agent-detection')
}

export class ManifestRegistry {
  private readonly overrideDir: string
  private readonly read: (path: string) => string
  private readonly cache = new Map<string, LoadedManifest | null>()

  constructor(options: ManifestRegistryOptions = {}) {
    this.overrideDir = options.overrideDir ?? defaultOverrideDir()
    this.read = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
  }

  /** Every agent id with a bundled manifest. */
  get ids(): string[] {
    return BUNDLED_MANIFESTS.map(([id]) => id)
  }

  /**
   * The manifest for an agent, compiled, cached.
   *
   * Cached because compiling one manifest builds ~40 `RegExp` objects and the poll
   * would otherwise do that per pane per tick. `reload` is the only way to drop it.
   */
  get(id: string): LoadedManifest | null {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    const loaded = this.load(id)
    this.cache.set(id, loaded)
    return loaded
  }

  /** Drop the cache so the next `get` re-reads overrides. `agent.reload_manifests`. */
  reload(ids?: readonly string[]): string[] {
    if (ids === undefined) this.cache.clear()
    else for (const id of ids) this.cache.delete(id)
    const reloaded: string[] = []
    for (const id of ids ?? this.ids) {
      if (this.get(id) !== null) reloaded.push(id)
    }
    return reloaded
  }

  private load(id: string): LoadedManifest | null {
    const bundledSource = BUNDLED_MANIFESTS.find(([bundledId]) => bundledId === id)?.[1]
    if (bundledSource === undefined) return null

    const bundled = (): LoadedManifest => ({
      // A bundled manifest that does not compile is a build error, not a runtime one:
      // `bundled.test.ts` compiles every one of them.
      compiled: compileManifest(parseManifest(bundledSource)),
      source: 'bundled',
      path: null,
      warning: null
    })

    const path = join(this.overrideDir, `${id}.toml`)
    let text: string
    try {
      text = this.read(path)
    } catch {
      // A missing override is the normal case, not a problem to report.
      return bundled()
    }

    try {
      const manifest = parseManifest(text)
      if (manifest.id !== id && !manifest.aliases.includes(id)) {
        return { ...bundled(), warning: `ignored override ${path}: its id ${manifest.id} is not ${id}` }
      }
      return { compiled: compileManifest(manifest), source: 'override', path, warning: null }
    } catch (error) {
      // A broken override falls back rather than failing: the alternative is a pane
      // that reports nothing because a file the user was editing has a typo in it.
      return { ...bundled(), warning: `ignored override ${path}: ${String(error)}` }
    }
  }
}
