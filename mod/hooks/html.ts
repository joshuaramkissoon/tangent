// An HTML page (an artifact Claude wrote, say) as the markdown the pane draws. There's no DOM here,
// so it goes by the tags: headings, paragraphs, lists, tables, code, quotes and inline marks; the
// page's chrome (head, scripts, styles, pictures) is dropped.

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', times: '×', rarr: '→', larr: '←', bull: '•', copy: '©',
}

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m,
  )

const strip = (s: string) => s.replace(/<[^>]+>/g, '')

// Inline marks within a run of text, whitespace already folded.
function inline(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, x) => (strip(x).trim() ? `**${x.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, x) => (strip(x).trim() ? `*${x.trim()}*` : ''))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, x) => `\`${strip(x)}\``)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, x) => (href.startsWith('#') ? x : `[${x}](${href})`))
}

export function htmlToMarkdown(html: string): string {
  let s = html.replace(/\r/g, '')
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style|svg|noscript|template|button|form|canvas)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(img|input|meta|link)\b[^>]*>/gi, '')

  // Code keeps its own lines: set aside before whitespace is folded.
  const kept: string[] = []
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, x) => {
    kept.push('```\n' + decode(strip(x.replace(/<br\s*\/?>/gi, '\n'))).replace(/\n+$/, '') + '\n```')
    return `\n\n\u0000${kept.length - 1}\u0000\n\n`
  })
  s = s.replace(/[ \t\n]+/g, ' ')
  // Inline elements set side by side (a stat's number and its label) are separate words on the page.
  s = s.replace(/(<\/(?:b|strong|em|i|span|a|code|small|label|mark)>)(?=<(?:b|strong|em|i|span|a|code|small|label|mark)\b)/gi, '$1 ')

  // Tables, a row per line, the first row as the head.
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, t) => {
    const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r =>
      [...r[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => decode(strip(inline(c[1]))).replace(/\|/g, '/').trim()),
    )
    if (!rows.length) return ''
    const cols = Math.max(...rows.map(r => r.length))
    const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, k) => r[k] ?? '').join(' | ')} |`
    return `\n\n${line(rows[0]!)}\n| ${Array(cols).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`
  })

  // Lists: numbered in an <ol>, bulleted otherwise.
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, x) => {
    let k = 0
    return '\n\n' + x.replace(/<li\b[^>]*>/gi, () => `\n${++k}. `).replace(/<\/li>/gi, '') + '\n\n'
  })
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '').replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n\n')

  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, x) => `\n\n${'#'.repeat(Number(n))} ${strip(inline(x)).trim()}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, x) => `\n\n> ${strip(inline(x)).trim()}\n\n`)
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|figure|figcaption|dl|dt|dd|details|summary|nav|body|html)\b[^>]*>/gi, '\n\n')
  s = decode(strip(inline(s)))

  s = s
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_, k) => kept[Number(k)] ?? '')
    .trim()
  if (title && !/^# /m.test(s)) s = `# ${decode(strip(title)).trim()}\n\n${s}`
  return s
}
