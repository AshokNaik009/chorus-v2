/**
 * Identity.
 *
 * Ids are supplied rather than generated, because `core` has no dependencies and
 * therefore no `crypto` — and because a test that cannot predict the next id cannot
 * assert on a layout tree. Production passes a random source; tests pass a counter and
 * get `p1`, `p2`, `t1`.
 *
 * herdr uses a `u32` counter per kind with a public per-workspace *number* shown in the
 * UI. Both concepts survive here and stay distinct: the id is the identity and never
 * changes, the number is a label and is reassigned as things are created and closed.
 */

export type IdKind = 'workspace' | 'tab' | 'pane'

export interface IdSource {
  next(kind: IdKind): string
}

const PREFIX: Record<IdKind, string> = { workspace: 'w', tab: 't', pane: 'p' }

/** Deterministic ids: `w1`, `t1`, `p1`, counted per kind. For tests and for restore. */
export class CounterIds implements IdSource {
  private readonly counters = new Map<IdKind, number>()

  constructor(start: Partial<Record<IdKind, number>> = {}) {
    for (const [kind, value] of Object.entries(start)) {
      this.counters.set(kind as IdKind, value)
    }
  }

  next(kind: IdKind): string {
    const value = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, value)
    return `${PREFIX[kind]}${value}`
  }

  /** Bump the counter past ids already in use, so a restore cannot collide. */
  reserve(id: string): void {
    const match = /^([wtp])(\d+)$/u.exec(id)
    if (!match) return
    const kind = (Object.keys(PREFIX) as IdKind[]).find((key) => PREFIX[key] === match[1])
    if (kind === undefined) return
    const value = Number.parseInt(match[2] as string, 10)
    if (value > (this.counters.get(kind) ?? 0)) this.counters.set(kind, value)
  }
}

/**
 * Ids with a random suffix, for a daemon whose state outlives any one counter.
 *
 * The random source is injected for the same reason the ids are: `core` cannot import
 * `node:crypto`. The daemon passes one backed by it.
 */
export class RandomIds implements IdSource {
  constructor(private readonly random: () => string) {}

  next(kind: IdKind): string {
    return `${PREFIX[kind]}-${this.random()}`
  }
}
