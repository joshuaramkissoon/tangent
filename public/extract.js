// Article extraction in the browser: Mozilla Readability (Firefox Reader View's engine) finds the
// article; we then convert its clean HTML into Tangent's typed blocks ourselves, so nothing raw
// ever reaches the page. Footnotes are pulled out and shown in the margin.

const Extract = (() => {
  const BLOCK_TAGS = new Set(["P-BREAK", "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE",
    "FIGURE", "IMG", "PICTURE", "HR", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE", "DETAILS",
    "SUMMARY", "DL", "DT", "DD", "LI", "FIGCAPTION", "VIDEO", "IFRAME", "FORM", "NAV"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SVG", "CANVAS", "FORM", "NAV", "IFRAME", "VIDEO", "AUDIO"]);
  const META_LINE = /^(updated|published|posted|last (updated|modified|edited)|originally published|reviewed|written by|by\s+[A-Z]|\d+\s*(min|minute)s?\s*read|reading time)\b|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}$|^\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+\d{4}$|^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}$/i;

  const norm = s => s.replace(/\s+/g, " ").trim();
  // Markdown -> comparable plain text (links, footnote markers, emphasis and escapes removed).
  const plainMd = s => norm((s || "").replace(/\[\^[\w-]+\]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_\\`]/g, ""));
  const TEX_SAFE = /^[\w\s+\-=().,′']{1,12}$/;
  // Escape characters our markdown renderer would otherwise interpret.
  // (Brackets stay unescaped: "\[" would read as LaTeX display maths.)
  const escMd = s => s.replace(/([\\`*_=|~$])/g, "\\$1");

  function langOf(pre) {
    const code = pre.querySelector("code");
    const cls = `${pre.className} ${code?.className || ""}`;
    const m = cls.match(/(?:language|lang|highlight-source|brush:?)-?\s*([\w+#-]+)/i);
    return m ? m[1].toLowerCase() : "";
  }

  // ---- footnotes -------------------------------------------------------------------------
  // Two common patterns: linked markers (<sup><a href="#fn3">3</a></sup>, used by Substack, Ghost,
  // WordPress, Pandoc) and bare numbers (<sup>3</sup>) matched to a "Footnotes" list at the end.

  // Known noise on popular sites, removed before Readability sees the page.
  const NOISE = {
    "wikipedia.org": ".infobox, .navbox, .vertical-navbox, .mw-editsection, .hatnote, .metadata, .ambox, .sistersitebox, .noprint, .mw-jump-link, .reflist + .navbox, #toc, .toc, .shortdescription, .portalbox, .side-box",
    "arxiv.org": ".ltx_page_footer, .ltx_page_header, .ltx_role_affiliation, header.desktop_header, .package-alerts, #header, .ltx_TOC, .ltx_authors, .ltx_note, .ltx_role_email, .ltx_dates",
  };
  const GENERIC_NOISE = ".menu-title, #menu-bar, .nav-chapters, .nav-wrapper, #sidebar, dialog, [role=dialog], .modal, #mdbook-help-container, .mdbook-help-container, [class*=help-popup], .skip-link, .newsletter, .subscribe, [class*=newsletter], [class*=paywall], [class*=cookie], .share, [class*=share-], .social, [class*=related-], .ad, .advert, [class*=sponsor]";
  function preClean(doc, url) {
    const host = new URL(url).hostname;
    for (const [site, sel] of Object.entries(NOISE)) if (host.endsWith(site)) doc.querySelectorAll(sel).forEach(e => e.remove());
    // Generic noise only when it's small: never let a broad class match take the article with it.
    doc.querySelectorAll(GENERIC_NOISE).forEach(e => { if (e.textContent.length < 600 && !e.querySelector("h1, article")) e.remove(); });
    // Wikipedia citations: <sup class=reference><a href="#cite_note-3">[3]</a></sup> -> footnotes.
    doc.querySelectorAll("sup.reference a").forEach(a => { a.textContent = a.textContent.replace(/[\[\]]/g, ""); });
  }

  function footnoteSection(doc) {
    // Candidates must hold list items and must not wrap the body text (some sites mark a whole
    // <section> as the footnotes area); of those, take the smallest.
    const sups = doc.querySelectorAll("sup").length;
    const cands = [...doc.querySelectorAll("[data-footnotes], [role=doc-endnotes], .footnotes, #footnotes, [class*=footnote], [id*=footnote], ol.references, .mw-references-wrap, .reflist")]
      .filter(el => el.querySelector("li") && el.querySelectorAll("sup").length <= Math.max(2, sups / 2) + el.querySelectorAll("li").length)
      .sort((a, b) => a.textContent.length - b.textContent.length);
    if (cands.length) return cands[0];
    for (const h of doc.querySelectorAll("h2, h3, h4")) {
      if (/^\s*(foot\s?notes|end\s?notes|notes)\s*$/i.test(h.textContent)) {
        let n = h.nextElementSibling;
        while (n && !n.querySelector?.("li") && n.tagName !== "OL") n = n.nextElementSibling;
        if (n) return n;
      }
    }
    return null;
  }

  function cleanNote(li) {
    const c = li.cloneNode(true);
    c.querySelectorAll("a[href^='#fnref'], a.footnote-backref, a[role=doc-backlink], .footnote-back, a[rev=footnote]").forEach(a => a.remove());
    c.querySelectorAll("sup").forEach(s => { if (/^\s*\d+\s*$/.test(s.textContent)) s.remove(); });
    return inlineOf(c).replace(/\s*[↩↑⤴]\s*$/u, "").trim();
  }

  // Runs on the ORIGINAL document (before Readability): collects notes and replaces each marker
  // with a <fn-ref data-n> element that survives Readability and becomes [^n] in the markdown.
  function prepareFootnotes(doc) {
    const notes = {};
    const section = footnoteSection(doc);
    const items = section ? [...section.querySelectorAll("li")] : [];
    let n = 0;
    const labelFor = new Map();
    for (const a of doc.querySelectorAll("a[href^='#']")) {
      const id = decodeURIComponent(a.getAttribute("href").slice(1));
      if (!id) continue;
      const isRef = a.closest("sup") || /footnote|fnref|noteref/i.test(`${a.className} ${a.id} ${a.getAttribute("role") || ""}`);
      if (!isRef || norm(a.textContent).length > 4) continue;
      const target = doc.getElementById(id);
      if (!target || (section && !section.contains(target) && !/^fn|foot|note/i.test(id))) continue;
      // Reuse the label when several markers point at the same note (Wikipedia repeats citations).
      let label = labelFor.get(id);
      if (!label) {
        const t = norm(a.textContent);
        label = /^\d{1,4}$/.test(t) && !Object.hasOwn(notes, t) ? t : String(Object.keys(notes).length + 1);
        labelFor.set(id, label);
        notes[label] = cleanNote(target.closest("li") || target);
      }
      n++;
      const marker = doc.createElement("fn-ref");
      marker.dataset.n = label;
      marker.textContent = label;
      (a.closest("sup") || a).replaceWith(marker);
    }
    if (!n && items.length) {
      // Bare numbered <sup>s, matched by number to the list items.
      const start = +(section.querySelector("ol")?.getAttribute("start") || 1);
      for (const sup of doc.querySelectorAll("sup")) {
        if (section.contains(sup)) continue;
        const num = +norm(sup.textContent);
        const li = items[num - start];
        if (!num || !li) continue;
        notes[String(num)] = cleanNote(li);
        const marker = doc.createElement("fn-ref");
        marker.dataset.n = String(num);
        marker.textContent = String(num);
        sup.replaceWith(marker);
      }
    }
    if (section && Object.keys(notes).length) {
      // Remove the section (and its heading) so it isn't rendered as body text.
      const prev = section.previousElementSibling;
      if (prev && /^h[2-4]$/i.test(prev.tagName) && /notes/i.test(prev.textContent)) prev.remove();
      section.remove();
    }
    return notes;
  }

  // ---- inline -> markdown -------------------------------------------------------------------

  function inlineOf(node) {
    let out = "";
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += escMd(n.data.replace(/\s+/g, " ")); continue; }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) continue;
      const tag = n.tagName;
      if (tag === "FN-REF") { out += `[^${n.dataset.n}]`; continue; }
      const tex = texOf(n);
      if (tex) { out += tex.display ? ` $$${tex.tex}$$ ` : `$${tex.tex}$`; continue; }
      if (tag === "BR") { out += " "; continue; }
      if ((tag === "SUB" || tag === "SUP") && TEX_SAFE.test(n.textContent.trim())) {
        out += `$${tag === "SUB" ? "_" : "^"}{\\text{${n.textContent.trim()}}}$`;
        continue;
      }
      if (tag === "IMG" || tag === "PICTURE" || tag === "FIGURE") continue;
      const inner = inlineOf(n);
      if (!inner.trim()) continue;
      const pad = s => { const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/); return m[1] + s(m[2]) + m[3]; };
      if (tag === "EM" || tag === "I" || tag === "CITE") out += pad(s => `*${s}*`);
      else if (tag === "STRONG" || tag === "B") out += pad(s => `**${s}**`);
      else if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
        const raw = n.textContent;
        const tick = raw.includes("`") ? "``" : "`";
        out += `${tick}${raw}${tick}`;
      } else if (tag === "A") {
        const href = n.href || "";
        out += /^https?:/.test(href) ? pad(s => `[${s}](${href.replace(/\)/g, "%29")})`) : inner;
      } else out += inner;
    }
    return out;
  }
  const inlineText = node => norm(inlineOf(node));

  // MathML (arXiv, many journals) and Wikipedia's maths spans carry their LaTeX source: use it.
  function texOf(el) {
    if (el.tagName === "MATH" || el.localName === "math") {
      const tex = el.getAttribute("alttext") || el.querySelector("annotation[encoding*='tex']")?.textContent;
      return tex ? { tex: tex.trim(), display: el.getAttribute("display") === "block" } : null;
    }
    if (el.classList?.contains("mwe-math-element")) {
      const img = el.querySelector("img");
      const tex = el.querySelector("annotation[encoding*='tex']")?.textContent || img?.alt;
      return tex ? { tex: tex.replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1").trim(), display: !!img?.className.includes("display") } : null;
    }
    return null;
  }

  // ---- block walker -----------------------------------------------------------------------

  // Pages that separate paragraphs with <br><br> instead of <p> get explicit boundaries.
  function markBreaks(root) {
    for (const br of [...root.querySelectorAll("br")]) {
      if (!br.isConnected) continue;
      let next = br.nextSibling;
      while (next && next.nodeType === 3 && !next.data.trim()) next = next.nextSibling;
      if (next?.nodeName === "BR") {
        const mark = root.ownerDocument.createElement("p-break");
        br.replaceWith(mark);
        while (mark.nextSibling && (mark.nextSibling.nodeName === "BR" || (mark.nextSibling.nodeType === 3 && !mark.nextSibling.data.trim()))) mark.nextSibling.remove();
      }
    }
  }
  const BLOCKISH = "p, div, ul, ol, pre, blockquote, table, figure, h1, h2, h3, h4, h5, h6, p-break, section, article";

  function htmlToBlocks(root) {
    markBreaks(root);
    const blocks = [];
    let run = [], brk = false;
    const push = b => { if (brk) { b.brk = true; brk = false; } blocks.push(b); };
    const flush = () => {
      if (!run.length) return;
      const holder = document.createElement("span");
      run.forEach(n => holder.append(n.cloneNode(true)));
      run = [];
      const md = inlineText(holder);
      if (md && md.replace(/\\/g, "").trim()) push({ t: "p", md });
    };

    const image = (img, cap = "") => {
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (!/^https?:/.test(src) || (img.width && img.width < 40)) return;
      push({ t: "img", src, alt: norm(img.alt || ""), md: cap || norm(img.alt || "") });
    };

    const list = (el, ordered, lv) => {
      let num = +(el.getAttribute("start") || 1);
      for (const li of el.children) {
        if (li.tagName !== "LI") continue;
        const c = li.cloneNode(true);
        const nested = [...c.querySelectorAll(":scope > ul, :scope > ol")];
        nested.forEach(x => x.remove());
        const md = inlineText(c);
        if (md) push({ t: "li", md, ord: ordered, n: num, lv: Math.min(lv, 2) });
        num++;
        for (const x of li.querySelectorAll(":scope > ul, :scope > ol")) list(x, x.tagName === "OL", lv + 1);
      }
    };

    const table = el => {
      const rows = [...el.querySelectorAll("tr")].map(tr => [...tr.children].map(td => inlineText(td).replace(/\|/g, "\\|")));
      if (!rows.length || rows.some(r => !r.length)) return;
      const width = Math.max(...rows.map(r => r.length));
      const line = r => "| " + [...r, ...Array(width - r.length).fill("")].join(" | ") + " |";
      push({ t: "table", md: [line(rows[0]), "|" + " --- |".repeat(width), ...rows.slice(1).map(line)].join("\n") });
    };

    const visit = el => {
      for (const n of [...el.childNodes]) {
        if (n.nodeType === 3) { if (n.data.trim()) run.push(n); continue; }
        if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) continue;
        const tag = n.tagName;
        // Inline wrappers (<font>, <span>) around whole sections are walked as containers.
        if (!BLOCK_TAGS.has(tag) && !n.querySelector(BLOCKISH)) { run.push(n); continue; }
        flush();
        if (!BLOCK_TAGS.has(tag) || tag === "P-BREAK") { if (tag !== "P-BREAK") visit(n); continue; }
        if (n.matches("table.ltx_equation, table.ltx_equationgroup, table.ltx_eqn_table")) {
          n.querySelectorAll("math").forEach(m => { const t = texOf(m); if (t) push({ t: "p", md: `$$${t.tex}$$` }); });
          continue;
        }
        if (tag === "P" && n.querySelector("p-break, " + BLOCKISH)) { visit(n); continue; }
        if (tag === "P") {
          const imgs = n.querySelectorAll("img");
          if (imgs.length && !norm(n.textContent)) imgs.forEach(i => image(i));
          else { const md = inlineText(n); if (md) push({ t: "p", md }); }
        } else if (/^H[1-6]$/.test(tag)) {
          const md = inlineText(n);
          if (md) push({ t: "h", md, lv: Math.max(2, +tag[1]) });
        } else if (tag === "UL" || tag === "OL") list(n, tag === "OL", 0);
        else if (tag === "PRE") push({ t: "code", md: n.textContent.replace(/\n+$/, ""), lang: langOf(n) });
        else if (tag === "BLOCKQUOTE") {
          const paras = n.querySelectorAll("p");
          (paras.length ? [...paras] : [n]).forEach(p => { const md = inlineText(p); if (md) push({ t: "quote", md }); });
        } else if (tag === "TABLE") table(n);
        else if (tag === "FIGURE" || tag === "PICTURE") {
          const img = n.querySelector("img");
          const cap = n.querySelector("figcaption");
          if (img) image(img, cap ? inlineText(cap) : "");
          else if (n.querySelector("pre")) visit(n);
        } else if (tag === "IMG") image(n);
        else if (tag === "HR") brk = true;
        else if (tag === "DL") {
          // "Author: Sam Gross" style metadata: each term with its definitions as one item.
          let term = "";
          for (const c of n.children) {
            if (c.tagName === "DT") { if (term) push({ t: "li", md: `**${term}**`, ord: false, lv: 0 }); term = inlineText(c); }
            else if (c.tagName === "DD") {
              const md = inlineText(c);
              // Indented formulas (Wikipedia uses <dl><dd> for these) are display maths, not list items.
              if (!term && /^\s*\$[^$]+\$[\s.,;]*$/.test(md)) push({ t: "p", md: md.trim().replace(/^\$([^$]+)\$([\s.,;]*)$/, "$$$$$1$$$$") });
              else push({ t: "li", md: term ? `**${term.replace(/:?$/, ":")}** ${md}` : md, ord: false, lv: 0 });
              term = "";
            }
          }
          if (term) push({ t: "li", md: `**${term}**`, ord: false, lv: 0 });
        }
        else visit(n);
      }
    };
    visit(root);
    flush();
    return blocks;
  }

  // Leading lines like "Updated in May 2025" or "5 min read" are metadata, not content.
  function splitMeta(blocks, title, siteName = "") {
    // Within the first few blocks: drop echoes of the title or site name (including a title image),
    // and lift metadata lines ("July 2023", "5 min read") into the byline.
    const meta = [];
    const t = norm(title).toLowerCase(), site = norm(siteName).toLowerCase();
    for (let i = 0; i < Math.min(blocks.length, 5); ) {
      const b = blocks[i];
      const text = plainMd(b.md).toLowerCase();
      const echo = text && (text === t || (site && text === site) || (b.t === "img" && text && t.includes(text)));
      if (echo && (b.t === "h" || b.t === "p" || b.t === "img")) { blocks.splice(i, 1); continue; }
      if (b.t === "p" && text.length < 90 && META_LINE.test(text)) { meta.push(norm(b.md.replace(/[*_\\]/g, ""))); blocks.splice(i, 1); continue; }
      if (b.t === "p" && text.length > 120) break;  // reached the body
      i++;
    }
    return meta;
  }

  const key = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  function prettyDate(s) {
    const d = s && new Date(s);
    return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
  }

  function run(html, url) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = doc.createElement("base");
    base.href = url;
    doc.head?.prepend(base);
    const arxivAuthors = new URL(url).hostname.endsWith("arxiv.org")
      ? [...doc.querySelectorAll(".ltx_personname")].map(p => norm(p.childNodes[0]?.textContent || p.textContent).split(/\s{2,}|\n/)[0]).filter(Boolean)
      : [];
    preClean(doc, url);
    const footnotes = prepareFootnotes(doc);
    const article = new Readability(doc, { keepClasses: true, charThreshold: 300 }).parse();
    if (!article || norm(article.textContent || "").length < 400) return null;
    const holder = new DOMParser().parseFromString(`<base href="${url}"><div>${article.content}</div>`, "text/html").body.firstElementChild;
    const blocks = htmlToBlocks(holder);
    let title = norm(article.title || "") || url, subtitle = "";
    const textOf = b => plainMd(b.md);
    // The article's own first heading is usually the real title ("Site — Title" -> "Title"),
    // and a short line right after it is its subtitle.
    const first = blocks[0];
    if (first && (first.t === "h" || first.t === "p") && textOf(first).length > 3 && textOf(first).length < 200
        && title.toLowerCase().includes(textOf(first).toLowerCase())) {
      title = textOf(first);
      blocks.shift();
      const next = blocks[0];
      if (next && next.t === "p" && textOf(next).length < 160 && !/[.!?:]$/.test(textOf(next)) && !META_LINE.test(textOf(next))) {
        subtitle = textOf(next);
        blocks.shift();
      }
    }
    const meta = splitMeta(blocks, title, article.siteName || "");
    // Licence boilerplate at the very top (arXiv and journals) isn't content.
    while (blocks[0] && blocks[0].t === "p" && /^(provided proper attribution|licensed under|copyright|©|this work is licensed)/i.test(textOf(blocks[0]))) blocks.shift();
    // Peel a trailing " | Site" / " - Site" segment, as the server does for source titles.
    for (let m; (m = title.match(/^(.*\S)\s+[|–—-]\s+([^|–—]{1,30})$/)); ) title = m[1];
    const host = new URL(url).hostname.replace(/^www\./, "");
    const authors = arxivAuthors.length ? (arxivAuthors.length > 3 ? `${arxivAuthors.slice(0, 3).join(", ")} et al.` : arxivAuthors.join(", ")) : "";
    const by = norm(article.byline || "").replace(/\S+@\S+/g, "").replace(/^email:?\s*/i, "").trim();
    const byline = [authors || by, article.siteName && !host.includes(article.siteName.toLowerCase().replace(/\s/g, "")) ? article.siteName : "", host,
      prettyDate(article.publishedTime), ...meta.filter(m => !/^by\s/i.test(m))]
      .filter((v, i, a) => v && a.findIndex(x => key(x) === key(v)) === i).join(" · ");
    return { title, subtitle, byline, source: url, blocks, footnotes };
  }

  return { run, _debug: { footnoteSection, prepareFootnotes } };
})();
