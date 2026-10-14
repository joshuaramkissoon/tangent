import { expect, test } from 'claude-code/testing'

import { htmlToMarkdown } from '../hooks/html'

const PAGE = `<!doctype html><html><head><title>Edge caching plan</title><style>body{color:red}</style></head>
<body><main>
  <h1>Cache the public API</h1>
  <p class="lede">The <code>/v1/papers</code> endpoints
     are slow &mdash; mostly the database.</p>
  <section class="stats"><div class="stat"><b>80%</b><span>repeat within a minute</span></div></section>
  <h2>Approach</h2>
  <ol><li>Send <code>Cache-Control</code> on reads.</li><li>Tag with <strong>surrogate keys</strong>.</li></ol>
  <ul><li>one</li><li>two</li></ul>
  <table><thead><tr><th>Endpoint</th><th>TTL</th></tr></thead><tbody><tr><td><code>GET /x</code></td><td>60s</td></tr></tbody></table>
  <div class="callout"><strong>Purge lag.</strong> A reader may see the old note.</div>
<pre>curl -sI "https://a.example" \\
  | grep -i cache</pre>
  <script>alert(1)</script>
</main></body></html>`

test('an HTML page reads as the markdown the pane draws', () => {
  const md = htmlToMarkdown(PAGE)
  expect(md).toContain('# Cache the public API')
  expect(md).toContain('The `/v1/papers` endpoints are slow — mostly the database.')
  expect(md).toContain('**80%** repeat within a minute')
  expect(md).toContain('## Approach')
  expect(md).toContain('1. Send `Cache-Control` on reads.\n2. Tag with **surrogate keys**.')
  expect(md).toContain('- one\n- two')
  expect(md).toContain('| Endpoint | TTL |\n| --- | --- |\n| `GET /x` | 60s |')
  expect(md).toContain('**Purge lag.** A reader may see the old note.')
  expect(md).toContain('```\ncurl -sI "https://a.example" \\\n  | grep -i cache\n```')
  expect(md).not.toMatch(/alert|color:red|Edge caching plan/)
})
