/**
 * The identity palette: one stable colour per workspace.
 *
 * ## The rule this file exists to enforce
 *
 * **Hue is identity. Fill and weight are state.** Before this, every workspace in the
 * strip was the same grey and every agent's dot was coloured by its status — so a list
 * of four agents gave no way to tell which project any of them belonged to without
 * reading the dim second line, and the one question the list exists to answer ("which
 * of my things needs me") was answered by the same colour on every row.
 *
 * A workspace gets a colour here; its agents borrow it. Status keeps the *shape* of its
 * dot and the colour of the state word, and gives up the hue.
 *
 * ## Derived, never configured
 *
 * There is no `[theme] workspace-1 = 214`. A colour per workspace would be a settings
 * page nobody asked for, and it would have to be re-typed every time a workspace was
 * created. The colour comes from the workspace **id**, which is what survives a restart
 * — `persist.ts` writes the id and `restoreSession` reads it back unchanged — and which
 * has nothing to do with the order the strip happens to list things in.
 *
 * ## 256-colour cube, and no red
 *
 * Everything else in this project draws in the 256-colour cube, so this does too: no
 * truecolor, which a terminal may not have and which a user's own palette cannot
 * retheme. **None of the eight is red.** Red is `agent-blocked`, the one colour in the
 * program that means "this is waiting on you", and a workspace that happened to hash to
 * red would spend its whole life looking urgent.
 */

/**
 * The eight hues, spaced roughly evenly around the wheel.
 *
 * | index | cube | colour     |
 * |-------|------|------------|
 * | 0     | 39   | azure      |
 * | 1     | 43   | teal       |
 * | 2     | 77   | green      |
 * | 3     | 220  | yellow     |
 * | 4     | 208  | orange     |
 * | 5     | 205  | pink       |
 * | 6     | 135  | violet     |
 * | 7     | 180  | tan        |
 *
 * All eight are mid-to-bright, so they read on the card tint the sidebar draws them on
 * as well as on a terminal's own background.
 */
export const WORKSPACE_HUES: readonly number[] = [39, 43, 77, 220, 208, 205, 135, 180]

/**
 * FNV-1a, 32-bit.
 *
 * Any stable hash would do; this one is four lines, has no dependency, and spreads the
 * short ids this project generates (`w1`, `w-3f2a91`) across the whole word rather than
 * clustering them the way a sum of char codes would.
 */
export function hashId(id: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    // The FNV prime, 16777619, as shifts: `hash * prime` overflows a JS number into
    // imprecision, and `Math.imul` is the same thing written less obviously.
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The hue a workspace id prefers, before anyone else has claimed it. */
export function workspaceHue(id: string): number {
  return WORKSPACE_HUES[hashId(id) % WORKSPACE_HUES.length] as number
}

/**
 * A hue for every workspace on screen, with collisions resolved.
 *
 * A bare hash would be perfectly stable and frequently useless: with eight hues and four
 * workspaces, the birthday bound says **two of them share a colour 59% of the time**,
 * and a palette that fails more often than it works is not a channel. So the ids are
 * walked in sorted order and each takes its preferred hue, or the next free one — which
 * makes every workspace's hue distinct for as long as there are at most eight of them.
 *
 * **Sorted by id, deliberately, not in display order.** The result then depends only on
 * the *set* of workspaces, so it survives both things the design has to survive:
 *
 * - a **restart**, because the ids are persisted and come back unchanged;
 * - a **reorder**, because `workspaceOrder` is not consulted at all.
 *
 * What it does not survive is *creating or closing* a workspace whose id collides with
 * an existing one — that workspace's neighbour may move one hue along. That is the price
 * of distinctness, and it is the right way round: a colour that is always unique and
 * occasionally shifts is more use than one that never moves and is a coin flip.
 *
 * Past eight workspaces the probe runs out of free slots and hues repeat, in id order.
 */
export function workspaceHues(ids: readonly string[]): Map<string, number> {
  const count = WORKSPACE_HUES.length
  const taken = new Set<number>()
  const assigned = new Map<string, number>()
  for (const id of [...new Set(ids)].sort()) {
    let slot = hashId(id) % count
    for (let probe = 0; probe < count && taken.has(slot); probe++) slot = (slot + 1) % count
    taken.add(slot)
    assigned.set(id, WORKSPACE_HUES[slot] as number)
  }
  return assigned
}
