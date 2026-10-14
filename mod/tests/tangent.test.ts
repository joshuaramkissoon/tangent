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
  expect(rows.join('\n')).toMatch(/› “s-maxage”/)
  expect(rows.join('\n')).toMatch(/shared caches/)
  expect(rows.join('\n')).toMatch(/haiku · /)
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

test('with a Together key, DeepSeek answers', { options: { together_api_key: 'test-key' } }, async ($, on) => {
  stubs(on, 'not this one')
  let sent: any
  on('http.fetch', (_$: any, e: any) => {
    sent = e
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'From DeepSeek.' } }] }) } }
  })
  on('clock.sleep', () => new Promise(() => {}))
  const view = await openPlan($)
  await view.post({ type: 'annotate', kind: 'explain', quote: 's-maxage', parent: null }, { in: 'doc' })
  await new Promise(r => setTimeout(r, 50))
  const rows = rowsOf(await view.drawn({ in: 'doc' }))
  expect(rows.join('\n')).toMatch(/From DeepSeek\./)
  expect(rows.join('\n')).toMatch(/deepseek-v4\.1-flash · /)
  expect(JSON.stringify(sent)).toMatch(/Bearer test-key/)
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
