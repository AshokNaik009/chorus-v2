#!/usr/bin/env node
/**
 * Assemble one platform tarball.
 *
 * ```
 * leap-chorus-<version>-<slot>/
 *   bin/leap-chorus          launcher: runs the pinned node against the bundle
 *   lib/leap-chorus.js       the client
 *   lib/leap-chorusd.js      the daemon
 *   lib/node_modules/node-pty/
 *   node/bin/node            the pinned runtime
 *   SLOT                     what this tarball is, in one line
 * ```
 *
 * ## Why a pinned Node
 *
 * Criterion 7 is that it runs on a machine with no node, no pnpm, no python and no C++
 * toolchain. A tarball that needs a system Node fails that on its own terms, and
 * "requires Node >= 22" is exactly the requirement a stranger cannot satisfy on a
 * locked-down box. ~50 MB of runtime is the price of the criterion.
 *
 * ## Why a shell launcher and not a symlink
 *
 * The launcher resolves its own directory before exec'ing, so the tarball works
 * wherever it is unpacked and through a symlink on `$PATH` — which is how anyone will
 * actually install it.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp, SLOTS, hostSlot } from './build-app.mjs'
import { checkGlibcFloor, DEFAULT_GLIBC_FLOOR } from './check-glibc-floor.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const LAUNCHER = `#!/bin/sh
# leap-chorus launcher.
#
# Resolves its own directory first, following symlinks, so the tarball works wherever
# it is unpacked and through a symlink on PATH.
set -eu
self="$0"
while [ -L "$self" ]; do
  link="$(readlink "$self")"
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
here="$(cd "$(dirname "$self")/.." && pwd)"
exec "$here/node/bin/node" "$here/lib/leap-chorus.js" "$@"
`

/**
 * Stage the tarball contents into a directory.
 *
 * Separate from the tar call so a test can inspect the layout without shelling out,
 * and so a CI job can add the slot's own `pty.node` between staging and archiving.
 */
export async function stageTarball({ slot = hostSlot(), nodeDir = null, outDir = join(root, 'dist-release') } = {}) {
  const definition = SLOTS.find((entry) => entry.id === slot)
  if (definition === undefined) throw new Error(`unknown slot ${slot}; known: ${SLOTS.map((s) => s.id).join(', ')}`)

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const name = `leap-chorus-${version}-${slot}`
  const stage = join(outDir, name)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'bin'), { recursive: true })

  const app = await buildApp({ slot })
  cpSync(app, join(stage, 'lib'), { recursive: true })

  writeFileSync(join(stage, 'bin', 'leap-chorus'), LAUNCHER, { mode: 0o755 })
  chmodSync(join(stage, 'bin', 'leap-chorus'), 0o755)

  // The slot is recorded in the tarball rather than inferred later. A binary that has
  // to guess its own libc at runtime is the bug the six-slot matrix exists to avoid.
  writeFileSync(
    join(stage, 'SLOT'),
    `${JSON.stringify({ slot, version, platform: definition.platform, arch: definition.arch, libc: definition.libc }, null, 2)}\n`
  )

  if (nodeDir !== null) {
    cpSync(nodeDir, join(stage, 'node'), { recursive: true })
  }
  return { stage, name, slot, version }
}

/**
 * Refuse to ship a Linux slot whose native addon needs too new a glibc.
 *
 * Runs at *package* time as well as in CI, because the failure it catches is invisible
 * on the machine that produces it: the build is green and the binary simply will not
 * load somewhere else.
 */
export function verifySlot(stage, slot, floor = DEFAULT_GLIBC_FLOOR) {
  const problems = []
  const definition = SLOTS.find((entry) => entry.id === slot)

  const launcher = join(stage, 'bin', 'leap-chorus')
  const client = join(stage, 'lib', 'leap-chorus.js')
  const daemon = join(stage, 'lib', 'leap-chorusd.js')
  for (const required of [launcher, client, daemon]) {
    if (!existsSync(required)) problems.push(`missing ${required}`)
  }

  const prebuild = join(stage, 'lib', 'node_modules', 'node-pty', 'prebuilds', `${definition?.platform}-${definition?.arch}`, 'pty.node')
  if (!existsSync(prebuild)) {
    problems.push(`missing the native addon for ${slot} at ${prebuild}`)
  } else if (definition?.libc === 'glibc') {
    const result = checkGlibcFloor(readFileSync(prebuild), floor)
    if (!result.ok) {
      problems.push(`pty.node requires ${result.violations.map((v) => `GLIBC_${v}`).join(', ')}, above the ${floor} floor`)
    }
  }

  if (!existsSync(join(stage, 'node', 'bin', 'node'))) {
    problems.push('no pinned node runtime; the tarball would need a system node')
  }
  return problems
}

export function archive(stage, name, outDir) {
  const tarball = join(outDir, `${name}.tar.gz`)
  execFileSync('tar', ['-czf', tarball, '-C', outDir, name], { stdio: 'inherit' })
  return tarball
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const valueOf = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 ? null : args[index + 1]
  }
  const slot = valueOf('--slot') ?? hostSlot()
  const nodeDir = valueOf('--node-dir')
  const outDir = valueOf('--out') ?? join(root, 'dist-release')

  const { stage, name } = await stageTarball({ slot, nodeDir, outDir })
  const problems = verifySlot(stage, slot)
  if (problems.length > 0) {
    console.error(`${slot} is not shippable:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    if (!args.includes('--allow-incomplete')) process.exit(1)
  }
  if (args.includes('--no-archive')) {
    console.log(`staged ${stage}`)
  } else {
    console.log(`packaged ${archive(stage, name, outDir)}`)
  }
}
