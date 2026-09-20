import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Why the detection poll is off for the suite.
 *
 * Every `DaemonServer` starts a 750 ms poll that forks `ps` over the whole process
 * table. Tests run in a single fork (see `poolOptions`), so a suite building dozens of
 * servers has dozens of those intervals in one worker process, each fork copying that
 * worker's page tables on a host with ~800 processes. It is work the suite has no
 * reason to do.
 *
 * Turning it off costs no coverage. No *timer* is under test: the tests that care call
 * `SessionRuntime.detectOnce()` directly, which is why that method is public, and
 * `daemon/test/agents.test.ts` injects its own `ProcessTable` to count captures.
 *
 * A data-root guard was tried here first and was actively harmful: pointing every test
 * at one `LEAP_CHORUS_DATA_DIR` made unrelated files contend for a single instance
 * lock. Each harness already makes its own temp root.
 *
 * ## What this does *not* explain
 *
 * Phase 5 saw the suite take 649-1913 s against phase 4's 64 s, with PTY tests timing
 * out at random. It is tempting to blame the poll, and that attribution was written
 * here and then removed, because the measurement said otherwise: the slow runs used
 * ~49 s of CPU over 970 s of wall clock — 5% — on a machine whose load average was 6-10
 * with an unrelated system process pinned at 100%. The suite was starved, not slow. Do
 * not read a timing from this suite without checking `uptime` first.
 */

// Tests import workspace packages by name but run against TypeScript sources, so a
// source edit needs no rebuild. Runtime (the detached daemon) uses the built dist/.
export default defineConfig({
  resolve: {
    alias: {
      '@leap-chorus/protocol': fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url)),
      '@leap-chorus/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@leap-chorus/config-loader': fileURLToPath(new URL('./packages/config-loader/src/index.ts', import.meta.url)),
      '@leap-chorus/detect': fileURLToPath(new URL('./packages/detect/src/index.ts', import.meta.url)),
      '@leap-chorus/daemon': fileURLToPath(new URL('./packages/daemon/src/index.ts', import.meta.url)),
      '@leap-chorus/input': fileURLToPath(new URL('./packages/input/src/index.ts', import.meta.url)),
      '@leap-chorus/tui': fileURLToPath(new URL('./packages/tui/src/index.ts', import.meta.url)),
      '@leap-chorus/client': fileURLToPath(new URL('./packages/client/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    env: { LEAP_CHORUS_DETECT_INTERVAL_MS: '0' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // PTY and daemon integration tests bind sockets and spawn processes; keep them serial.
    poolOptions: { forks: { singleFork: true } }
  }
})
