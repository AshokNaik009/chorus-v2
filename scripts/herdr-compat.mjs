#!/usr/bin/env node
/**
 * The `$HERDR_BIN_PATH` shim, for a source checkout.
 *
 * **This is not herdr.** It is a wrapper that translates the handful of commands a
 * herdr plugin's launcher scripts call into `leap-chorus` ones. PHASE-10's fourth
 * decision was that shipping a binary *named* `herdr` which is not herdr would mislead
 * somebody eventually, so the compatibility surface is a flag on our own binary
 * (`leap-chorus --compat herdr …`) and this is the wrapper that points at it.
 *
 * ## You probably do not need this file
 *
 * `leap-chorus plugin …` writes an equivalent `sh` wrapper to
 * `<data-root>/plugins/bin/herdr-compat` and that is what the daemon actually sets
 * `$HERDR_BIN_PATH` to. This copy exists for the case the generated one cannot cover:
 * driving a plugin's launcher by hand against a source checkout, before anything is
 * built or installed. Run it as:
 *
 * ```sh
 * HERDR_BIN_PATH=$PWD/scripts/herdr-compat.mjs ./some-plugin/scripts/launch.sh
 * ```
 *
 * It resolves the client's built entry point, because the shim runs from inside a
 * plugin's process and cannot assume a working directory.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const built = join(here, '..', 'packages', 'client', 'dist', 'main.js')
const entry = process.env['LEAP_CHORUS_CLIENT'] ?? built

if (!existsSync(entry)) {
  process.stderr.write(
    `herdr-compat: no leap-chorus client at ${entry}\n` +
      'Run `pnpm build`, or point $LEAP_CHORUS_CLIENT at the built main.js.\n'
  )
  process.exit(1)
}

const { main } = await import(pathToFileURL(entry).href)
process.exitCode = await main(['--compat', 'herdr', ...process.argv.slice(2)])
