#!/usr/bin/env node
// node-pty ships `spawn-helper` inside prebuilds/, and its own install script is what
// normally makes it executable. pnpm's default `ignore-scripts` posture (and even an
// approved rebuild) can leave it at 0644, and node-pty then fails every spawn with a
// bare "posix_spawnp failed". Make it executable, idempotently, after every install.
//
// This runs from the workspace root, where node-pty is NOT resolvable: pnpm installs it
// into the daemon package's isolated tree. So locate the package by looking where pnpm
// actually puts it rather than by asking Node to resolve it.
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  process.exit(0)
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** Every place a node-pty install can land in this workspace. */
function nodePtyRoots() {
  const roots = []
  // pnpm's content-addressed store: node_modules/.pnpm/node-pty@<version>/node_modules/node-pty
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm')
  for (const entry of safeReaddir(pnpmDir)) {
    if (!entry.isDirectory() || !entry.name.startsWith('node-pty@')) continue
    roots.push(join(pnpmDir, entry.name, 'node_modules', 'node-pty'))
  }
  // npm/yarn-style hoisting, and per-package links.
  roots.push(join(repoRoot, 'node_modules', 'node-pty'))
  for (const entry of safeReaddir(join(repoRoot, 'packages'))) {
    if (!entry.isDirectory()) continue
    roots.push(join(repoRoot, 'packages', entry.name, 'node_modules', 'node-pty'))
  }
  return roots
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

let fixed = 0
let found = 0

function walk(dir) {
  for (const entry of safeReaddir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(path)
    } else if (entry.name === 'spawn-helper') {
      found += 1
      const mode = statSync(path).mode & 0o777
      if ((mode & 0o111) !== 0o111) {
        chmodSync(path, mode | 0o755)
        fixed += 1
      }
    }
  }
}

for (const root of nodePtyRoots()) {
  walk(join(root, 'build', 'Release'))
  walk(join(root, 'prebuilds'))
}

if (found === 0) {
  // Not an error: node-pty may simply not be installed yet.
  process.exit(0)
}
if (fixed > 0) {
  console.log(`[leap-chorus] made ${fixed} of ${found} node-pty spawn-helper binaries executable`)
}
