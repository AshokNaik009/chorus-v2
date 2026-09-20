/**
 * `@leap-chorus/detect` — which agent is in a pane, and what it is doing.
 *
 * The manifest design is herdr's (`src/detect/`, Apache-2.0); the mechanics for reading
 * the host are orca's (`src/shared/process-table-*`, MIT). Neither project's plumbing
 * came with it: herdr reads Ghostty, orca reads Electron, and this reads
 * `@xterm/headless` text plus one shared `ps`.
 */

export * from './agents.js'
export * from './bundled.js'
export * from './detector.js'
export * from './manifest.js'
export * from './process-table.js'
export * from './regex.js'
export * from './regions.js'
export * from './registry.js'
