/**
 * Which agent is running in a pane.
 *
 * The lookup table is herdr's `lookup_agent` (Apache-2.0, herdr 3f2a6e74), narrowed to
 * the agents whose manifests are bundled. Adding an agent is a manifest plus a row
 * here; nothing else in the system learns its name.
 *
 * ## Why a process name and not the screen
 *
 * The screen says what *state* an agent is in; it is a bad witness for *which* agent,
 * because every one of them draws a box with "esc to cancel" in it. The process running
 * in front of the pane's shell is unambiguous, and it is also how we know the agent has
 * gone away — which is the `done` state the screen cannot express.
 */

/** A pane's agent status, as the rest of the system sees it. */
export type PaneAgentStatus = 'idle' | 'working' | 'blocked' | 'unknown' | 'done'

export interface AgentDefinition {
  /** Canonical id. Also the manifest filename and the `id` inside it. */
  readonly id: string
  /** Process names, `argv[0]` basenames, and manifest aliases that mean this agent. */
  readonly names: readonly string[]
  /** What a user types to start it. Used by `agent.launch` and the integration installer. */
  readonly executable: string
  /**
   * Exact path-component runs that identify this agent's installed package.
   *
   * For the case the basename cannot answer: a CLI that runs as `node <path>/cli.js`,
   * where the only evidence is the package directory. Matched as a contiguous run of
   * components, never as "the word appears somewhere in the path" — herdr's rule, and
   * the reason is a user whose home directory is `/Users/claude`, which component
   * scanning would report as an agent in every pane they ever open.
   */
  readonly packagePaths?: readonly (readonly string[])[]
}

export const AGENTS: readonly AgentDefinition[] = [
  {
    id: 'claude',
    names: ['claude', 'claude-code'],
    executable: 'claude',
    packagePaths: [['node_modules', '@anthropic-ai', 'claude-code']]
  },
  { id: 'codex', names: ['codex'], executable: 'codex', packagePaths: [['node_modules', '@openai', 'codex']] },
  {
    id: 'opencode',
    names: ['opencode', 'open-code', 'opencode2'],
    executable: 'opencode',
    packagePaths: [['node_modules', 'opencode-ai']]
  }
]

const BY_NAME = new Map<string, AgentDefinition>()
for (const agent of AGENTS) {
  for (const name of [agent.id, ...agent.names]) BY_NAME.set(name, agent)
}

export function agentById(id: string): AgentDefinition | null {
  const agent = AGENTS.find((entry) => entry.id === id)
  return agent ?? null
}

/** Strip a directory prefix without pulling in `node:path`, either separator. */
export function basename(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return cut === -1 ? name : name.slice(cut + 1)
}

/**
 * Drop the extension a launcher happens to carry.
 *
 * Measured, not assumed: claude installs as
 * `@anthropic-ai/claude-code/bin/claude.exe` — a native binary with a `.exe` suffix on
 * macOS — so a bare basename match would miss the agent this project's own author is
 * most likely to run.
 */
const LAUNCHER_EXTENSIONS = /\.(exe|js|mjs|cjs|cmd|bat|ps1)$/iu

export function launcherName(name: string): string {
  return basename(name.trim()).replace(LAUNCHER_EXTENSIONS, '').toLowerCase()
}

/**
 * Identify an agent from a process name or `argv[0]`.
 *
 * Case-insensitive on the basename only, so `/opt/homebrew/bin/claude` and `Claude`
 * both resolve and `claude-wrapper` does not.
 */
export function identifyAgent(processName: string): AgentDefinition | null {
  const name = launcherName(processName)
  if (name.length === 0) return null
  return BY_NAME.get(name) ?? null
}

/** Split a path into its non-empty components, either separator. */
function pathComponents(path: string): string[] {
  return path.split(/[/\\]/u).filter((part) => part.length > 0)
}

/** Whether `components` contains `run` as a contiguous, case-insensitive sequence. */
function containsRun(components: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0 || components.length < run.length) return false
  for (let start = 0; start + run.length <= components.length; start++) {
    let matched = true
    for (let i = 0; i < run.length; i++) {
      if ((components[start + i] as string).toLowerCase() !== (run[i] as string).toLowerCase()) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/** Identify an agent from an installed package path, when the basename cannot. */
export function identifyAgentByPackagePath(path: string): AgentDefinition | null {
  const components = pathComponents(path)
  if (components.length === 0) return null
  for (const agent of AGENTS) {
    for (const run of agent.packagePaths ?? []) {
      if (containsRun(components, run)) return agent
    }
  }
  return null
}

/**
 * Identify an agent from a whole command line.
 *
 * Node-based CLIs are commonly `node /path/to/cli.js`, and several ship a launcher
 * shell script, so the process name alone misses them. This walks the argv looking for
 * an argument whose basename names an agent, which is what herdr's
 * `wrapped_agent_name_from_runtime_argv` does for the same reason.
 */
const GENERIC_RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'zsh', 'fish', 'env'])

/**
 * Flags whose argument is code, not a script path.
 *
 * `node -e 'setTimeout(...)' /tmp/claude` must not report claude: the token after the
 * eval flag is a program *text*, and anything after it is that program's own argv.
 * herdr carries the same list for the same reason, with a test per runtime.
 */
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c', '-m'])

export function identifyAgentInCommand(command: string): AgentDefinition | null {
  const parts = command.split(/\s+/u).filter((part) => part.length > 0)
  const first = parts[0]
  if (first === undefined) return null
  const direct = identifyAgent(first) ?? identifyAgentByPackagePath(first)
  if (direct !== null) return direct
  if (!GENERIC_RUNTIMES.has(launcherName(first))) return null

  for (const part of parts.slice(1)) {
    // An eval flag ends the search: everything after it belongs to the evaluated code.
    if (EVAL_FLAGS.has(part)) return null
    // Flags are not programs. A flag's value could be any path, so it is skipped too —
    // conservatively, by treating the first bare token as the script.
    if (part.startsWith('-')) continue
    return identifyAgent(part) ?? identifyAgentByPackagePath(part)
  }
  return null
}
