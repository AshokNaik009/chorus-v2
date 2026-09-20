/**
 * The hook scripts an integration installs, as data.
 *
 * Generated nowhere and read from nowhere: they are string constants for the same
 * reason the manifests are (see `scripts/generate-bundled-manifests.mjs`) — the built
 * app goes through a bundler, and a file read from a path computed at runtime is the
 * one thing a bundler cannot follow.
 *
 * ## Versioning
 *
 * `LEAP_CHORUS_INTEGRATION_VERSION` in each asset is herdr's migration-version rule,
 * ported: it is the version *relative to the last release*, not a per-commit counter.
 * Two edits to a hook between releases bump it once. The installer compares the marker
 * in the file on disk with {@link INTEGRATION_ASSET_VERSION} and rewrites when the
 * installed one is older, which is what makes install idempotent and upgrade automatic.
 *
 * ## Why the hook speaks the wire protocol itself
 *
 * herdr's hooks send one bare JSON line, because herdr's socket accepts one. Ours
 * requires `hello` first — that handshake is what makes the daemon able to refuse an
 * incompatible client, and carving out an exception for hooks would be a second,
 * unversioned entry point into the same endpoint. So the hook does the handshake. It
 * costs one extra line and a read.
 */

/** Bump once per release in which any asset below changed. See the note above. */
export const INTEGRATION_ASSET_VERSION = 1

export interface IntegrationAsset {
  readonly agent: string
  /** File name written into the hook directory. */
  readonly fileName: string
  readonly contents: string
  /** The agent's own settings file, relative to `$HOME`. Null when it has none. */
  readonly settingsPath: string | null
}

/**
 * The POSIX hook, shared by every agent that can run a command on a lifecycle event.
 *
 * Written in `sh` with a `python3` payload, following herdr: the hook runs inside the
 * agent's process tree on a machine whose node may be a different version than ours,
 * and `python3` is the one interpreter present on every macOS and mainstream Linux
 * install that is not also the thing we are trying to observe.
 *
 * Every failure path exits 0. A hook that blocks or fails an agent's turn because a
 * multiplexer was not listening is worse than no hook at all.
 */
function posixHook(agent: string): string {
  return `#!/bin/sh
# installed by leap-chorus
# managed by leap-chorus; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# LEAP_CHORUS_INTEGRATION_ID=${agent}
# LEAP_CHORUS_INTEGRATION_VERSION=${INTEGRATION_ASSET_VERSION}

set -eu

action="\${1:-}"

# Nothing to report to: not inside a pane, or the daemon did not export its endpoint.
[ -n "\${LEAP_CHORUS_PANE_ID:-}" ] || exit 0
[ -n "\${LEAP_CHORUS_SOCKET_PATH:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# The agent writes its event payload on stdin. Read it before anything can block.
hook_input="$(cat 2>/dev/null || true)"

LEAP_CHORUS_ACTION="$action" LEAP_CHORUS_AGENT="${agent}" LEAP_CHORUS_HOOK_INPUT="$hook_input" python3 - <<'PY'
import json
import os
import socket
import sys
import time

action = os.environ.get("LEAP_CHORUS_ACTION", "")
agent = os.environ.get("LEAP_CHORUS_AGENT", "")
pane_id = os.environ.get("LEAP_CHORUS_PANE_ID")
socket_path = os.environ.get("LEAP_CHORUS_SOCKET_PATH")

# The agent's own vocabulary, mapped to ours. An action we do not know is not an
# error: agents add lifecycle events, and an unknown one simply says nothing.
STATES = {
    "working": "working",
    "idle": "idle",
    "blocked": "blocked",
    "session": None,
}
if action not in STATES or not pane_id or not socket_path:
    raise SystemExit(0)
state = STATES[action]

payload = {}
try:
    raw = os.environ.get("LEAP_CHORUS_HOOK_INPUT") or ""
    if raw.strip():
        payload = json.loads(raw)
except Exception:
    payload = {}
if not isinstance(payload, dict):
    payload = {}

session_id = payload.get("session_id")
params = {
    "paneId": pane_id,
    "source": "leap-chorus:" + agent,
    "agent": agent,
    # Nanoseconds since the epoch: hook processes are separate and short lived, so the
    # daemon needs a total order it can compare without trusting arrival time.
    "seq": time.time_ns(),
}
if state is not None:
    params["state"] = state
if isinstance(session_id, str) and session_id:
    params["agentSessionId"] = session_id

try:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(0.5)
    client.connect(socket_path)
    # The endpoint requires a handshake before any other request; see assets.ts.
    hello = {"type": "req", "id": 1, "method": "hello",
             "params": {"protocolVersion": 1, "clientName": "leap-chorus-hook"}}
    report = {"type": "req", "id": 2, "method": "agent.report", "params": params}
    client.sendall((json.dumps(hello) + "\\n" + json.dumps(report) + "\\n").encode())
    try:
        client.recv(4096)
    except Exception:
        pass
    client.close()
except Exception:
    # A hook must never fail the agent's turn because a multiplexer was not listening.
    pass
raise SystemExit(0)
PY
`
}

/**
 * Which agents get an integration, and where their settings live.
 *
 * Only agents whose hooks we can write *and* whose state vocabulary we understand.
 * codex has no user-configurable command hook today, so it is absent rather than
 * installed as a no-op that would report nothing and look broken.
 */
export const INTEGRATION_ASSETS: readonly IntegrationAsset[] = [
  {
    agent: 'claude',
    fileName: 'leap-chorus-agent-state.sh',
    contents: posixHook('claude'),
    settingsPath: '.claude/settings.json'
  },
  {
    agent: 'opencode',
    fileName: 'leap-chorus-agent-state.sh',
    contents: posixHook('opencode'),
    settingsPath: '.config/opencode/opencode.json'
  }
]

export function assetFor(agent: string): IntegrationAsset | null {
  return INTEGRATION_ASSETS.find((asset) => asset.agent === agent) ?? null
}

/** Read the version marker out of an installed hook, or null if it has none. */
export function installedVersionOf(contents: string): number | null {
  const match = /LEAP_CHORUS_INTEGRATION_VERSION=(\d+)/u.exec(contents)
  if (match === null) return null
  const value = Number.parseInt(match[1] as string, 10)
  return Number.isSafeInteger(value) ? value : null
}
