import { common, createLowlight } from 'lowlight'
import { ATTR_BOLD, ATTR_DIM, ScreenBuffer, stringWidth, type Style } from '@leap-chorus/tui'
import type { Palette } from './chrome.js'

export interface CodeSpan {
  readonly text: string
  readonly token: string
}

export interface CodeRow {
  readonly line: number
  readonly continuation: boolean
  readonly spans: readonly CodeSpan[]
}

type Node = { type: string; value?: string; properties?: { className?: unknown }; children?: Node[] }
const highlighter = createLowlight(common)
const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', py: 'python', rs: 'rust', go: 'go', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', html: 'xml', xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  markdown: 'markdown', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java',
  rb: 'ruby', php: 'php', diff: 'diff', patch: 'diff', toml: 'ini'
}

export class CodeDocument {
  readonly lines: readonly (readonly CodeSpan[])[]
  readonly highlighted: boolean
  private readonly cache = new Map<number, CodeRow[]>()

  constructor(path: string, lines: readonly string[], highlight = true) {
    const plain = lines.map((text) => [{ text: text.replace(/\t/gu, '    '), token: '' }])
    const language = LANGUAGES[path.split('.').at(-1)?.toLowerCase() ?? '']
    const source = lines.join('\n')
    let painted: CodeSpan[][] | null = null
    if (highlight && language !== undefined && source.length <= 65_536) {
      try {
        const root = highlighter.highlight(language, source)
        const rows: CodeSpan[][] = [[]]
        const visit = (node: Node, inherited: string): void => {
          const classes = node.properties?.className
          const token = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('hljs-')) ?? inherited : inherited
          if (node.type === 'text') {
            const parts = (node.value ?? '').replace(/\t/gu, '    ').split('\n')
            parts.forEach((text, index) => {
              if (index > 0) rows.push([])
              if (text) rows.at(-1)?.push({ text, token: String(token) })
            })
          }
          for (const child of node.children ?? []) visit(child, String(token))
        }
        visit(root, '')
        if (rows.length === lines.length) painted = rows
      } catch {}
    }
    this.lines = painted ?? plain
    this.highlighted = painted !== null
  }

  rows(width: number, wrap: boolean): CodeRow[] {
    width = Math.max(1, width)
    const key = wrap ? width : 0
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const rows: CodeRow[] = []
    this.lines.forEach((spans, index) => {
      if (!wrap) {
        rows.push({ line: index + 1, continuation: false, spans })
        return
      }
      let current: CodeSpan[] = []
      let columns = 0
      let continuation = false
      const flush = (): void => {
        rows.push({ line: index + 1, continuation, spans: current })
        current = []
        columns = 0
        continuation = true
      }
      for (const span of spans) {
        for (const char of span.text) {
          const size = stringWidth(char)
          if (columns > 0 && columns + size > width) flush()
          const previous = current.at(-1)
          if (previous?.token === span.token) current[current.length - 1] = { text: previous.text + char, token: span.token }
          else current.push({ text: char, token: span.token })
          columns += size
        }
      }
      flush()
    })
    this.cache.set(key, rows)
    if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value as number)
    return rows
  }
}

function tokenStyle(token: string, palette: Palette): Style {
  const base = palette.sidebar
  if (/comment|quote/u.test(token)) return { ...base, fg: palette.agent['idle']?.fg ?? base.fg, attrs: base.attrs | ATTR_DIM }
  if (/keyword|built_in|type|tag/u.test(token)) return { ...base, fg: palette.focusBorder?.fg ?? 6, attrs: base.attrs | ATTR_BOLD }
  if (/string|regexp|addition/u.test(token)) return { ...base, fg: palette.agent['done']?.fg ?? 2 }
  if (/number|literal|attr|symbol/u.test(token)) return { ...base, fg: palette.agent['working']?.fg ?? 3 }
  if (/deletion/u.test(token)) return { ...base, fg: palette.agent['blocked']?.fg ?? 1 }
  if (/title|section|name/u.test(token)) return { ...base, fg: palette.paneTitle?.fg ?? 6, attrs: base.attrs | ATTR_BOLD }
  return base
}

export function drawCodeRow(buffer: ScreenBuffer, x: number, y: number, width: number, row: CodeRow, column: number, palette: Palette): void {
  let used = 0
  for (const span of row.spans) {
    let shown = ''
    let start = 0
    let full = false
    for (const char of span.text) {
      const size = stringWidth(char)
      const position = used - column
      used += size
      if (position < 0) continue
      if (position + size > width) { full = true; break }
      if (shown === '') start = position
      shown += char
    }
    if (shown) buffer.writeString(x + start, y, shown, tokenStyle(span.token, palette), x + width)
    if (full) return
  }
}
