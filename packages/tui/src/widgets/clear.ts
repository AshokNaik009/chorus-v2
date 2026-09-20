/** Blank a region. The smallest widget there is, and the one every other one starts with. */

import type { ScreenBuffer } from '../buffer.js'
import { DEFAULT_STYLE, type Style } from '../cell.js'
import type { Rect } from '../rect.js'

export function renderClear(buffer: ScreenBuffer, area: Rect, style: Style = DEFAULT_STYLE): void {
  buffer.fill(area, ' ', style)
}
