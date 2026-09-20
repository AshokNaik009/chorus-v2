#!/bin/sh
# Unpack a release tarball on a machine that has nothing, and prove it runs.
#
# PHASE-5 criterion 7. Deliberately `sh`, not bash: the musl smoke image is Alpine,
# whose /bin/sh is busybox ash, and a bashism here would fail on the exact target the
# check exists for.
#
# What "runs" means, in order of how much it proves:
#
#   1. the launcher execs the pinned node               (no system node needed)
#   2. `--help` prints                                  (the bundle parses and runs)
#   3. the daemon starts and answers over its socket    (node-pty's addon LOADED)
#
# (3) is the one that matters. A `.node` built against too new a glibc fails exactly
# here, at `dlopen`, having passed every earlier step — which is why criterion 8's
# symbol check and this runtime check are both required and neither replaces the other.

set -eu

TARBALL="${1:?usage: smoke-tarball.sh <tarball>}"
WORK="$(mktemp -d)"
DATA="$(mktemp -d)"
trap 'rm -rf "$WORK" "$DATA"' EXIT INT TERM

tar -xzf "$TARBALL" -C "$WORK"
ROOT="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
LAUNCHER="$ROOT/bin/leap-chorus"

echo "--- slot"
cat "$ROOT/SLOT"

echo "--- 1. the launcher runs with nothing on PATH"
# `env -i` clears everything; only PATH and HOME are restored, and PATH deliberately
# excludes wherever CI put a node.
env -i PATH=/usr/bin:/bin HOME="$WORK" "$LAUNCHER" --help > "$WORK/help.txt" 2>&1 || {
  echo "FAIL: the launcher did not run"
  cat "$WORK/help.txt"
  exit 1
}

echo "--- 2. it printed its usage"
grep -q 'leap-chorus' "$WORK/help.txt" || {
  echo "FAIL: --help printed nothing recognizable"
  cat "$WORK/help.txt"
  exit 1
}

echo "--- 3. the daemon starts and loads the native addon"
# Run the daemon directly rather than through the client: it needs no terminal, and
# it is the process that actually dlopen()s pty.node.
env -i PATH=/usr/bin:/bin HOME="$WORK" LEAP_CHORUS_DATA_DIR="$DATA" \
  "$ROOT/node/bin/node" "$ROOT/lib/leap-chorusd.js" --data-root "$DATA" > "$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!

# Poll for the readiness line rather than sleeping a fixed time: a cold container is
# slow, and a fixed sleep is either flaky or wasteful.
i=0
while [ "$i" -lt 100 ]; do
  if grep -q 'daemon_ready' "$WORK/daemon.log" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "FAIL: the daemon exited before becoming ready"
    cat "$WORK/daemon.log"
    exit 1
  fi
  i=$((i + 1))
  sleep 0.1
done

if ! grep -q 'daemon_ready' "$WORK/daemon.log"; then
  echo "FAIL: the daemon never became ready"
  cat "$WORK/daemon.log"
  kill "$DAEMON_PID" 2>/dev/null || true
  exit 1
fi

echo "--- 4. it can actually fork a pty"
# The addon being loadable is not the same as it working: `openpty`/`forkpty` are two
# of the three symbols the glibc merge moved, and they are called here for the first
# time. Speak the protocol directly over the socket — no terminal required.
cat > "$WORK/spawn.mjs" <<'PROBE'
import { connect } from 'node:net'
import { join } from 'node:path'

const socketPath = join(process.env.LEAP_CHORUS_DATA_DIR, 'daemon', 'daemon-v1.sock')
const socket = connect(socketPath)
let buffer = ''
const replies = []

socket.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) replies.push(JSON.parse(line))
  }
})

const send = (id, method, params) =>
  socket.write(JSON.stringify({ type: 'req', id, method, params }) + '\n')

await new Promise((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})
send(1, 'hello', { protocolVersion: 1, clientName: 'smoke' })
send(2, 'session.create', { cols: 80, rows: 24 })

const deadline = Date.now() + 15000
while (Date.now() < deadline) {
  const created = replies.find((reply) => reply.id === 2)
  if (created) {
    if (!created.ok) throw new Error('session.create failed: ' + JSON.stringify(created.error))
    const pid = created.result?.session?.pid
    if (typeof pid !== 'number' || pid <= 0) throw new Error('no pid: forkpty did not work')
    console.log('forked a shell, pid ' + pid)
    socket.end()
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
}
throw new Error('the daemon never answered session.create')
PROBE

env -i PATH=/usr/bin:/bin HOME="$WORK" LEAP_CHORUS_DATA_DIR="$DATA" \
  "$ROOT/node/bin/node" "$WORK/spawn.mjs" || {
  echo "FAIL: the daemon could not fork a pty"
  cat "$WORK/daemon.log"
  kill "$DAEMON_PID" 2>/dev/null || true
  exit 1
}

kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true

grep -q 'daemon_ready' "$WORK/daemon.log"
echo "PASS: $(basename "$TARBALL") runs on this machine"
