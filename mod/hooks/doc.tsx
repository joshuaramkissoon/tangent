import type { ClientModule, ClientPointerEvent, ClientKeyEvent, JsonValue } from 'claude-code'

import type { DocProps, Note } from '../types'

// The doc and its notes, drawn cell by cell so the module knows where every word is: a drag selects
// words here (not the terminal), and Explain / Ask / Deeper are drawn on the row under them.

type Style = { bold?: true; italic?: true; code?: true; link?: true; strike?: true; underline?: true; dim?: true; color?: string }
type Span = { text: string; style: Style }
type Hit = { x0: number; x1: number; post: JsonValue | 'ask' | 'comment' | 'submit' | 'cancel' | 'hide' }
// One drawn row: its spans, where its selectable text starts, the note it belongs to, and whether
// it carries on a wrapped line (so a selection over it joins with a space, not a newline).
// `end`, where set, is where its selectable text stops (a note card's right border follows).
type Row = { spans: Span[]; text: string; from: number; end?: number; note?: string; soft?: boolean; hits?: Hit[] }

type At = { r: number; c: number }
// The selection (anchor and focus), the field open for a question or a comment, and the action under
// the pointer (by drawn row and its place in that row's hits), drawn lit as a button is on hover.
type State = {
  a: At | null
  f: At | null
  dragging: boolean
  asking: false | 'ask' | 'comment'
  draft: string
  last: { at: At; t: number } | null
  hover: { y: number; i: number } | null
}

const BLANK: State = { a: null, f: null, dragging: false, asking: false, draft: '', last: null, hover: null }

// Blocks are split at blank lines, a fenced code block staying whole. (The hooks module keeps the same
// split to see which blocks an edit changed; the two live in separate environments.)
function blocksOf(text: string): string[] {
  const out: string[] = []
  let cur: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && line.trim() === '') {
      if (cur.length) out.push(cur.join('\n'))
      cur = []
    } else cur.push(line)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+/
function unitsOf(block: string): string[] {
  const lines = block.split('\n')
  if (!ITEM.test(lines[0] ?? '')) return [block]
  const out: string[] = []
  for (const line of lines) {
    if (ITEM.test(line) || !out.length) out.push(line)
    else out[out.length - 1] += '\n' + line
  }
  return out
}

const bare = (s: string) => s.replace(/[`*_#>|~\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Inline marks become styles: **bold**, *italic*, `code`, [links](url), ~~struck~~.
function inline(src: string, base: Style = {}): Span[] {
  const out: Span[] = []
  const re = /(\*\*|__)(.+?)\1|(?<![\w*])\*(?!\s)(.+?)\*(?!\w)|(?<!\w)_(?!\s)(.+?)_(?!\w)|`([^`]+)`|\[([^\]]+)\]\([^)]*\)|~~(.+?)~~/g
  let at = 0
  for (const m of src.matchAll(re)) {
    if (m.index! > at) out.push({ text: src.slice(at, m.index), style: base })
    if (m[2] !== undefined) out.push(...inline(m[2], { ...base, bold: true }))
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...inline((m[3] ?? m[4])!, { ...base, italic: true }))
    else if (m[5] !== undefined) out.push({ text: m[5], style: { ...base, code: true } })
    else if (m[6] !== undefined) out.push({ text: m[6], style: { ...base, link: true } })
    else if (m[7] !== undefined) out.push({ text: m[7], style: { ...base, strike: true } })
    at = m.index! + m[0].length
  }
  if (at < src.length) out.push({ text: src.slice(at), style: base })
  return out
}

// Words wrapped to the width; the first row starts with `lead`, the rest with `hang`.
function wrap(spans: Span[], width: number, lead: Span[], hang: Span[], note?: string): Row[] {
  const chars: { ch: string; style: Style }[] = []
  for (const s of spans) for (const ch of s.text.replace(/\s+/g, ' ')) chars.push({ ch, style: s.style })
  while (chars.length && chars[0]!.ch === ' ') chars.shift()
  const rows: Row[] = []
  let i = 0
  let first = true
  do {
    const pre = first ? lead : hang
    const preLen = pre.reduce((n, s) => n + s.text.length, 0)
    const room = Math.max(8, width - preLen)
    let end = Math.min(chars.length, i + room)
    if (end < chars.length) {
      let sp = end
      while (sp > i && chars[sp]!.ch !== ' ') sp--
      if (sp > i) end = sp
    }
    rows.push(rowOf([...pre, ...pack(chars.slice(i, end))], preLen, note, !first))
    i = end
    while (i < chars.length && chars[i]!.ch === ' ') i++
    first = false
  } while (i < chars.length)
  return rows
}

function pack(chars: { ch: string; style: Style }[]): Span[] {
  const out: Span[] = []
  for (const { ch, style } of chars) {
    const last = out[out.length - 1]
    if (last && last.style === style) last.text += ch
    else out.push({ text: ch, style })
  }
  return out
}

const rowOf = (spans: Span[], from: number, note?: string, soft?: boolean): Row => ({
  spans,
  text: spans.map(s => s.text).join(''),
  from,
  note,
  soft,
})

const plain = (text: string, style: Style = {}): Span => ({ text, style })

// A table wider than the pane becomes one entry per row, each cell named by its column.
function fitTable(block: string, width: number): string | null {
  const lines = block.split('\n')
  if (!lines.every(l => l.trim().startsWith('|'))) return null
  if (Math.max(...lines.map(l => l.length)) <= width) return block
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const [head, , ...rest] = lines
  const names = cells(head ?? '')
  return rest
    .map(r => {
      const [first, ...more] = cells(r)
      const parts = more.map((c, k) => `${names[k + 1] ?? ''}: ${c}`).filter(p => !p.endsWith(': '))
      return `- **${first}** · ${parts.join(' · ')}`
    })
    .join('\n')
}

// One unit of markdown (a paragraph, a list item, a heading, a fence, a table) as rows.
function unitRows(src: string, width: number, gutter: Span[], note?: string): Row[] {
  const g = gutter
  const lines = src.split('\n')
  const head = /^(#{1,6})\s+(.*)$/.exec(lines[0] ?? '')
  if (head && lines.length === 1) {
    const level = head[1]!.length
    return wrap(inline(head[2]!, { bold: true, color: level <= 2 ? 'claude' : undefined }), width, g, g, note)
  }
  if (/^\s*(```|~~~)/.test(lines[0] ?? '')) {
    const body = lines.slice(1, /^\s*(```|~~~)/.test(lines[lines.length - 1] ?? '') && lines.length > 1 ? -1 : undefined)
    const w = Math.max(8, width - 2 - g.reduce((n, s) => n + s.text.length, 0))
    return body.map(l => {
      const cut = l.replace(/\t/g, '  ')
      const pre = [...g, plain('  ')]
      return rowOf([...pre, plain(cut.length > w ? cut.slice(0, w - 1) + '…' : cut, { code: true })], pre.reduce((n, s) => n + s.text.length, 0), note)
    })
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(src)) {
    return [rowOf([...g, plain('─'.repeat(Math.max(1, width - g.reduce((n, s) => n + s.text.length, 0))), { dim: true })], width, note)]
  }
  if (lines.every(l => l.trim().startsWith('|'))) {
    const fit = fitTable(src, width - g.reduce((n, s) => n + s.text.length, 0))
    if (fit && fit !== src) return unitsOf(fit).flatMap(u => unitRows(u, width, g, note))
    return lines
      .filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
      .map((l, k) => {
        const pre = g.reduce((n, s) => n + s.text.length, 0)
        return rowOf([...g, ...inline(l.trim().replace(/\|/g, '│'), k === 0 ? { bold: true } : {})], pre, note)
      })
  }
  if (lines.every(l => l.startsWith('>'))) {
    const text = lines.map(l => l.replace(/^>\s?/, '')).join(' ')
    return wrap(inline(text, { italic: true }), width, [...g, plain('│ ', { dim: true })], [...g, plain('│ ', { dim: true })], note)
  }
  const item = ITEM.exec(lines[0] ?? '')
  if (item) {
    const depth = Math.floor(item[1]!.length / 2)
    const mark = /\d/.test(item[2]!) ? `${item[2]} ` : '• '
    const pad = '  '.repeat(depth)
    const text = [lines[0]!.slice(item[0].length), ...lines.slice(1).map(l => l.trim())].join(' ')
    return wrap(inline(text), width, [...g, plain(pad), plain(mark, { dim: true })], [...g, plain(pad + ' '.repeat(mark.length))], note)
  }
  return wrap(inline(lines.join(' ')), width, g, g, note)
}

const len = (spans: Span[]) => spans.reduce((k, s) => k + s.text.length, 0)

// A note is a card set apart from the doc: its kind and words in the top border, the answer inside,
// and what can be done with it in the bottom border. Notes on a note follow as cards indented under it.
function noteRows(n: Note, all: Note[], width: number, depth: number): Row[] {
  const isComment = n.kind === 'comment'
  // A comment is drawn in the accent colour that marks what goes to Claude.
  const edge = (s: string): Span => plain(s, { color: isComment ? 'claude' : 'magenta' })
  const pad = plain('  '.repeat(depth + 1))
  const outer = Math.max(24, width - pad.text.length)
  const inner = outer - 4
  const kind = isComment ? '✎ Comment' : n.kind === 'ask' ? '? Ask' : n.kind === 'deeper' ? '↓ Deeper' : '› Explain'
  const kids = all.filter(x => x.parent === n.id)
  // The title folds and unfolds the card.
  const title = [plain(` ${n.collapsed ? '▸' : '▾'} ${kind} `, { bold: true }), plain(`“${short(n.quote, Math.max(8, Math.floor(inner / 2) - kind.length))}”`, { dim: true })]
  const toggle = (x0: number): Hit => ({ x0, x1: x0 + len(title), post: { type: 'toggle', id: n.id } })

  // Folded: one row, the start of the answer (and how many notes hang off it) dimmed after the title.
  if (n.collapsed) {
    const head = [pad, edge('╶─'), ...title]
    const more = kids.length ? ` +${kids.length}` : ''
    const room = outer - (len(head) - pad.text.length) - more.length - 5
    const said = (isComment ? n.question : n.answer) ?? n.error ?? ''
    const preview = room > 6 && said ? ` ${short(said, room)}` : ''
    const fill = Math.max(1, outer - (len(head) - pad.text.length) - preview.length - more.length - 1)
    return [{ ...rowOf([...head, plain(preview, { dim: true }), plain(more, { dim: true }), edge(' ' + '─'.repeat(fill - 1) + '╴')], 9999, n.id), hits: [toggle(len(head) - len(title))] }]
  }

  const top = [pad, edge('╭─'), ...title, plain(' ')]
  const rows: Row[] = [
    { ...rowOf([...top, edge('─'.repeat(Math.max(1, outer - len(top) + pad.text.length - 1)) + '╮')], 9999, n.id), hits: [toggle(pad.text.length + 2)] },
  ]

  // Each row of the answer between the side borders, padded out so the right border lines up.
  const inside = (r: Row): Row => {
    const lead = [pad, edge('│ ')]
    const body = len(lead)
    return {
      ...rowOf([...lead, ...r.spans, plain(' '.repeat(Math.max(0, inner - r.text.length))), edge(' │')], body + Math.min(r.from, inner), n.id, r.soft),
      end: body + r.text.length,
    }
  }
  if (n.kind === 'ask' && n.question) {
    for (const r of wrap([plain(n.question, { italic: true, dim: true })], inner, [], [])) rows.push({ ...inside(r), from: 9999 })
    rows.push({ ...inside(rowOf([], 0)), from: 9999 })
  }
  const text = isComment ? n.question : n.answer
  if (text) {
    blocksOf(text).forEach((b, k) => {
      if (k > 0) rows.push({ ...inside(rowOf([], 0)), from: 9999 })
      for (const u of unitsOf(b)) for (const r of unitRows(u, inner, [])) rows.push(inside(r))
    })
  } else rows.push({ ...inside(rowOf([plain(n.error ?? 'thinking…', { dim: true, italic: true })], 0)), from: 9999 })

  // Only a comment can go to Claude; an answer is the reader's.
  const actions: [string, JsonValue][] = isComment
    ? [['Send to Claude', { type: 'send', id: n.id }], ['Remove', { type: 'remove', id: n.id }]]
    : [['Remove', { type: 'remove', id: n.id }]]
  const bottom: Span[] = [pad, edge('╰─')]
  const hits: Hit[] = []
  for (const [label, post] of actions) {
    bottom.push(plain(' '))
    hits.push({ x0: len(bottom), x1: len(bottom) + label.length, post })
    bottom.push(plain(label, { underline: true }), plain(' '), edge('─'))
  }
  const fill = Math.max(1, outer - (len(bottom) - pad.text.length) - 2)
  bottom.push(edge('─'.repeat(fill)), edge('─╯'))
  rows.push({ ...rowOf(bottom, 9999, n.id), hits })
  for (const k of kids) rows.push(...noteRows(k, all, width, depth + 1))
  return rows
}

// The whole drawing as rows: each block's units, the notes placed under the unit holding their words,
// and the notes whose words aren't in the doc at the end.
function layout(p: DocProps, width: number): Row[] {
  const rows: Row[] = []
  const blocks = blocksOf(p.text)
  const units = blocks.map(unitsOf)
  const placed = new Map<string, Note[]>()
  const loose: Note[] = []
  for (const n of p.notes.filter(x => !x.parent)) {
    const q = bare(n.quote).slice(0, 200)
    let at: string | null = null
    for (let i = 0; i < units.length && !at && q; i++) {
      const j = units[i]!.findIndex(u => bare(u).includes(q))
      if (j >= 0) at = `${i}:${j}`
    }
    if (at) placed.set(at, [...(placed.get(at) ?? []), n])
    else loose.push(n)
  }
  const changed = new Set(p.changed)
  blocks.forEach((b, i) => {
    if (i > 0) rows.push(rowOf([], 0))
    if (changed.has(b)) rows.push(rowOf([plain('✎ updated', { color: 'green' })], 9999))
    units[i]!.forEach((u, j) => {
      rows.push(...unitRows(u, width, []))
      const here = placed.get(`${i}:${j}`) ?? []
      // A line of space either side of the cards; the blank between blocks serves after the last item.
      if (here.length) rows.push(rowOf([], 0))
      for (const n of here) rows.push(...noteRows(n, p.notes, width, 0))
      if (here.length && j < units[i]!.length - 1) rows.push(rowOf([], 0))
    })
  })
  if (loose.length) {
    if (blocks.length) rows.push(rowOf([], 0), rowOf([plain('Notes', { dim: true })], 9999))
    for (const n of loose) rows.push(...noteRows(n, p.notes, width, 0))
  }
  if (!rows.length) rows.push(rowOf([plain('Select any text in the conversation, then Explain, Ask or Deeper. /tangent file.md opens a doc here.', { dim: true })], 9999))
  return rows
}

const before = (x: At, y: At) => x.r < y.r || (x.r === y.r && x.c <= y.c)
const ordered = (s: State): [At, At] | null => (s.a && s.f ? (before(s.a, s.f) ? [s.a, s.f] : [s.f, s.a]) : null)

// The selected words, from the rows as drawn: wrapped rows join with a space, others with a newline.
function selectedText(rows: Row[], [a, b]: [At, At]): string {
  let out = ''
  for (let r = a.r; r <= b.r; r++) {
    const row = rows[r]
    if (!row) continue
    const from = Math.max(row.from, r === a.r ? a.c : 0)
    const to = Math.min(row.end ?? row.text.length, r === b.r ? b.c + 1 : row.text.length)
    const piece = row.text.slice(from, to)
    if (r > a.r) out += row.soft ? ' ' : '\n'
    out += piece
  }
  return out.replace(/[ \t]+\n/g, '\n').trim()
}

// Keys that arrive by name rather than as the characters they type.
const NAMED = new Set(['up', 'down', 'left', 'right', 'return', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape', 'insert'])

const isWord =(ch: string | undefined) => !!ch && /[\p{L}\p{N}_'’-]/u.test(ch)

const Doc: ClientModule<DocProps, State> = (p, surface) => {
  const { Box, Text } = surface.elements
  const s = surface.state ?? BLANK
  const width = Math.max(20, surface.columns || p.columns)
  const rows = layout(p, width)
  const span = ordered(s)
  const picked = span && !s.dragging ? selectedText(rows, span) : ''
  const parent = span ? rows[span[0].r]?.note : undefined

  // The actions sit on the row under the selection's last row: only what follows them moves.
  const STRIP = ['Explain', 'Ask…', 'Deeper', 'Comment…', '×'] as const
  let strip: Row | null = null
  if (picked) {
    const lead = '✦ '
    if (s.asking) {
      const send = s.asking === 'ask' ? '↵ ask' : '↵ add'
      const text = `${lead}${s.asking === 'ask' ? 'Ask' : 'Comment'}: ${s.draft}▏`
      strip = {
        ...rowOf([plain(lead, { color: 'magenta' }), plain(text.slice(lead.length, -1)), plain('▏', { color: 'magenta' }), plain('  '), plain(send, { bold: true }), plain('  '), plain('×', { dim: true })], 9999),
        hits: [
          { x0: text.length + 2, x1: text.length + 2 + send.length, post: 'submit' },
          { x0: text.length + 4 + send.length, x1: text.length + 5 + send.length, post: 'cancel' },
        ],
      }
    } else {
      const spans: Span[] = [plain(lead, { color: 'magenta' })]
      const hits: Hit[] = []
      let x = lead.length
      for (const label of STRIP) {
        const shown = label === '×' ? label : ` ${label} `
        spans.push(plain(shown, label === 'Explain' ? { bold: true, color: 'magenta' } : label === '×' ? { dim: true } : { bold: true }), plain(' '))
        const post: Hit['post'] =
          label === 'Ask…' ? 'ask' : label === 'Comment…' ? 'comment' : label === '×' ? 'hide' : { type: 'annotate', kind: label.toLowerCase(), quote: picked, parent: parent ?? null }
        hits.push({ x0: x, x1: x + shown.length, post })
        x += shown.length + 1
      }
      strip = { ...rowOf(spans, 9999), hits }
    }
  }
  const at = span ? span[1].r + 1 : -1
  const drawn = strip ? [...rows.slice(0, at), strip, ...rows.slice(at)] : rows
  // From a drawn row back to the laid-out row it shows (the strip shows none).
  const source = (y: number) => (strip && y >= at ? (y === at ? -1 : y - 1) : y)

  const done = (post: JsonValue) => {
    surface.post(post)
    surface.setState(BLANK)
  }
  const submit = () => {
    if (s.asking && s.draft.trim()) done({ type: 'annotate', kind: s.asking, quote: picked, question: s.draft.trim(), parent: parent ?? null })
  }
  const hitAt = (x: number, y: number) => {
    const i = drawn[y]?.hits?.findIndex(h => x >= h.x0 && x < h.x1) ?? -1
    return i >= 0 ? { y, i } : null
  }

  surface.onPointer((e: ClientPointerEvent) => {
    // Hovering: redraw only when the action under the pointer changes.
    if ((e.type === 'move' && !e.button) || e.type === 'enter' || e.type === 'leave') {
      const h = e.type === 'leave' ? null : hitAt(e.x, e.y)
      if (h?.y !== s.hover?.y || h?.i !== s.hover?.i) surface.setState({ ...s, hover: h })
      return
    }
    if (e.type === 'down' && e.button === 'left') {
      const at0 = hitAt(e.x, e.y)
      const hit = at0 ? drawn[at0.y]!.hits![at0.i]! : null
      if (hit) {
        if (hit.post === 'ask' || hit.post === 'comment') return surface.setState({ ...s, asking: hit.post, draft: '', hover: null })
        if (hit.post === 'cancel' || hit.post === 'hide') return surface.setState(BLANK)
        if (hit.post === 'submit') return submit()
        return done(hit.post)
      }
      const r = source(e.y)
      if (r < 0 || r >= rows.length) return surface.setState(BLANK)
      const c = Math.max(e.x, rows[r]!.from)
      const now = Date.now()
      // A second press on the same word within a moment selects the word.
      if (s.last && s.last.at.r === r && Math.abs(s.last.at.c - c) <= 1 && now - s.last.t < 400) {
        const t = rows[r]!.text
        let x0 = c
        let x1 = c
        while (isWord(t[x0 - 1]) && x0 > rows[r]!.from) x0--
        while (isWord(t[x1 + 1])) x1++
        if (isWord(t[c])) return surface.setState({ ...BLANK, a: { r, c: x0 }, f: { r, c: x1 } })
      }
      return surface.setState({ ...BLANK, a: { r, c }, f: { r, c }, dragging: true, last: { at: { r, c }, t: now } })
    }
    if (e.type === 'move' && s.dragging && e.button === 'left') {
      const y = Math.max(0, Math.min(drawn.length - 1, e.y))
      let r = source(y)
      if (r < 0) r = at - 1
      r = Math.max(0, Math.min(rows.length - 1, r))
      const row = rows[r]!
      const c = Math.max(row.from, Math.min(Math.max(row.from, (row.end ?? row.text.length) - 1), e.x))
      if (s.f && s.f.r === r && s.f.c === c) return
      return surface.setState({ ...s, f: { r, c } })
    }
    if (e.type === 'up' && s.dragging) {
      const one = s.a && s.f && s.a.r === s.f.r && s.a.c === s.f.c
      return surface.setState(one ? { ...BLANK, last: s.last } : { ...s, dragging: false })
    }
  })

  surface.onKey((e: ClientKeyEvent) => {
    if (!picked) return
    if (!s.asking) {
      if (e.key === 'return') return done({ type: 'annotate', kind: 'explain', quote: picked, parent: parent ?? null })
      if (e.key === 'a' || e.key === '?') return surface.setState({ ...s, asking: 'ask', draft: '' })
      if (e.key === 'c') return surface.setState({ ...s, asking: 'comment', draft: '' })
      if (e.key === 'd') return done({ type: 'annotate', kind: 'deeper', quote: picked, parent: parent ?? null })
      return
    }
    if (e.key === 'return') return submit()
    if (e.key === 'backspace' || e.key === 'delete') return surface.setState({ ...s, draft: s.draft.slice(0, -1) })
    if (e.ctrl || e.meta) return
    // Space comes by name; a paste may come as one key of several characters.
    const typed = e.key === 'space' ? ' ' : e.key.length === 1 || !(NAMED.has(e.key) || /^f\d+$/.test(e.key)) ? e.key : ''
    if (typed) return surface.setState({ ...s, draft: s.draft + typed })
  })

  const styleOf = (st: Style, on: boolean) => ({
    bold: st.bold,
    italic: st.italic,
    strikethrough: st.strike,
    underline: st.link || st.underline,
    dimColor: st.dim,
    color: st.code ? 'suggestion' : st.color,
    inverse: on || undefined,
  })

  // A row's spans, cut where the selection (or the hovered action) starts and ends, so those cells draw inverted.
  const drawRow = (row: Row, r: number, y: number) => {
    const lo = span && r >= span[0].r && r <= span[1].r ? Math.max(row.from, r === span[0].r ? span[0].c : 0) : -1
    const hi = lo >= 0 ? (r === span![1].r ? span![1].c + 1 : row.text.length) : -1
    const lit = s.hover?.y === y ? row.hits?.[s.hover.i] : undefined
    const ranges: [number, number][] = [...(lo >= 0 ? [[lo, hi] as [number, number]] : []), ...(lit ? [[lit.x0, lit.x1] as [number, number]] : [])]
    const out: any[] = []
    let x = 0
    row.spans.forEach((sp, k) => {
      const end = x + sp.text.length
      const cuts = [x, ...ranges.flat().filter(v => v > x && v < end).sort((p, q) => p - q), end]
      for (let m = 0; m < cuts.length - 1; m++) {
        const a = cuts[m]!
        const b = cuts[m + 1]!
        const on = ranges.some(([p, q]) => a >= p && b <= q)
        out.push(
          <Text key={`${k}-${m}`} {...styleOf(sp.style, on)}>
            {sp.text.slice(a - x, b - x)}
          </Text>,
        )
      }
      x = end
    })
    return (
      <Text key={`r${y}`} wrap="truncate-end">
        {out.length ? out : ' '}
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      {drawn.map((row, y) => {
        const r = source(y)
        return drawRow(row, r < 0 ? -1 : r, y)
      })}
    </Box>
  )
}

export default Doc
