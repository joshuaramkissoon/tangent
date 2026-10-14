import { expect, test } from 'claude-code/testing'

const PATH = '/repo/docs/plan.md'
const PLAN = '# Plan\n\nWe cache reads at the CDN with s-maxage.\n\nThen we ship it.'
const scroll = { offset: 0, bodyRows: 40 }
const band = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll } as any
declare const setTimeout: (fn: (...a: unknown[]) => void, ms: number) => unknown
const pane = { title: 'Tangent', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll }

// The Client's drawing as the rows a person sees.
function rowsOf(tree: any): string[] {
  const flat = (n: any): string =>
    typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(flat).join('') : n ? flat(n.children ?? n.props?.children ?? '') : ''
  const kids = tree?.children ?? tree?.props?.children ?? []
  return (Array.isArray(kids) ? kids : [kids]).map(flat)
}

function stubs(on: any, answer = 'It tells shared caches how long to keep the response.') {
  on('fs.read', () => ({ value: PLAN }))
  on('fs.exists', () => ({ value: true }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.selection', () => ({ value: undefined }))
  on('model.complete', () => ({ value: { isAnswered: true, text: answer } }))
  on('tool.call', () => ({ result: {} }))
  on('command.register', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.panes', () => ({ value: [{ id: 'tangent', isPlaced: true }] }))
}

async function openPlan($: any) {
  await $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN } as any)
  const above = await $.ui.mount({ plugin: 'tangent', surface: 'terminal', component: 'AbovePrompt', props: band })
  await above.press({ key: 'read' })
  const view = await $.ui.mount({ plugin: 'tangent', surface: 'terminal', component: 'Pane', requestId: 'tangent', props: pane })
  await view.resize({ columns: 60, rows: 40, in: 'doc' })
  return view
}

test('dragging over words in the pane puts the actions on the row under them, and Explain adds a note there', async ($, on) => {
  stubs(on)
  const view = await openPlan($)
  let rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows[2]).toBe('We cache reads at the CDN with s-maxage.')

  const x = rows[2]!.indexOf('s-maxage')
  await view.pointer({ type: 'down', x, y: 2, button: 'left', in: 'doc' })
  await view.pointer({ type: 'move', x: x + 7, y: 2, button: 'left', in: 'doc' })
  await view.pointer({ type: 'up', x: x + 7, y: 2, button: 'left', in: 'doc' })
  rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows[3]).toMatch(/Explain.*Ask….*Deeper/)
  // The selected words stay where they were.
  expect(rows[2]).toBe('We cache reads at the CDN with s-maxage.')

  await view.pointer({ type: 'down', x: rows[3]!.indexOf('Explain'), y: 3, button: 'left', in: 'doc' })
  rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows.join('\n')).toMatch(/Explain “s-maxage”/)
  expect(rows.join('\n')).toMatch(/shared caches/)
  expect(rows.join('\n')).not.toMatch(/haiku/)
  expect(rows.some(r => /Explain.*Deeper/.test(r))).toBe(false)
})

test('a double press selects the word under it', async ($, on) => {
  stubs(on)
  const view = await openPlan($)
  let rows = rowsOf(await view.drawn({ in: 'doc' }))
  const x = rows[4]!.indexOf('ship') + 1
  for (let k = 0; k < 2; k++) {
    await view.pointer({ type: 'down', x, y: 4, button: 'left', in: 'doc' })
    await view.pointer({ type: 'up', x, y: 4, button: 'left', in: 'doc' })
  }
  rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows[5]).toMatch(/Explain/)
})

test('with a Together key, DeepSeek streams the answer, the key kept out of the arguments', { options: { together_api_key: 'test-key' } }, async ($, on) => {
  stubs(on, 'not this one')
  let sent: any
  on('process.spawn', async function* (_$: any, e: any) {
    sent = e
    const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`
    yield { stream: 'stdout', text: delta('From ') }
    yield { stream: 'stdout', text: delta('DeepSeek.') + 'data: [DONE]\n' }
    return { value: { code: 0, signal: null } }
  } as any)
  on('clock.sleep', () => new Promise(() => {}))
  const view = await openPlan($)
  await view.post({ type: 'annotate', kind: 'explain', quote: 's-maxage', parent: null }, { in: 'doc' })
  await new Promise(r => setTimeout(r, 50))
  const rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows.join('\n')).toMatch(/From DeepSeek\./)
  expect(sent.env.TANGENT_TOGETHER_KEY).toBe('test-key')
  expect(JSON.stringify(sent.argv)).not.toMatch(/test-key/)
  expect(JSON.parse(sent.input).stream).toBe(true)
})

test('a comment is kept as written, and only comments go to Claude', async ($, on) => {
  stubs(on)
  let filled = ''
  on('prompt.fill', (_$: any, e: any) => {
    filled = e.text
    return { isFilled: true }
  })
  const view = await openPlan($)
  await view.post({ type: 'annotate', kind: 'explain', quote: 's-maxage', parent: null }, { in: 'doc' })
  let rows = rowsOf(await view.drawn({ in: 'doc' }))
  const t = rows.findIndex(r => r.includes('ship'))
  const x = rows[t]!.indexOf('ship')
  await view.pointer({ type: 'down', x, y: t, button: 'left', in: 'doc' })
  await view.pointer({ type: 'move', x: x + 3, y: t, button: 'left', in: 'doc' })
  await view.pointer({ type: 'up', x: x + 3, y: t, button: 'left', in: 'doc' })
  rows = rowsOf(await view.drawn({ in: 'doc' }))
  const y = rows.findIndex(r => r.includes('Comment…'))
  await view.pointer({ type: 'down', x: rows[y]!.indexOf('Comment…'), y, button: 'left', in: 'doc' })
  for (const ch of 'behind a flag') await view.key({ key: ch === ' ' ? 'space' : ch, in: 'doc' })
  await view.key({ key: 'return', in: 'doc' })

  rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows.join('\n')).toMatch(/Comment “ship”/)
  expect(rows.join('\n')).toMatch(/behind a flag/)
  expect(await view.find({ key: 'send-all' })).toMatchObject({ props: { label: 'Send 1 comment to Claude' } })
  await view.press({ key: 'send-all' })
  expect(filled).toMatch(/On "ship": behind a flag/)
  expect(filled).not.toMatch(/s-maxage/)
})

test('an action lights up under the pointer', async ($, on) => {
  stubs(on)
  const view = await openPlan($)
  await view.post({ type: 'annotate', kind: 'explain', quote: 's-maxage', parent: null }, { in: 'doc' })
  const rows = rowsOf(await view.drawn({ in: 'doc' }))
  const y = rows.findIndex(r => r.includes('Remove'))
  const lit = async () => JSON.stringify(await view.drawn({ in: 'doc' })).match(/"inverse":true},"children":\["Remove"\]/)
  expect(await lit()).toBeNull()
  await view.pointer({ type: 'move', x: rows[y]!.indexOf('Remove') + 1, y, in: 'doc' })
  const tree = JSON.stringify(await view.drawn({ in: 'doc' }))
  expect(await lit(), tree.slice(Math.max(0, tree.indexOf('Remove') - 300), tree.indexOf('Remove') + 100)).not.toBeNull()
})

test('a note folds to one row from its title, and unfolds again', async ($, on) => {
  stubs(on)
  const view = await openPlan($)
  await view.post({ type: 'annotate', kind: 'explain', quote: 's-maxage', parent: null }, { in: 'doc' })
  const press = async () => {
    const rows = rowsOf(await view.drawn({ in: 'doc' }))
    const y = rows.findIndex(r => r.includes('Explain “s-maxage”'))
    await view.pointer({ type: 'down', x: rows[y]!.indexOf('Explain'), y, button: 'left', in: 'doc' })
    return rowsOf(await view.drawn({ in: 'doc' }))
  }
  let rows = await press()
  expect(rows.find(r => r.includes('▸ › Explain'))).toMatch(/It tells shared/)
  expect(rows.some(r => r.includes('Remove'))).toBe(false)
  rows = await press()
  expect(rows.some(r => r.includes('▾ › Explain'))).toBe(true)
  expect(rows.some(r => r.includes('Remove'))).toBe(true)
})

test('typing /tangent offers the docs Claude wrote this session, then the folder’s', async ($, on) => {
  stubs(on)
  on('session.cwd', () => ({ value: '/repo' }) as any)
  on('env.get', () => ({ value: '/home/me' }) as any)
  on('fs.list', () => ({
    value: [
      { name: 'README.md', kind: 'file', size: 1, mtimeMs: 2, isLink: false },
      { name: 'plan.html', kind: 'file', size: 1, mtimeMs: 3, isLink: false },
      { name: 'main.py', kind: 'file', size: 1, mtimeMs: 4, isLink: false },
      { name: 'docs', kind: 'dir', size: 0, mtimeMs: 5, isLink: false },
    ],
  }) as any)
  on('prompt.autocomplete', () => ({ suggestions: [] }) as any)
  await $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN } as any)

  const ask = (text: string) =>
    ($ as any).prompt.autocomplete({ text, cursor: text.length, token: text.split(' ').pop(), start: text.lastIndexOf(' ') + 1 })
  // Not on the command word, where the rows would sit among every other command's.
  expect((await ask('/tangent')).suggestions).toEqual([])
  const some = await ask('/tangent pl')
  expect(some.suggestions.map((s: any) => s.text)).toEqual(['docs/plan.md', 'plan.html'])
  expect(some.suggestions[0]).toMatchObject({ label: 'plan.md', description: 'Claude wrote this session' })
  expect((await ask('fix the tests')).suggestions).toEqual([])

  // /tangent alone offers them in the pane, Claude's first; picking one opens it.
  await ($ as any).command.run({ command: 'tangent', args: '' })
  const view = await $.ui.mount({ plugin: 'tangent', surface: 'terminal', component: 'Pane', requestId: 'tangent', props: pane as any })
  const picks = (await view.findAll({ type: 'Button' })).filter((b: any) => String(b.key ?? b.props?.key).startsWith('pick-'))
  expect(picks.map((b: any) => b.props.label)).toEqual(['docs/plan.md', 'plan.html', 'README.md'])
  expect(await view.find({ type: 'Text', text: 'Written this session' } as any)).toBeDefined()
  await view.press({ key: 'pick-/repo/docs/plan.md' })
  expect(await view.find({ key: 'doc' })).toBeDefined()
  expect(await view.find({ key: 'pick-/repo/plan.html' })).toBeUndefined()
})

test('a selection in the transcript gets its actions in the band', async ($, on) => {
  on('command.register', () => ({ value: undefined }) as any)
  on('clock.now', () => ({ value: 1000 }) as any)
  on('ui.panes', () => ({ value: [{ id: 'tangent', isPlaced: true }] }) as any)
  on('session.start', (_$, e: any) => ({ cwd: e.cwd }) as any)
  on('ui.selection', () => ({ value: { text: 'prefix-bounded context', requestId: 'msg-1' } }) as any)
  let ticks = 0
  on('clock.every', () => (ticks++ < 3 ? { value: undefined } : { deny: 'enough' }) as any)
  await ($ as any).session.start({ cwd: '/repo', source: 'startup' })
  await new Promise(r => setTimeout(r, 100))
  const above = await $.ui.mount({ plugin: 'tangent', surface: 'terminal', component: 'AbovePrompt', props: band })
  expect(await above.find({ key: 'explain' })).toBeDefined()
})
