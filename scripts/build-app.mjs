#!/usr/bin/env node
/**
 * Bundle the two entrypoints into a runnable app.
 *
 * ## Why a bundler at all
 *
 * pnpm's `node_modules` is a symlink farm into a content-addressed store. It is right
 * for development and impossible to put in a tarball: the links point outside the tree
 * and `tar -h` would duplicate every shared dependency. Bundling sidesteps the whole
 * question — the shipped app is two `.js` files and one native addon.
 *
 * ## node-pty is external, and this is the one thing to get right
 *
 * node-pty's `lib/utils.js` resolves its binary at *runtime*:
 *
 * ```js
 * const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]
 * return { dir, module: require(dir + "/" + name + ".node") }
 * ```
 *
 * That path is computed from `process.platform`, so no bundler — esbuild, webpack, ncc,
 * or Bun's `--compile` — can resolve it statically. Marking node-pty external and
 * copying its tree next to the output is not a workaround, it is the only correct
 * answer, and it is why PHASE-5 rules out a single-file executable.
 *
 * The output layout is therefore:
 *
 * ```
 * dist-app/
 *   leap-chorusd.js        the daemon, bundled
 *   leap-chorus.js         the client, bundled
 *   node_modules/node-pty/ the package, with only the prebuild for this slot
 * ```
 *
 * `require('node-pty')` from `leap-chorusd.js` resolves by ordinary Node lookup, and
 * node-pty then finds `prebuilds/<platform>-<arch>/pty.node` relative to itself.
 */

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist-app')
const require_ = createRequire(import.meta.url)

/** Everything node-pty needs at runtime, and nothing it needs only to build. */
const NODE_PTY_KEEP = ['package.json', 'lib', 'LICENSE', 'README.md']

/**
 * Files inside a prebuild directory that are not needed to run it.
 *
 * `.pdb` files are Windows debug symbols and are most of the download: keeping every
 * prebuild for every platform took the tree from 4 MB to 62 MB, for binaries that
 * cannot load on the slot being shipped anyway.
 */
const PREBUILD_DROP = /\.(pdb|exp|lib)$/iu

export function nodePtyRoot() {
  // Resolved through Node rather than guessed: pnpm's layout is a symlink farm, and
  // node-pty is a dependency of the *daemon*, not of the workspace root — so the
  // lookup has to start from the package that actually declares it.
  const fromDaemon = createRequire(join(root, 'packages/daemon/package.json'))
  return dirname(fromDaemon.resolve('node-pty/package.json'))
}

/**
 * The platform slots we ship.
 *
 * Six, not four: "Linux x64" is two targets, because a glibc `.node` does not load on
 * Alpine. The libc label comes from the container that built the slot, never from
 * runtime detection — a binary does not get to be wrong about its own libc.
 */
export const SLOTS = [
  { id: 'linux-x64-glibc', platform: 'linux', arch: 'x64', libc: 'glibc' },
  { id: 'linux-arm64-glibc', platform: 'linux', arch: 'arm64', libc: 'glibc' },
  { id: 'linux-x64-musl', platform: 'linux', arch: 'x64', libc: 'musl' },
  { id: 'linux-arm64-musl', platform: 'linux', arch: 'arm64', libc: 'musl' },
  { id: 'darwin-x64', platform: 'darwin', arch: 'x64', libc: null },
  { id: 'darwin-arm64', platform: 'darwin', arch: 'arm64', libc: null }
]

export function hostSlot() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `darwin-${arch}`
  // A host build on Linux is labelled by what this Node was linked against, which is
  // the closest thing to a truthful answer outside a container.
  const libc = process.report?.getReport?.()?.header?.glibcVersionRuntime === undefined ? 'musl' : 'glibc'
  return `linux-${arch}-${libc}`
}

async function bundleEntry(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    // Node 22 is the floor (`engines.node`), so nothing below it needs downlevelling.
    target: 'node22',
    // ESM, and not CJS, because the app depends on `import.meta.url` being real:
    // `resolveDaemonEntry` finds the daemon beside the client with it, and both
    // entrypoints use it to decide whether they were run directly. A CJS bundle
    // silently empties it — esbuild warns, and the app then cannot find its daemon.
    // node-pty stays external and CommonJS; Node imports a CJS module from ESM fine.
    format: 'esm',
    external: ['node-pty'],
    // `@xterm/headless` is pure JS and bundles fine; it is the only other dependency.
    minify: false,
    sourcemap: 'linked',
    logLevel: 'warning'
    // No shebang banner: both entrypoints already carry one in their source, and
    // esbuild preserves it. Adding another puts `#!` on line 2, where it is a syntax
    // error rather than a comment.
  })
}

/**
 * Copy only the prebuild the target slot can load.
 *
 * A tarball carrying four platforms' binaries is four times the download and three
 * times the attack surface, and the three it cannot load are indistinguishable from
 * the one it can until something tries. `build/Release` is copied too when present,
 * because that is where a source build puts its output and node-pty looks there first.
 */
function copySlotPrebuild(source, target, slot) {
  const { platform, arch } = SLOTS.find((entry) => entry.id === slot) ?? {}
  if (platform === undefined) throw new Error(`unknown slot ${slot}`)
  const name = `${platform}-${arch}`
  const from = join(source, 'prebuilds', name)
  if (!existsSync(from)) {
    // Upstream node-pty 1.1.0 ships no Linux prebuilds at all (checked 2026-09-19):
    // only darwin-arm64, darwin-x64, win32-arm64, win32-x64. A Linux slot's binary is
    // built in its own container and dropped in by the release workflow, so this is a
    // warning during a host build and a hard failure in CI.
    console.warn(`warning: no prebuild for ${name}; this tarball will not run on ${slot}`)
    return
  }
  mkdirSync(join(target, 'prebuilds', name), { recursive: true })
  for (const file of readdirSync(from)) {
    if (PREBUILD_DROP.test(file)) continue
    cpSync(join(from, file), join(target, 'prebuilds', name, file), { recursive: true })
  }
  const release = join(source, 'build', 'Release')
  if (existsSync(release)) cpSync(release, join(target, 'build', 'Release'), { recursive: true })
}

export async function buildApp({ clean = true, slot = hostSlot() } = {}) {
  if (clean) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  await bundleEntry(join(root, 'packages/daemon/dist/main.js'), join(outDir, 'leap-chorusd.js'))
  await bundleEntry(join(root, 'packages/client/dist/main.js'), join(outDir, 'leap-chorus.js'))

  // node-pty, minus its build inputs and minus every prebuild but this slot's.
  const source = nodePtyRoot()
  const target = join(outDir, 'node_modules', 'node-pty')
  mkdirSync(target, { recursive: true })
  for (const entry of NODE_PTY_KEEP) {
    try {
      cpSync(join(source, entry), join(target, entry), { recursive: true })
    } catch {
      // Optional files; a missing README is not a failed build.
    }
  }
  copySlotPrebuild(source, target, slot)

  // The notification sounds, beside the bundle. `sound.ts` walks up from its own file
  // to find `assets/sounds`, which is the same lookup that finds them in a source
  // checkout and in the tarball's `lib/` — so this copy is all the packaging needs.
  cpSync(join(root, 'assets', 'sounds'), join(outDir, 'assets', 'sounds'), { recursive: true })

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  writeFileSync(
    join(outDir, 'package.json'),
    // `type: module` is load-bearing, not tidiness: the bundles are ESM, and without
    // it Node reads a `.js` file as CommonJS and dies on the first `import`.
    `${JSON.stringify(
      { name: 'leap-chorus', version, private: true, type: 'module', bin: { 'leap-chorus': './leap-chorus.js' } },
      null,
      2
    )}\n`
  )
  return outDir
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const slotArg = process.argv.indexOf('--slot')
  const slot = slotArg === -1 ? hostSlot() : process.argv[slotArg + 1]
  await buildApp({ slot })
  console.log(`built ${outDir} for ${slot}`)
}
