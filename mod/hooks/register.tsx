import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Doc, DocProps, Note, Sel } from '../types'

const PANE = 'tangent'
const MODEL = 'haiku'
const TOGETHER = 'https://api.together.xyz/v1/chat/completions'
const MD = /\.(md|markdown)$/i
// The selection API keeps the last selection after a click elsewhere, so the actions retire on their own.
const SELECTION_TTL_MS = 15_000
// Past this the doc is drawn by the engine's Markdown (no in-pane selection): a Client's props are bounded.
const CLIENT_MAX = 90_000

const doc = atom({ plugin: 'tangent', key: 'doc' } as const, null)
const notes = atom({ plugin: 'tangent', key: 'notes' } as const, [])
const sel = atom({ plugin: 'tangent', key: 'sel' } as const, null)
const dismissed = atom({ plugin: 'tangent', key: 'dismissed' } as const, null)
const written = atom({ plugin: 'tangent', key: 'written' } as const, null)
const asking = atom({ plugin: 'tangent', key: 'asking' } as const, false as false | 'ask' | 'comment')

const SYSTEM = `You are Tangent, a reading companion that answers in the margin of what someone is reading.
Answer the reader directly, in plain words, with no preamble and no headings.
Ground the answer in the context given; when the context doesn't settle it, say what is generally true and that the text doesn't say.
Do only the one task asked, once.`

// One plain instruction per note: a list of modes in the system prompt had DeepSeek answer every mode in turn.
const TASK = {
  explain: (q: string) => `In 2-4 sentences, explain what "${q}" means here and why it matters.`,
  deeper: (q: string) =>
    `In two short paragraphs, go a level deeper on "${q}" than an explanation would: the mechanism, the trade-off, or what follows from it.`,
  ask: (q: string, question = '') => `About "${q}", the reader asks: ${question}\nAnswer in a few sentences.`,
}

// Markdown as typed and text as drawn differ by their marks, so both are compared bare.
const bare = (s: string) =>
  s.replace(/[`*_#>|~\[\]()]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

// Blocks are split at blank lines, a fenced code block staying whole. (doc.tsx draws with the same split.)
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

const nameOf = (path: string) => path.split('/').pop() ?? path
const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

type Options = Record<string, unknown>
// The options as of the last load; a change in /config reloads the module with new ones.
let opts: Options = {}

let lastSeen = ''
let seenAt = 0

async function paneIsOpen($: any): Promise<boolean> {
  const panes = await $.ui.panes()
  return panes.some((p: { id: string; isPlaced: boolean }) => p.id === PANE && p.isPlaced)
}

// The actions on a transcript selection, drawn in the band above the prompt.
function actionStrip($: any, ui: any, s: Sel, open: false | 'ask' | 'comment') {
  const { Box, Button, Text, Input } = ui
  if (open) {
    return (
      <Box gap={1}>
        <Text color="magenta">✦</Text>
        <Text dimColor>“{short(s.text, 30)}”</Text>
        <Input
          key={open}
          placeholder={open === 'ask' ? 'Ask about this…' : 'A comment for Claude…'}
          submitLabel={open === 'ask' ? 'ask' : 'add'}
          autoFocus
          onSubmit={(value: string) => (value.trim() ? annotate($, open, s.text, value.trim()) : update($, asking, () => false as const))}
        />
      </Box>
    )
  }
  return (
    <Box gap={1}>
      <Text color="magenta">✦</Text>
      <Text dimColor>“{short(s.text, 40)}”</Text>
      <Button key="explain" label="Explain" variant="primary" onPress={() => annotate($, 'explain', s.text)} />
      <Button key="ask" label="Ask…" onPress={() => update($, asking, () => 'ask' as const)} />
      <Button key="deeper" label="Deeper" onPress={() => annotate($, 'deeper', s.text)} />
      <Button key="comment" label="Comment…" onPress={() => update($, asking, () => 'comment' as const)} />
      <Button key="hide" label="×" plain role="dismiss" onPress={() => update($, dismissed, () => s.text)} />
    </Box>
  )
}

async function openDoc($: any, path: string) {
  const text = await $.fs.read(path)
  await update($, doc, () => ({ path, text, changed: [] }))
  await update($, written, () => null)
  await $.ui.open({ id: PANE, title: `Tangent · ${nameOf(path)}` })
}

// The context a note is answered from: the parent note, then the doc, then the conversation.
async function contextFor($: any, quote: string, list: Note[], parentId?: string): Promise<{ text: string; parent?: string }> {
  const q = bare(quote)
  const parent = list.find(n => n.id === parentId && n.answer)
  const d: Doc | null = await read($, doc)
  const docText = d && bare(d.text).includes(q) ? d.text : d && parent ? d.text : null
  if (docText && d) {
    const lead = `The reader is reading ${nameOf(d.path)}:\n\n${docText.slice(0, 120_000)}`
    return { text: parent ? `${lead}\n\nAn earlier margin note said:\n${parent.answer}` : lead, parent: parent?.id }
  }
  if (parent) return { text: `An earlier margin note said:\n${parent.answer}`, parent: parent.id }
  const rows = await $.session.messages()
  const recent = rows
    .slice(-8)
    .map((m: { role: string; text: string }) => `${m.role}: ${m.text}`)
    .join('\n\n')
    .slice(-16_000)
  return { text: `The reader is reading this conversation with a coding assistant:\n\n${recent}` }
}

// DeepSeek on Together, streamed so the first words show at once. $.http.fetch only hands back a whole body,
// so curl streams it; the key reaches curl through its environment, never its arguments.
async function streamTogether($: any, key: string, model: string, context: string, ask: string, maxTokens: number, onText: (t: string) => void) {
  let started = false
  const run = (async () => {
    const out = $.process.spawn({
      argv: [
        'curl', '-sSN', '--max-time', '30',
        '--variable', '%TANGENT_TOGETHER_KEY',
        '--expand-header', 'Authorization: Bearer {{TANGENT_TOGETHER_KEY}}',
        '-H', 'Content-Type: application/json',
        '--data-binary', '@-',
        TOGETHER,
      ],
      env: { TANGENT_TOGETHER_KEY: key },
      input: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `${context}\n\n${ask}` },
        ],
      }),
    })
    let buf = ''
    let text = ''
    for await (const c of out) {
      if (c.stream !== 'stdout') continue
      buf += c.text
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue
        try {
          const piece = JSON.parse(line.slice(5))?.choices?.[0]?.delta?.content
          if (piece) {
            started = true
            text += piece
            onText(text)
          }
        } catch {}
      }
    }
    return text.trim() || null
  })().catch(() => null)
  // No first words within 8s and Haiku answers instead; once words flow, the stream finishes.
  return Promise.race([run, $.clock.sleep(8_000).then(() => (started ? run : null))])
}

// DeepSeek on Together when there's a key, as it answers faster; Haiku otherwise, or when Together fails.
async function answer($: any, context: string, ask: string, maxTokens: number, onText: (t: string) => void): Promise<{ text?: string; error?: string; via: string }> {
  const key = String(opts.together_api_key ?? '').trim()
  if (key) {
    const model = String(opts.together_model || 'deepseek-ai/DeepSeek-V4.1-Flash')
    const text = await streamTogether($, key, model, context, ask, maxTokens, onText)
    if (text) return { text, via: (model.split('/').pop() ?? model).toLowerCase() }
  }
  const res = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: [{ text: context, cache: true }, { text: ask }],
    maxTokens,
    effort: 'low',
    timeoutMs: 30_000,
  })
  return res.isAnswered ? { text: res.text.trim(), via: MODEL } : { error: `Couldn't answer (${res.reason}).`, via: MODEL }
}

async function annotate($: any, kind: Note['kind'], quote: string, question?: string, parentId?: string) {
  const list: Note[] = await read($, notes)
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const ctx = await contextFor($, quote, list, parentId)
  const note: Note = { id, quote, kind, question, answer: null, parent: ctx.parent }
  await update($, notes, l => [...l, note])
  await update($, dismissed, () => quote)
  await update($, asking, () => false as const)
  // Opening a pane that is already open would send it back to the top.
  if (!(await paneIsOpen($))) await $.ui.open({ id: PANE, title: 'Tangent' })

  // A comment is for Claude, not the model: it's kept as written.
  if (kind === 'comment') return

  const ask = TASK[kind](quote, question)
  const started = await $.clock.now()
  // The answer is drawn as it streams, a few times a second at most.
  let drawn = 0
  const onText = (t: string) => {
    const now = Date.now()
    if (now - drawn < 80) return
    drawn = now
    // A late piece never overwrites the finished answer.
    void update($, notes, l => l.map(n => (n.id === id && !n.via ? { ...n, answer: t } : n)))
  }
  const got = await answer($, ctx.text, ask, kind === 'deeper' ? 700 : 400, onText)
  const ms = (await $.clock.now()) - started
  await update($, notes, l => l.map(n => (n.id === id ? { ...n, answer: got.text ?? null, error: got.error, via: got.via, ms } : n)))
}

// Only comments go to Claude; explanations and answers are the reader's own. They go to the prompt box,
// not straight to Claude, so they can be read over first.
async function sendToClaude($: any, only?: Note) {
  const d: Doc | null = await read($, doc)
  const list: Note[] = (only ? [only] : ((await read($, notes)) as Note[])).filter(n => n.kind === 'comment')
  if (!list.length) return
  const lines = list.map((n, i) => `${i + 1}. On "${short(n.quote, 160)}": ${n.question}`)
  const head = d ? `Comments on ${d.path}, from reading it in Tangent:` : 'Notes from reading this conversation in Tangent:'
  await $.prompt.fill({ text: `${head}\n\n${lines.join('\n')}\n`, mode: 'insert' })
}

export const register: Register = (on, options) => {
  opts = (options ?? {}) as Options

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tangent',
      description: 'Open a markdown file (or the last one Claude wrote) in the Tangent pane',
      argumentHint: '[file.md]',
    })
    // There is no selection event, so the transcript's selection is read a few times a second.
    $.clock.every(400, async () => {
      const s = await $.ui.selection()
      const text = s?.text.trim() ?? ''
      const now = await $.clock.now()
      if (text === lastSeen) {
        if (text && now - seenAt > SELECTION_TTL_MS && !(await read($, asking)) && (await read($, dismissed)) !== text) {
          await update($, dismissed, () => text)
        }
        return
      }
      lastSeen = text
      seenAt = now
      await update($, sel, () => (text && text.length <= 4000 ? { text, requestId: s?.requestId } : null))
      if (!text) await update($, asking, () => false as const)
    })
    return next(e)
  })

  // A /clear starts the pane over too: no doc, no notes, no offer to read the last file.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, doc, () => null)
      await update($, notes, () => [])
      await update($, written, () => null)
      await update($, sel, () => null)
      await update($, asking, () => false as const)
    }
    return next(e)
  })

  on('command.run', { command: 'tangent' }, async ($, e) => {
    const arg = e.args.trim()
    const path = arg
      ? arg.startsWith('/') ? arg : `${await $.session.cwd()}/${arg}`
      : (await read($, written)) ?? (await read($, doc))?.path ?? null
    if (!path) {
      await $.ui.open({ id: PANE, title: 'Tangent' })
      return { text: 'Tangent pane opened. Select any text to explain it.' }
    }
    if (!(await $.fs.exists(path))) return { text: `No file at ${path}.` }
    await openDoc($, path)
    return { text: `Opened ${nameOf(path)} in Tangent.` }
  })

  // When Claude writes a markdown file, offer to open it; when it edits the open one, refresh it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    const path = (e as any).file_path as string | undefined
    if (!path || !MD.test(path) || !['Write', 'Edit', 'MultiEdit'].includes(tool)) return ran
    if (ran.deny !== undefined || ran.isError) return ran
    const d: Doc | null = await read($, doc)
    if (d && d.path === path) {
      const text = await $.fs.read(path)
      const before = new Set(blocksOf(d.text))
      await update($, doc, () => ({ path, text, changed: blocksOf(text).filter(b => !before.has(b)) }))
    } else {
      await update($, written, () => path)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e) as any
    const { Box, Button, Text } = ui
    const s: Sel | null = await read($, sel)
    const gone: string | null = await read($, dismissed)

    // The terminal sees selections in the transcript; words dragged over in the pane are the doc region's own.
    if (s && s.text !== gone) return actionStrip($, ui, s, await read($, asking))

    const w: string | null = await read($, written)
    if (w) {
      return (
        <Box gap={1}>
          <Text dimColor>📄 Claude wrote {nameOf(w)}</Text>
          <Button key="read" label="Read in Tangent" variant="primary" onPress={() => openDoc($, w)} />
          <Button key="hide-doc" label="×" plain role="dismiss" onPress={() => update($, written, () => null)} />
        </Box>
      )
    }
    return next(e)
  })

  // Posts from the doc region: an action on the words selected there, or on one note.
  on('ui.message', async ($, e, next) => {
    const m = e.data as { type?: string; kind?: Note['kind']; quote?: string; question?: string; parent?: string | null; id?: string }
    if (e.requestId !== PANE || !m?.type) return next(e)
    if (m.type === 'annotate' && m.kind && m.quote) void annotate($, m.kind, m.quote, m.question, m.parent ?? undefined)
    if (m.type === 'send' && m.id) {
      const n = ((await read($, notes)) as Note[]).find(x => x.id === m.id)
      if (n) await sendToClaude($, n)
    }
    if (m.type === 'remove' && m.id) await update($, notes, l => l.filter(x => x.id !== m.id && x.parent !== m.id))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box, Button, Text, Markdown, Client } = ui
    const d: Doc | null = await read($, doc)
    const list: Note[] = await read($, notes)
    const comments = list.filter(n => n.kind === 'comment').length
    const columns = e.props.bodyColumns ?? 80
    const props: DocProps = { text: d?.text ?? '', notes: list, changed: d?.changed ?? [], columns }
    // Surfaces without a Client, and docs too long for one, get the engine's Markdown.
    const inClient = !!Client && JSON.stringify(props).length <= CLIENT_MAX

    return (
      <Box flexDirection="column" gap={0}>
        <Box gap={1}>
          <Text bold>{d ? nameOf(d.path) : 'Tangent'}</Text>
          {comments > 0 && <Button key="send-all" label={`Send ${comments} comment${comments > 1 ? 's' : ''} to Claude`} onPress={() => sendToClaude($)} />}
          {d && <Button key="open-web" label="Open in Tangent ↗" onPress={() => $.process.run(['tangent', d.path])} />}
          {list.length > 0 && <Button key="clear" label="Clear notes" plain dimColor onPress={() => update($, notes, () => [])} />}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {inClient ? <Client key="doc" module="./doc.tsx" props={props} width="100%" /> : <Markdown key="doc-md" text={d?.text ?? ''} />}
        </Box>
      </Box>
    )
  })
}
