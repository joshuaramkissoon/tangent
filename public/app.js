// Tangent client. Vanilla JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem("tangent:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tangent:" + k, JSON.stringify(v)); } catch {} },
};

const state = {
  doc: null,
  mode: "quick",
  notes: [],
  active: null,             // active paragraph index (focus mode, voice anchor)
  pending: null,            // { para, text, range } for the selection bar
  cascades: new Map(),      // para index -> units
  scaffold: null,
  config: null,
  settings: {
    profile: store.get("profile", "editorial"),
    scale: store.get("scale", 1),
    ruler: store.get("ruler", false),
    cascade: !!store.get("cascade", false) && "spine", // false | "spine"
    focus: store.get("focus", false),
    brief: store.get("brief", true),
  },
};
let noteSeq = 0;

// ---------------------------------------------------------------- settings

function applySettings() {
  const s = state.settings;
  document.documentElement.dataset.profile = s.profile;
  document.documentElement.style.setProperty("--scale", s.scale);
  $("#sizeOut").value = Math.round(s.scale * 100) + "%";
  $$(".profiles button").forEach(b => b.setAttribute("aria-checked", b.dataset.profile === s.profile));
  $("#ruler").checked = s.ruler;
  $("#rulerBand").hidden = !s.ruler || !state.doc;
  document.body.classList.toggle("focus", s.focus);
  $("#tFocus").setAttribute("aria-pressed", s.focus);
  $("#tCascade").setAttribute("aria-pressed", !!s.cascade);
  $("#tBrief").setAttribute("aria-pressed", s.brief);
  for (const k in s) store.set(k, s[k]);
}

function setSetting(k, v) {
  state.settings[k] = v;
  applySettings();
  if (k === "cascade") renderAllParagraphs();
  if (k === "brief") renderBrief();
  if (k === "focus" && v && state.active == null) setActive(centerParagraph(), false);
  requestAnimationFrame(layoutNotes);
  setTimeout(layoutNotes, 450); // after font/size transitions settle
}

// ---------------------------------------------------------------- loading

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r;
}

// Links: the server fetches the page, Readability extracts it here, and we store the blocks.
// If Readability finds no article, fall back to the server-side extractor.
// The server keeps nothing: each question carries the document it's about.
// Blocks carry the text when present, so paragraphs aren't sent twice; very long texts are cut to what
// the server would use anyway (about 200k characters), which keeps requests under hosting body limits.
function docPayload(d) {
  const full = d.blocks?.length === d.paragraphs.length && d.blocks.every(Boolean);
  const items = full ? d.blocks : d.paragraphs;
  let n = 0, k = 0;
  while (k < items.length && (n += (full ? items[k].md : items[k])?.length || 0) < 210000) k++;
  return { title: d.title, footnotes: d.footnotes || null,
    ...(full ? { blocks: items.slice(0, k) } : { paragraphs: items.slice(0, k) }) };
}

async function readUrl(url) {
  const page = await (await api("/api/fetch?url=" + encodeURIComponent(url))).json();
  if (page.doc) return page.doc;  // PDFs, GitHub READMEs: the server already built the document
  let parsed = null;
  try { parsed = Extract.run(page.html, page.url); } catch (e) { console.warn("extract failed", e); }
  if (!parsed || !parsed.blocks.length) return (await api("/api/extract?url=" + encodeURIComponent(page.url))).json();
  return (await api("/api/doc", parsed)).json();
}

async function load(fn) {
  $("#landingErr").textContent = "";
  $("#landing").classList.add("loading");
  try {
    const res = await fn();
    const doc = typeof res.json === "function" ? await res.json() : res;
    openDoc(doc);
    return true;
  } catch (e) {
    if ($("#landing").hidden) toast(e.message, 5000);
    else $("#landingErr").textContent = e.message;
  } finally {
    $("#landing").classList.remove("loading");
  }
}

function openDoc(doc, restore = null) {
  state.doc = doc;
  state.notes = restore?.notes || [];
  state.cascades = restore?.cascades || new Map();
  state.scaffold = restore?.scaffold || null;
  state.active = null;
  $$(".note").forEach(n => n.remove());
  $("#landing").hidden = true;
  $("#reader").hidden = false;
  $("#askbar").hidden = false;
  document.title = doc.title + " — Tangent";
  const article = $("#article"), head = $("#docHead");
  article.innerHTML = ""; head.innerHTML = "";
  const h = document.createElement("h1");
  h.className = "doc-title"; h.textContent = doc.title;
  head.append(h);
  if (doc.subtitle) {
    const sub = document.createElement("p");
    sub.className = "doc-subtitle";
    sub.textContent = doc.subtitle;
    head.append(sub);
  }
  if (doc.composing || doc.composed) {
    const by = document.createElement("p");
    by.className = "doc-byline composed-by";
    by.id = "composedBy";
    head.append(by);
    renderComposedBy();
  } else if (doc.byline || doc.source) {
    const by = document.createElement("p");
    by.className = "doc-byline";
    const host = doc.source && new URL(doc.source).hostname.replace(/^www\./, "");
    by.textContent = [doc.byline, host && !(doc.byline || "").includes(host) ? host : ""].filter(Boolean).join(" · ");
    head.append(by);
  }
  doc.paragraphs.forEach((_, i) => article.append(makePara(i)));
  $("#endmatter").hidden = true;
  $("#endmatter").innerHTML = "";
  renderCrumbs();
  if (doc.composed && !doc.composing) renderEndmatter();
  renderAllParagraphs();
  renderBrief();
  applySettings();
  if (restore) {
    state.notes.forEach(n => { n.range = null; paraEl(n.para)?.classList.add("has-notes"); placeNote(n); });
    refreshHighlights();
    requestAnimationFrame(() => { layoutNotes(); window.scrollTo(0, restore.y || 0); });
  } else {
    window.scrollTo(0, 0);
  }
  updateHint();
  if (!doc.keepUrl) history.replaceState(null, "", doc.source ? "?url=" + encodeURIComponent(doc.source)
    : doc.question ? `?q=${encodeURIComponent(doc.question)}&len=${doc.length}&level=${doc.level}` : location.pathname);
}

function makePara(i) {
  const para = document.createElement("div");
  para.className = "para"; para.dataset.p = i;
  para.innerHTML = `<button class="pnum" title="Ask about this paragraph">${i + 1}</button><div class="ptext"></div>`;
  return para;
}

// ---------------------------------------------------------------- compose a reading

const composeOpts = { length: store.get("length", "primer"), level: store.get("level", null) };

function renderComposedBy() {
  const by = $("#composedBy"), d = state.doc;
  if (!by) return;
  const opts = `${d.length === "deep" ? "Deep dive" : "Primer"} · ${({ plain: "Plain", expert: "Expert" })[d.level] || "Standard"}`;
  const n = d.sources?.length || 0;
  const checks = d.checks?.length ? ` · <button class="check-count">${d.checks.length} claim${d.checks.length > 1 ? "s" : ""} to check</button>` : "";
  by.innerHTML = d.composing
    ? `<span class="spark pulse">✦</span> ${({ writing: "Writing", sourcing: "Writing done · finding sources", searching: "Searching the web" })[d.phase] || "Thinking"}… <span class="faint">${opts}</span>`
    : d.writtenFirst
      ? `<span class="spark">✦</span> Written by Tangent, checked against ${n} source${n === 1 ? "" : "s"}${checks} <span class="faint">· ${opts}</span>`
      : `<span class="spark">✦</span> Composed by Tangent from ${n} sources <span class="faint">· ${opts}</span>`;
  const cc = $(".check-count", by);
  if (cc) cc.onclick = () => { const c = d.checks[0]; jumpTo(c.p); openCheck(c.p); };
}

async function compose(question, { length = composeOpts.length, level = composeOpts.level || "standard" } = {}) {
  $("#landingErr").textContent = "";
  const doc = { id: null, title: question, question, length, level, paragraphs: [], blocks: [], composing: true, sources: [], cites: {}, checks: [], phase: "thinking" };
  openDoc(doc);
  const writing = document.createElement("div");
  writing.className = "writing";
  writing.innerHTML = `<i></i><i></i><i></i>`;
  $("#article").append(writing);
  // The paragraph being written, shown live until the server confirms it as a block.
  const live = document.createElement("div");
  live.className = "para live";
  live.innerHTML = `<span class="pnum"></span><div class="ptext"></div>`;
  const startWriting = () => { if (doc.phase !== "writing" && doc.phase !== "sourcing") { doc.phase = "writing"; renderComposedBy(); writing.classList.add("started"); } };
  try {
    const r = await fetch("/api/compose", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, length, level }) });
    if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).detail || r.statusText), { status: r.status });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        if (!line.trim() || state.doc !== doc) continue;
        const ev = JSON.parse(line);
        if (ev.type === "start") doc.id = ev.doc_id;
        else if (ev.type === "route") { doc.writtenFirst = !ev.search; if (ev.search && doc.phase === "thinking") { doc.phase = "searching"; renderComposedBy(); } }
        else if (ev.type === "phase") { doc.phase = ev.phase; renderComposedBy(); }
        else if (ev.type === "checks") { doc.checks = ev.checks; doc.checks.forEach(c => renderParagraph(c.p)); }
        else if (ev.type === "title") { startWriting(); doc.title = ev.title; $(".doc-title").textContent = ev.title; document.title = ev.title + " — Tangent"; renderCrumbs(); }
        else if (ev.type === "partial") {
          startWriting();
          if (!live.isConnected) writing.before(live);
          $(".ptext", live).innerHTML = md.block(ev.md) + `<span class="caret"></span>`;
          enhance($(".ptext", live), { refs: false });
        }
        else if (ev.type === "para") {
          // Swap the live paragraph for the final block in place, without a second entrance animation.
          const wasLive = live.isConnected;
          appendParagraph(ev.text, wasLive ? live : writing, ev.block, !wasLive);
          live.remove();
        }
        else if (ev.type === "sources") {
          doc.sources = ev.sources; doc.cites = ev.cites;
          // Citations settle in after first paint: fade them in rather than snapping.
          doc.citesArriving = true;
          doc.paragraphs.forEach((_, i) => renderParagraph(i));
          setTimeout(() => { doc.citesArriving = false; }, 50);
        }
        else if (ev.type === "next") doc.next = ev.questions;
        else if (ev.type === "error") throw new Error(ev.message);
      }
    }
  } catch (e) {
    if (state.doc === doc) toast(e.status ? e.message : "This reading stopped partway. The connection may have dropped.", 10000,
      { label: "Try again", fn: () => compose(question, { length, level }) });
  }
  if (state.doc !== doc) return;
  writing.remove();
  live.remove();
  doc.composing = false;
  doc.composed = true;
  renderComposedBy();
  renderEndmatter();
  renderBrief();
  layoutNotes();
}

function appendParagraph(text, before, block, animate = true) {
  const i = state.doc.paragraphs.push(text) - 1;
  if (block) state.doc.blocks[i] = block;
  const para = makePara(i);
  if (animate) para.classList.add("arriving");
  before.before(para);
  renderParagraph(i);
  if (state.settings.cascade && blockOf(i).t === "p" && !state.cascades.has(i)) cascadeObserver.observe(para);
}

function renderEndmatter() {
  const d = state.doc, el = $("#endmatter");
  const next = d.next || [], sources = d.sources || [];
  if (!next.length && !sources.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    ${next.length ? `<div class="where-next"><h2>Where next</h2>
      <div class="doors">${next.map(q => `<button class="door" data-q="${esc(q)}"><span>${esc(q)}</span><i>→</i></button>`).join("")}</div></div>` : ""}
    ${sources.length ? `<div class="sources"><h2>Sources</h2><ol>${sources.map((s, n) => `
      <li id="src-${n + 1}"><span class="sn">${n + 1}</span>
        <div class="st"><a href="${/^https?:\/\//i.test(s.url) ? esc(s.url) : "#"}" target="_blank" rel="noopener">${esc(s.title)}</a><span class="site">${esc(s.site)}</span></div>
        <button class="read-here" data-url="${esc(s.url)}" title="Open this source in Tangent">Read here</button>
      </li>`).join("")}</ol></div>` : ""}`;
  $$(".door", el).forEach(b => b.onclick = () => { pushTrail(); compose(b.dataset.q, { length: d.length, level: d.level }); });
  $$(".read-here", el).forEach(b => b.onclick = async () => {
    pushTrail();
    if (!(await load(() => readUrl(b.dataset.url)))) state.trail.pop();
  });
}

// ---------------------------------------------------------------- breadcrumbs
// Following "Where next" or "Read here" keeps the reading you came from (with its notes) in memory.

state.trail = [];

function pushTrail() {
  if (!state.doc) return;
  state.trail.push({ doc: state.doc, notes: state.notes, cascades: new Map(state.cascades), scaffold: state.scaffold, y: scrollY });
}

function goToCrumb(k) {
  const snap = state.trail[k];
  state.trail = state.trail.slice(0, k);
  delete $("#crumbs").dataset.expanded;
  openDoc(snap.doc, snap);
}

function renderCrumbs() {
  const nav = $("#crumbs");
  nav.innerHTML = "";
  nav.hidden = !state.trail.length;
  if (!state.trail.length) return;
  const kind = d => d.composed || d.composing ? "✦" : "↗";
  const items = state.trail.map((s, k) => ({ k, doc: s.doc }));
  // Long trails keep the first and last two steps; the middle folds into "…".
  const fold = items.length > 4 && !nav.dataset.expanded;
  const shown = fold ? [items[0], { more: items.length - 3 }, ...items.slice(-2)] : items;
  nav.innerHTML = shown.map(it => it.more
    ? `<button class="crumb more" title="Show ${it.more} more">…</button><span class="sep" aria-hidden="true"></span>`
    : `<button class="crumb" data-k="${it.k}" title="${esc(it.doc.title)}"><i>${kind(it.doc)}</i><span>${esc(it.doc.title)}</span></button><span class="sep" aria-hidden="true"></span>`
  ).join("") + `<span class="crumb here" aria-current="page"><i>${kind(state.doc)}</i><span>${esc(state.doc.title)}</span></span>`;
  $$(".crumb[data-k]", nav).forEach(b => b.onclick = () => goToCrumb(+b.dataset.k));
  const more = $(".crumb.more", nav);
  if (more) more.onclick = () => { nav.dataset.expanded = 1; renderCrumbs(); };
}

function flashSource(n) {
  const li = $("#src-" + n);
  if (!li) return;
  li.scrollIntoView({ block: "center", behavior: "smooth" });
  li.classList.remove("flash"); void li.offsetWidth; li.classList.add("flash");
}

const paraEl = i => $(`.para[data-p="${i}"]`);
const paraText = i => state.doc.paragraphs[i];

// ---------------------------------------------------------------- paragraphs + cascade

const cascadeQueue = [];
let cascadeInflight = 0;
const cascadeObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const i = +e.target.dataset.p;
    cascadeObserver.unobserve(e.target);
    if (!state.cascades.has(i)) enqueueCascade(i);
  }
}, { rootMargin: "600px 0px" });

function enqueueCascade(i) {
  if (cascadeQueue.includes(i)) return;
  cascadeQueue.push(i);
  paraEl(i)?.querySelector(".ptext").classList.add("cascading");
  pumpCascade();
}

function pumpCascade() {
  while (cascadeInflight < 4 && cascadeQueue.length) {
    const i = cascadeQueue.shift(), d = state.doc;
    cascadeInflight++;
    api("/api/cascade", { text: paraText(i) })
      .then(r => r.json())
      .then(({ units }) => { if (state.doc !== d) return; state.cascades.set(i, units); if (state.settings.cascade) renderParagraph(i, true); })
      .catch(() => { paraEl(i)?.querySelector(".ptext").classList.remove("cascading"); })
      .finally(() => { cascadeInflight--; pumpCascade(); });
  }
}

const blockOf = i => state.doc.blocks?.[i] || { t: "p", md: null };

function renderParagraph(i, animate = false) {
  const para = paraEl(i), p = para?.querySelector(".ptext");
  if (!p) return;
  const b = blockOf(i);
  para.dataset.t = b.t;
  para.classList.toggle("brk", !!b.brk);
  if (b.t === "h") para.dataset.lv = b.lv || 2;
  if (b.t === "li") { para.dataset.ord = b.ord ? 1 : ""; p.dataset.n = b.n || ""; para.style.setProperty("--lv", b.lv || 0); }
  const hasMath = b.md && /\$[^$\s][^$]*\$|\\\(|\\\[/.test(b.md);
  if (b.t !== "p" || hasMath) {
    p.classList.remove("cascading", "spine");
    if (b.t === "code") {
      p.innerHTML = `<pre><code class="language-${esc(b.lang || "")}"></code></pre>`;
      $("code", p).textContent = b.md;
      enhance(p, { refs: false });
    } else if (b.t === "table") {
      p.innerHTML = md.block(b.md);
    } else if (b.t === "img") {
      p.innerHTML = `<figure><img loading="lazy" alt=""><figcaption></figcaption></figure>`;
      const img = $("img", p);
      img.src = b.src; img.alt = b.alt || "";
      img.onload = () => layoutNotes();
      img.onerror = () => para.remove();
      if (b.md) $("figcaption", p).innerHTML = md.inline(b.md); else $("figcaption", p).remove();
    } else {
      p.innerHTML = md.inline(b.md);
    }
    appendCites(p, i);
    refreshHighlights();
    layoutNotes();
    return;
  }
  const units = state.settings.cascade && state.cascades.get(i);
  p.classList.remove("cascading", "cascade-in");
  p.classList.toggle("spine", !!units && state.settings.cascade === "spine");
  if (units) {
    p.innerHTML = "";
    units.forEach((u, n) => {
      const span = document.createElement("span");
      span.className = `cascade-unit ${u.r === "detail" ? "detail" : "main"}`;
      span.style.cssText = `--i:${u.i};--n:${n}`;
      span.textContent = u.t + (n < units.length - 1 ? " " : "");
      p.append(span);
    });
  } else {
    if (b.md) p.innerHTML = md.inline(b.md);
    else p.textContent = paraText(i);
    if (state.settings.cascade) p.classList.add("cascading");
  }
  appendCites(p, i);
  refreshHighlights();
  layoutNotes();
}

function appendCites(p, i) {
  const check = state.doc.checks?.find(c => c.p === i);
  if (check) {
    const b = document.createElement("button");
    b.className = "check-mark";
    b.title = "A source disagrees with this paragraph";
    b.textContent = "check";
    b.onclick = e => { e.stopPropagation(); openCheck(i, b); };
    p.append(b);
  }
  const cites = state.doc.cites?.[i];
  if (!cites?.length) return;
  const sup = document.createElement("sup");
  sup.className = "cites" + (state.doc.citesArriving ? " arriving" : "");
  sup.innerHTML = cites.map(n => `<button class="cite" data-n="${n}" title="${esc(state.doc.sources[n - 1]?.site || "")}">${n}</button>`).join("");
  p.append(sup);
}

function renderAllParagraphs() {
  if (!state.doc) return;
  cascadeQueue.length = 0;
  state.doc.paragraphs.forEach((_, i) => {
    renderParagraph(i);
    if (state.settings.cascade && blockOf(i).t === "p" && !state.cascades.has(i)) cascadeObserver.observe(paraEl(i));
  });
}

// ---------------------------------------------------------------- brief (pre-reading scaffold)

async function renderBrief() {
  const el = $("#brief");
  // A composed reading is already a primer, so it gets no brief.
  if (!state.doc || !state.settings.brief || state.doc.composing || state.doc.composed || !state.doc.paragraphs.length) { el.hidden = true; layoutNotes(); return; }
  el.hidden = false;
  if (!state.scaffold) {
    el.innerHTML = `<h2>Before you read</h2><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:80%"></div>`;
    layoutNotes();
    try {
      const docId = state.doc.id;
      const s = await (await api("/api/scaffold", { doc: docPayload(state.doc) })).json();
      if (state.doc?.id !== docId) return;
      state.scaffold = s;
    } catch (e) {
      el.innerHTML = `<h2>Before you read</h2><p class="err">Couldn't prepare this: ${esc(e.message)}</p>`;
      return;
    }
  }
  const s = state.scaffold;
  el.innerHTML = `<h2>Before you read</h2>
    <p class="gist">${esc(String(s.gist || ""))}</p>
    <ol>${[].concat(s.points || []).map(p => `<li>${linkParas(esc(p))}</li>`).join("")}</ol>
    ${Array.isArray(s.terms) && s.terms.length ? `<dl class="terms">${s.terms.map(t => `<dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd>`).join("")}</dl>` : ""}`;
  el.querySelectorAll(".pref").forEach(b => b.onclick = () => jumpTo(+b.dataset.p));
  layoutNotes();
}

// ---------------------------------------------------------------- notes

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function linkParas(html) {
  return html.replace(/¶\s?(\d+)(?:\s?[-–]\s?(\d+))?/g, (m, a, b) => `<button class="pref" data-p="${a - 1}">${m}</button>`);
}

// ---------------------------------------------------------------- markdown

// ==text== renders as a highlight (the model marks what matters).
marked.use({
  gfm: true, breaks: false,
  extensions: [{
    name: "mark", level: "inline",
    start(src) { return src.indexOf("=="); },
    tokenizer(src) {
      const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
      if (m) return { type: "mark", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
  }, {
    // $$display$$ and \[display\], then $inline$ and \(inline\). "$5 and $10" is not maths:
    // no space just inside the dollars, and the closing $ can't be followed by a digit.
    name: "mathBlock", level: "inline",
    start(src) { const i = src.search(/(?<!\\)\$\$|(?<!\\)\\\[/); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
      if (m) return { type: "mathBlock", raw: m[0], tex: m[1] };
    },
    renderer(t) { return katexHtml(t.tex, true); },
  }, {
    name: "mathInline", level: "inline",
    start(src) { const i = src.search(/(?<!\\)\$|(?<!\\)\\\(/); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = /^\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)/.exec(src) || /^\\\(([\s\S]+?)\\\)/.exec(src);
      if (m) return { type: "mathInline", raw: m[0], tex: m[1] };
    },
    renderer(t) { return katexHtml(t.tex, false); },
  }, {
    name: "fnref", level: "inline",
    start(src) { return src.indexOf("[^"); },
    tokenizer(src) {
      const m = /^\[\^([\w-]{1,12})\]/.exec(src);
      if (m) return { type: "fnref", raw: m[0], n: m[1] };
    },
    renderer(t) { return `<sup class="fnref"><button class="fn" data-fn="${t.n}" aria-label="Footnote ${t.n}">${t.n}</button></sup>`; },
  }],
});
const PURIFY = { ADD_ATTR: ["target"] };

function katexHtml(tex, display) {
  if (!window.katex) return esc(tex);
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" }); }
  catch { return esc(tex); }
}

// Escape "<" outside code so things like "<colesbury at gmail.com>" aren't eaten as HTML.
function escapeAngles(src) {
  return src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, n) => n % 2 ? part : part.replace(/</g, "&lt;")).join("");
}
const md = {
  block: src => DOMPurify.sanitize(marked.parse(escapeAngles(src)), PURIFY),
  inline: src => DOMPurify.sanitize(marked.parseInline(escapeAngles(src)), PURIFY),
};

function toPlain(src) {
  return src.replace(/```[\s\S]*?(```|$)/g, " [code] ").replace(/==|\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
}

// After rendering: syntax-highlight code, add copy buttons, turn ¶N into links.
function enhance(root, { refs = true } = {}) {
  $$("pre > code", root).forEach(code => {
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1];
    if (lang && !hljs.getLanguage(lang)) code.className = "";
    if (!code.dataset.hl) { hljs.highlightElement(code); code.dataset.hl = 1; }
    const pre = code.parentElement;
    if (!$(".copy-code", pre)) {
      const b = document.createElement("button");
      b.className = "copy-code"; b.textContent = "Copy";
      b.onclick = e => { e.stopPropagation(); navigator.clipboard?.writeText(code.innerText); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); };
      pre.append(b);
    }
  });
  $$("a", root).forEach(a => { a.target = "_blank"; a.rel = "noopener"; });
  if (!refs) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => /¶\s?\d/.test(n.data) && !n.parentElement.closest("pre, code, button") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => {
    const span = document.createElement("span");
    span.innerHTML = linkParas(esc(n.data));
    n.replaceWith(...span.childNodes);
  });
}

const KIND_LABEL = { ask: "Ask", explain: "Explain", define: "Define", simplify: "Plain words", ask_doc: "Ask" };
const DEBUG = new URLSearchParams(location.search).has("debug");
const STALL_MS = 20000; // no bytes for this long → treat the connection as dropped

function firstSentence(text) {
  const t = toPlain(text);
  const m = t.match(/^.+?[.!?](?=\s|$)/);
  return (m ? m[0] : t).replace(/¶\s?/g, "¶");
}

function createNote({ kind, para, selection = "", question = "", range = null }) {
  const note = { id: ++noteSeq, kind, para, selection, range, history: [], turns: [], collapsed: false };
  const el = document.createElement("div");
  el.className = "note";
  el.innerHTML = `
    <div class="note-head" role="button" tabindex="0">
      <span class="kind">${KIND_LABEL[kind]}</span><span class="q"></span>
      <span class="count" hidden></span>
      <button class="x" aria-label="Remove note" title="Remove">×</button>
    </div>
    <div class="peek"></div>
    <div class="note-scroll at-top at-bottom"><div class="note-body"></div></div>
    <div class="note-foot">
      <span class="meta"></span><span class="spacer"></span>
      <button class="copy" title="Copy the latest answer">Copy</button>
    </div>
    <form class="followup">
      <input placeholder="Ask a follow-up" autocomplete="off" aria-label="Ask a follow-up">
      <button class="send" aria-label="Send" tabindex="-1">↵</button>
    </form>`;
  const q = $(".q", el);
  if (kind === "simplify") q.textContent = `¶${para + 1}`;
  else if (selection) { q.innerHTML = `<mark class="spec"></mark>`; q.firstChild.textContent = selection; }
  else { q.classList.add("asked"); q.textContent = question; }
  note.el = el;
  state.notes.push(note);
  state.notes.forEach(n => n !== note && setCollapsed(n, true));

  $(".note-head", el).addEventListener("click", e => {
    if (e.target.closest(".x")) return removeNote(note);
    const expand = note.collapsed;
    if (expand) state.notes.forEach(n => n !== note && setCollapsed(n, true));
    setCollapsed(note, !expand);
  });
  $(".copy", el).addEventListener("click", () => {
    const last = [...note.turns].reverse().find(t => t.a && !t.error);
    if (last) { navigator.clipboard?.writeText(last.a.trim()); toast("Copied"); }
  });
  const form = $(".followup", el), input = $("input", form);
  input.addEventListener("input", () => form.classList.toggle("has-text", !!input.value.trim()));
  form.addEventListener("submit", e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = ""; form.classList.remove("has-text");
    runTurn(note, { kind: "ask", question: q, followup: true });
  });
  $(".note-scroll", el).addEventListener("scroll", e => updateScrollEdges(e.target), { passive: true });
  el.addEventListener("mouseenter", () => setHover(note));
  el.addEventListener("mouseleave", () => setHover(null));
  el.addEventListener("click", e => { const b = e.target.closest(".pref"); if (b) jumpTo(+b.dataset.p); });

  paraEl(para).classList.add("has-notes");
  placeNote(note);
  refreshHighlights();
  updateHint();
  runTurn(note, { kind, question });
  return note;
}

function describeTurn(note, kind, question) {
  const p = note.para + 1;
  if (kind === "explain") return `Explain "${note.selection}" in ¶${p}.`;
  if (kind === "define") return `Define "${note.selection}" in ¶${p}.`;
  if (kind === "simplify") return `Rewrite ¶${p} in plain words.`;
  if (kind === "ask_doc") return question;
  return `About ¶${p}${note.selection ? ` ("${note.selection}")` : ""}: ${question}`;
}

// A thread keeps only its newest answer open. Earlier turns fold into a one-line "trail"
// (question + the answer's first sentence); clicking one opens it in place.
function renderTurn(note, turn) {
  const el = turn.el;
  const isFirst = note.turns[0] === turn;
  const q = turn.q ?? (isFirst ? (note.selection || $(".q", note.el).textContent) : "");
  const answer = turn.error
    ? `<div class="turn-err"><span>${esc(turn.error)}</span><button class="retry">Try again</button></div>`
    : `<div class="answer">${turn.a ? md.block(turn.a) : ""}</div>${turn.done ? "" : `<span class="caret"></span>`}`;
  el.innerHTML = `
    <button class="trail" aria-expanded="${!el.classList.contains("folded")}">
      <span class="tq">${esc(q)}</span><span class="tg">${turn.error ? "Didn't arrive" : esc(firstSentence(turn.a))}</span><span class="chev" aria-hidden="true"></span>
    </button>
    <div class="turn-full"><div class="turn-inner">
      ${turn.q ? `<p class="turn-q">${esc(turn.q)}</p>` : ""}${answer}
    </div></div>`;
  const ans = $(".answer", el);
  if (ans) enhance(ans);
  // Earlier turns keep their trail as a handle: click to open, click again to fold.
  $(".trail", el).onclick = () => {
    el.classList.toggle("folded");
    $(".trail", el).setAttribute("aria-expanded", !el.classList.contains("folded"));
    layoutSoon();
  };
  const retry = $(".retry", el);
  if (retry) retry.onclick = () => {
    el.remove();
    note.turns = note.turns.filter(t => t !== turn);
    runTurn(note, turn.params);
  };
}

function updateCount(note) {
  const c = $(".count", note.el);
  const n = note.turns.length;
  c.hidden = n < 2;
  c.textContent = n;
  c.title = `${n} questions in this thread`;
}

function updateScrollEdges(sc) {
  sc.classList.toggle("at-top", sc.scrollTop < 4);
  sc.classList.toggle("at-bottom", sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4);
}

async function runTurn(note, params) {
  const { kind, question, followup = false } = params;
  // Show the question inside the thread unless the note's header already is the question.
  const showQ = followup || (question && note.selection && kind === "ask");
  const turn = { q: showQ ? question : null, a: "", done: false, error: null, params };
  note.turns.forEach(t => { if (t.el && !t.error) t.el.classList.add("folded"); });
  note.turns.push(turn);
  turn.el = document.createElement("section");
  turn.el.className = "turn" + (note.turns.length > 1 ? " entering" : "");
  $(".note-body", note.el).append(turn.el);
  updateCount(note);
  setCollapsed(note, false);
  const scroller = $(".note-scroll", note.el);
  const draw = () => {
    const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    renderTurn(note, turn);
    const lastGood = [...note.turns].reverse().find(t => t.a && !t.error);
    $(".peek", note.el).textContent = lastGood ? firstSentence(lastGood.a) : "";
    // keep the newest words in view while they stream, unless the reader scrolled up
    if (stick || !turn.a) scroller.scrollTop = scroller.scrollHeight;
    updateScrollEdges(scroller);
    layoutNotes();
  };
  draw();
  // when a follow-up starts, bring its trail + new turn into view
  if (followup) turn.el.scrollIntoView({ block: "nearest" });

  const sendKind = followup ? "ask" : kind;
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), STALL_MS);
  const t0 = performance.now();
  let ttft = null, model = "";
  try {
    const r = await fetch("/api/ask", {
      method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc: docPayload(state.doc), kind: sendKind, para: note.para + 1, selection: note.selection,
        question, mode: state.mode, history: note.history.slice(-30) }),
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    model = r.headers.get("X-Model") || "";
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), STALL_MS);
      if (ttft == null) ttft = (performance.now() - t0) / 1000;
      turn.a += dec.decode(value, { stream: true });
      const k = turn.a.indexOf("\x00");
      if (k >= 0) { console.warn(turn.a.slice(k + 1)); turn.a = turn.a.slice(0, k); throw new Error("model"); }
      draw();
    }
    note.history.push({ role: "user", content: describeTurn(note, sendKind, question) }, { role: "assistant", content: turn.a });
    if (DEBUG) $(".meta", note.el).textContent = `${prettyModel(model)} · ${state.mode} · ${ttft?.toFixed(2)}s · ${((performance.now() - t0) / 1000).toFixed(2)}s`;
  } catch (e) {
    turn.error = !navigator.onLine ? "You're offline. Reconnect and try again."
      : e.name === "AbortError" ? "This is taking too long. The connection may have dropped."
      : e.message === "model" ? "The model didn't finish this answer."
      : e instanceof TypeError ? "Couldn't reach the server."
      : e.message;
    turn.el.classList.remove("folded");
  } finally {
    clearTimeout(stall);
  }
  turn.done = true;
  draw();
  setTimeout(() => turn.el.classList.remove("entering"), 400);
}

function prettyModel(m) {
  return m.split("/").pop().replace(/^gemini-/, "Gemini ").replace(/-/g, " ").replace(/\bflash\b/i, "Flash").replace(/\blite\b/i, "Lite");
}

function setCollapsed(note, c) {
  note.collapsed = c;
  note.el.classList.toggle("collapsed", c);
  layoutNotes();
}

function removeNote(note) {
  setHover(null);
  state.notes = state.notes.filter(n => n !== note);
  if (!state.notes.some(n => n.para === note.para)) paraEl(note.para)?.classList.remove("has-notes");
  refreshHighlights();
  note.el.classList.add("leaving");
  setTimeout(() => { if (!state.notes.includes(note)) note.el.remove(); layoutNotes(); updateHint(); }, 220);
  toast("Note removed", 5000, { label: "Undo", fn: () => restoreNote(note) });
}

function restoreNote(note) {
  if (state.notes.includes(note)) return;
  note.el.classList.remove("leaving");
  state.notes.push(note);
  paraEl(note.para)?.classList.add("has-notes");
  placeNote(note);
  refreshHighlights();
  updateHint();
  layoutNotes();
}

// A claim a source contradicts: shown in the margin as a sidenote with the quote and what the source says.
function openCheck(i, marker) {
  const c = state.doc.checks?.find(x => x.p === i);
  if (!c) return;
  state.doc.footnotes = state.doc.footnotes || {};
  const key = `check-${i}`;
  state.doc.footnotes[key] = `> ${c.claim}\n\n${c.note}`;
  openSidenote(i, key, marker, "Check this");
}

// Footnotes open as quiet sidenotes beside their paragraph: the author's own notes, styled apart from AI notes.
function openSidenote(para, n, marker, label = null) {
  const existing = state.notes.find(x => x.kind === "fn" && x.fn === n);
  if (existing) {
    state.notes.forEach(x => x !== existing && setCollapsed(x, true));
    setCollapsed(existing, !existing.collapsed ? true : false);
    return;
  }
  const text = state.doc.footnotes?.[n];
  if (!text || para == null) return;
  const note = { id: ++noteSeq, kind: "fn", fn: n, para, selection: "", range: null, history: [], turns: [], collapsed: false };
  const el = document.createElement("div");
  el.className = "note sidenote";
  el.innerHTML = `
    <div class="note-head" role="button" tabindex="0"><span class="kind">${esc(label || `Note ${n}`)}</span><span class="q"></span>
      <button class="x" aria-label="Close note" title="Close">×</button></div>
    <div class="peek"></div>
    <div class="note-scroll at-top at-bottom"><div class="note-body"><div class="answer"></div></div></div>`;
  $(".answer", el).innerHTML = md.block(text);
  enhance($(".answer", el), { refs: false });
  $(".peek", el).textContent = toPlain(text);
  note.el = el;
  $(".note-head", el).addEventListener("click", e => {
    if (e.target.closest(".x")) { marker?.classList.remove("open"); return removeNote(note); }
    const expand = note.collapsed;
    if (expand) state.notes.forEach(x => x !== note && setCollapsed(x, true));
    setCollapsed(note, !expand);
  });
  state.notes.forEach(x => setCollapsed(x, true));
  state.notes.push(note);
  marker?.classList.add("open");
  paraEl(para).classList.add("has-notes");
  placeNote(note);
  updateHint();
  layoutNotes();
}

let layoutRaf;
function layoutSoon() { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layoutNotes); }

function updateHint() { $("#marginHint").style.opacity = state.notes.length ? 0 : 1; }

const wide = () => matchMedia("(min-width: 1001px)").matches;

function placeNote(note) {
  if (wide()) {
    note.el.classList.remove("inline");
    if (note.el.parentElement !== $("#margin")) $("#margin").append(note.el);
  } else {
    note.el.classList.add("inline");
    note.el.style.top = "";
    // after the paragraph and any notes already under it
    let anchor = paraEl(note.para);
    while (anchor.nextElementSibling?.classList.contains("note")) anchor = anchor.nextElementSibling;
    if (note.el.previousElementSibling !== anchor || note.el.parentElement !== anchor.parentElement) anchor.after(note.el);
  }
}

function layoutNotes() {
  if (!state.doc) return;
  if (!wide()) { state.notes.forEach(placeNote); return; }
  const margin = $("#margin");
  const sorted = [...state.notes].sort((a, b) => a.para - b.para || a.id - b.id);
  let bottom = 0;
  for (const n of sorted) {
    placeNote(n);
    const p = paraEl(n.para);
    const want = p.offsetTop - margin.offsetTop;
    const top = Math.max(want, bottom + 10);
    n.el.style.top = top + "px";
    bottom = top + n.el.offsetHeight;
  }
  margin.style.minHeight = bottom + "px";
}

// ---------------------------------------------------------------- highlights (non-destructive)

function findRange(i, text) {
  const p = paraEl(i)?.querySelector(".ptext");
  if (!p || !text) return null;
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const k = node.data.indexOf(text);
    if (k >= 0) { const r = new Range(); r.setStart(node, k); r.setEnd(node, k + text.length); return r; }
  }
  return null;
}

function refreshHighlights() {
  if (!window.CSS?.highlights) return;
  const ranges = [];
  for (const n of state.notes) {
    if (!n.selection) continue;
    if (!n.range || !n.range.startContainer.isConnected) n.range = findRange(n.para, n.selection);
    if (n.range) ranges.push(n.range);
  }
  CSS.highlights.set("tangent-notes", new Highlight(...ranges));
}

function setHover(note) {
  if (!window.CSS?.highlights) return;
  if (note?.range) CSS.highlights.set("tangent-hover", new Highlight(note.range));
  else CSS.highlights.delete("tangent-hover");
}

// ---------------------------------------------------------------- selection bar

const selbar = $("#selbar");
const selAsk = $(".selbar-ask", selbar);
const selInput = $("input", selAsk);

function paraOf(node) {
  const el = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.(".para");
  return el ? +el.dataset.p : null;
}

function showSelbar(rect) {
  selbar.hidden = false;
  selAsk.hidden = true;
  $(".selbar-actions", selbar).hidden = false;
  const w = selbar.offsetWidth, h = selbar.offsetHeight;
  const below = matchMedia("(pointer: coarse)").matches; // avoid the native menu on touch
  let top = below ? rect.bottom + 10 : rect.top - h - 10;
  if (top < 60) top = rect.bottom + 10;
  selbar.style.top = top + "px";
  selbar.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + "px";
}

function hideSelbar() { selbar.hidden = true; state.pending = null; }

let selTimer;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (document.activeElement === selInput) return;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { if (state.pending?.text) hideSelbar(); return; }
    const range = sel.getRangeAt(0);
    const i = paraOf(range.startContainer);
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (i == null || !text || text.length > 1500) return;
    state.pending = { para: i, text, range: range.cloneRange() };
    setActive(i, false);
    showSelbar(range.getBoundingClientRect());
  }, 120);
});

$("#article").addEventListener("click", e => {
  const cite = e.target.closest(".cite");
  if (cite) return flashSource(cite.dataset.n);
  const fn = e.target.closest(".fn");
  if (fn) return openSidenote(paraOf(fn), fn.dataset.fn, fn);
  const num = e.target.closest(".pnum");
  if (num) {
    const i = paraOf(num);
    state.pending = { para: i, text: "", range: null };
    setActive(i, false);
    showSelbar(num.getBoundingClientRect());
    openSelAsk("");
    return;
  }
  const p = e.target.closest(".para");
  if (p && getSelection().isCollapsed) setActive(+p.dataset.p, false);
});

function openSelAsk(initial) {
  $(".selbar-actions", selbar).hidden = true;
  selAsk.hidden = false;
  selInput.placeholder = state.pending?.text ? "Ask about this…" : `Ask about ¶${state.pending.para + 1}…`;
  selInput.value = initial;
  selInput.focus();
}

selbar.addEventListener("mousedown", e => { if (!e.target.closest("input")) e.preventDefault(); }); // keep text selection alive

selbar.addEventListener("click", e => {
  const act = e.target.closest("button")?.dataset.act;
  const pend = state.pending;
  if (!act || !pend || act === "mic") return;
  if (act === "ask") return openSelAsk("");
  if ((act === "explain" || act === "define") && !pend.text) return openSelAsk("");
  createNote({ kind: act, para: pend.para, selection: act === "simplify" ? "" : pend.text, range: act === "simplify" ? null : pend.range });
  getSelection().removeAllRanges();
  hideSelbar();
});

selAsk.addEventListener("submit", e => {
  e.preventDefault();
  const q = selInput.value.trim();
  const pend = state.pending;
  if (!q || !pend) return;
  createNote({ kind: "ask", para: pend.para, selection: pend.text, question: q, range: pend.range });
  getSelection().removeAllRanges();
  hideSelbar();
});
selInput.addEventListener("keydown", e => { if (e.key === "Escape") { hideSelbar(); getSelection().removeAllRanges(); } });
selInput.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== selInput && !selInput.value) hideSelbar(); }, 150));
window.addEventListener("scroll", () => { if (!selbar.hidden && document.activeElement !== selInput) hideSelbar(); }, { passive: true });

// ---------------------------------------------------------------- focus / active paragraph

function centerParagraph() {
  const y = innerHeight * 0.4;
  let best = 0, bestD = Infinity;
  $$(".para").forEach(p => {
    const r = p.getBoundingClientRect();
    const d = r.top <= y && r.bottom >= y ? 0 : Math.min(Math.abs(r.top - y), Math.abs(r.bottom - y));
    if (d < bestD) { bestD = d; best = +p.dataset.p; }
  });
  return best;
}

function setActive(i, scroll) {
  if (i == null || !state.doc) return;
  state.active = i;
  $$(".para.active").forEach(p => p.classList.remove("active"));
  paraEl(i)?.classList.add("active");
  if (scroll) { lastKeyNav = Date.now(); paraEl(i).scrollIntoView({ block: "center", behavior: "smooth" }); }
}

function jumpTo(i) {
  if (i < 0 || i >= state.doc.paragraphs.length) return;
  setActive(i, true);
}

// Header: always visible; a hairline along its edge shows reading progress.
function updateBar() {
  const bar = $(".bar"), y = scrollY;
  bar.classList.toggle("scrolled", y > 8);
  const reading = state.doc && !$("#reader").hidden;
  const max = document.documentElement.scrollHeight - innerHeight;
  $("#progressFill").style.transform = `scaleX(${reading && max > 0 ? Math.min(1, y / max) : 0})`;
}

let lastKeyNav = 0, scrollTimer;
window.addEventListener("scroll", () => {
  updateBar();
  if (!state.settings.focus || Date.now() - lastKeyNav < 900) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => setActive(centerParagraph(), false), 80);
}, { passive: true });

// ---------------------------------------------------------------- voice

// Records audio ourselves (getUserMedia always shows the browser's permission prompt, unlike the
// Web Speech API) and transcribes server-side with Whisper.
const voice = { rec: null, ctx: null, startedAt: 0, toggled: false, button: null, stopWanted: false, stream: null, chunks: [], meter: null };

function voiceContext() {
  const pend = state.pending;
  if (pend) return { kind: "ask", para: pend.para, selection: pend.text, range: pend.range };
  const i = state.active ?? centerParagraph();
  return { kind: "ask_doc", para: i, selection: "", range: null };
}

async function startVoice(button) {
  if (!state.doc || voice.rec) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Voice isn't supported in this browser");
  Object.assign(voice, { rec: "starting", stopWanted: false, ctx: voiceContext(), startedAt: Date.now(), button, chunks: [] });
  button?.classList.add("held");
  $("#heard").textContent = "Starting mic…";
  $("#listenAbout").textContent = voice.ctx.selection
    ? `About “${voice.ctx.selection.slice(0, 60)}${voice.ctx.selection.length > 60 ? "…" : ""}”`
    : `About the whole text · note goes by ¶${voice.ctx.para + 1}`;
  $("#listening").hidden = false;
  const asked = Date.now();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    resetVoice();
    return micError(e);
  }
  // If the permission prompt was up and the key/button was released meanwhile, don't record a stub.
  if (voice.stopWanted && Date.now() - asked > 700) {
    stream.getTracks().forEach(t => t.stop());
    resetVoice();
    return toast("Mic is on. Hold V (or the mic) while you talk", 3000);
  }
  voice.stream = stream;
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = e => { if (e.data.size) voice.chunks.push(e.data); };
  rec.onstop = sendVoice;
  voice.rec = rec;
  startMeter(stream);
  rec.start();
  $("#heard").textContent = "Listening…";
  if (voice.stopWanted) stopVoice();
}

function stopVoice() {
  if (voice.rec === "starting") voice.stopWanted = true;
  else if (voice.rec?.state === "recording") voice.rec.stop();
}

async function sendVoice() {
  const { ctx, chunks } = voice;
  const type = voice.rec.mimeType || "audio/webm";
  stopMeter();
  voice.stream?.getTracks().forEach(t => t.stop());
  const blob = new Blob(chunks, { type });
  if (Date.now() - voice.startedAt < 500 || blob.size < 1500) { resetVoice(); return toast("Didn't catch that. Hold while you talk"); }
  $("#heard").textContent = "Transcribing…";
  const fd = new FormData();
  fd.append("file", blob, "question." + (type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm"));
  // Vocabulary hint so names and jargon from the text get spelled right.
  fd.append("prompt", `${state.doc.title}. ${ctx.selection || paraText(ctx.para).slice(0, 300)}`);
  try {
    const r = await fetch("/api/transcribe", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || r.statusText);
    resetVoice();
    if (!data.text) return toast("Didn't catch that");
    createNote({ ...ctx, question: data.text });
    getSelection().removeAllRanges();
    hideSelbar();
  } catch (e) {
    resetVoice();
    toast(e.message, 4000);
  }
}

function resetVoice() {
  stopMeter();
  voice.button?.classList.remove("held");
  Object.assign(voice, { rec: null, toggled: false, button: null, stream: null, stopWanted: false });
  $("#listening").hidden = true;
}

function micError(e) {
  if (e.name === "NotAllowedError" || e.name === "SecurityError") {
    toast("Microphone is blocked. Allow it from the icon at the left of the address bar. If there's no prompt, check System Settings › Privacy & Security › Microphone for your browser.", 8000);
  } else if (e.name === "NotFoundError") {
    toast("Your computer isn't reporting a microphone. Connect one, or pick an input in System Settings › Sound › Input.", 6000);
  } else {
    toast("Mic error: " + (e.message || e.name), 4000);
  }
}

// Live level meter on the five bars, so you can see the mic is hearing you.
function startMeter(stream) {
  try {
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const bars = $$("#listening .wave i");
    $("#listening .wave").classList.add("live");
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      bars.forEach((b, k) => { b.style.transform = `scaleY(${0.15 + level * [0.6, 0.85, 1, 0.85, 0.6][k]})`; });
      voice.meter.raf = requestAnimationFrame(tick);
    };
    voice.meter = { ac, raf: requestAnimationFrame(tick) };
  } catch {}
}

function stopMeter() {
  if (!voice.meter) return;
  cancelAnimationFrame(voice.meter.raf);
  voice.meter.ac.close().catch(() => {});
  voice.meter = null;
  $("#listening .wave").classList.remove("live");
  $$("#listening .wave i").forEach(b => (b.style.transform = ""));
}

// Press-and-hold to talk; a quick tap toggles instead (for people who can't hold).
function bindMic(btn) {
  btn.addEventListener("pointerdown", e => {
    e.preventDefault();
    if (voice.rec && voice.toggled) return stopVoice();
    startVoice(btn);
  });
  btn.addEventListener("pointerup", () => {
    if (!voice.rec) return;
    if (Date.now() - voice.startedAt < 350) { voice.toggled = true; toast("Listening. Tap again to send"); }
    else stopVoice();
  });
  btn.addEventListener("contextmenu", e => e.preventDefault());
}
bindMic($("#askMic"));
bindMic($('[data-act="mic"]', selbar));

// ---------------------------------------------------------------- ask bar + modes

$("#askForm").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("#askInput").value.trim();
  if (!q) return;
  createNote({ kind: "ask_doc", para: state.active ?? centerParagraph(), question: q });
  $("#askInput").value = "";
  $("#askInput").blur();
});

$$(".modes button").forEach(b => b.addEventListener("click", () => {
  state.mode = b.dataset.mode;
  $$(".modes button").forEach(x => x.setAttribute("aria-pressed", x === b));
}));

// ---------------------------------------------------------------- keyboard

const typing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);

document.addEventListener("keydown", e => {
  if (!state.doc || $("#reader").hidden) return;
  if (e.altKey && e.code === "KeyA") { e.preventDefault(); $("#askInput").focus(); return; }
  if (typing()) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // "Just start typing": with a passage selected, any printable key opens the ask box.
  // V stays reserved for hold-to-talk.
  if (state.pending && !selbar.hidden && e.key.length === 1 && e.code !== "KeyV") {
    e.preventDefault();
    openSelAsk(e.key);
    return;
  }
  if (e.code === "KeyV" && !e.repeat) { e.preventDefault(); startVoice(null); return; }
  if (e.key === "j" || e.key === "ArrowDown" && state.settings.focus) { e.preventDefault(); jumpTo((state.active ?? -1) + 1); }
  else if (e.key === "k" || e.key === "ArrowUp" && state.settings.focus) { e.preventDefault(); jumpTo((state.active ?? 1) - 1); }
  else if (e.key === "s") setSetting("cascade", nextCascade());
  else if (e.key === "f") setSetting("focus", !state.settings.focus);
  else if (e.key === "b") setSetting("brief", !state.settings.brief);
  else if (e.key === "Escape") { hideSelbar(); $("#profilePanel").hidden = true; }
});
document.addEventListener("keyup", e => { if (e.code === "KeyV" && voice.rec && !voice.button) stopVoice(); });

// ---------------------------------------------------------------- chrome wiring

const nextCascade = () => (state.settings.cascade ? false : "spine");
$("#tCascade").onclick = () => setSetting("cascade", nextCascade());
$("#tFocus").onclick = () => setSetting("focus", !state.settings.focus);
$("#tBrief").onclick = () => setSetting("brief", !state.settings.brief);
$("#tProfile").onclick = e => { e.stopPropagation(); $("#profilePanel").hidden = !$("#profilePanel").hidden; };
document.addEventListener("click", e => { if (!e.target.closest("#profilePanel, #tProfile")) $("#profilePanel").hidden = true; });
$$(".profiles button").forEach(b => b.onclick = () => setSetting("profile", b.dataset.profile));
$("#sizeUp").onclick = () => setSetting("scale", Math.min(1.6, +(state.settings.scale + 0.1).toFixed(2)));
$("#sizeDown").onclick = () => setSetting("scale", Math.max(0.8, +(state.settings.scale - 0.1).toFixed(2)));
$("#ruler").onchange = e => setSetting("ruler", e.target.checked);
document.addEventListener("pointermove", e => { if (state.settings.ruler) $("#rulerBand").style.top = e.clientY + "px"; }, { passive: true });

$("#home").onclick = () => {
  state.trail = [];
  $("#reader").hidden = true; $("#askbar").hidden = true; $("#landing").hidden = false;
  $("#rulerBand").hidden = true; state.doc = null; $("#progressFill").style.transform = "scaleX(0)";
  history.replaceState(null, "", location.pathname);
};
const looksLikeUrl = v => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v.trim()) && !/\s/.test(v.trim());

function updateIntent() {
  const v = $("#urlInput").value.trim();
  const url = looksLikeUrl(v);
  $("#intent").innerHTML = !v ? "" : url ? "↗ Read this link" : `<span class="spark">✦</span> Compose a reading on this`;
  $("#composeOpts").hidden = !v || url;
  $("#goBtn").textContent = !v || url ? "Read" : "Compose";
}
$("#urlInput").addEventListener("input", updateIntent);

function syncSegs() {
  const level = composeOpts.level || (state.settings.profile === "clear" ? "plain" : "standard");
  $$("#composeOpts .seg").forEach(seg => {
    const cur = seg.dataset.opt === "length" ? composeOpts.length : level;
    $$("button", seg).forEach(b => b.setAttribute("aria-pressed", b.dataset.v === cur));
  });
}
$$("#composeOpts .seg button").forEach(b => b.onclick = () => {
  const opt = b.parentElement.dataset.opt;
  composeOpts[opt] = b.dataset.v;
  store.set(opt, b.dataset.v);
  syncSegs();
});
syncSegs();

$("#urlForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("#urlInput").value.trim();
  if (!v) return;
  state.trail = [];
  if (looksLikeUrl(v)) {
    const url = /^https?:\/\//i.test(v) ? v : "https://" + v;
    load(() => readUrl(url));
  } else {
    compose(v, { length: composeOpts.length, level: composeOpts.level || (state.settings.profile === "clear" ? "plain" : "standard") });
  }
});
$("#sampleBtn").onclick = () => {
  state.trail = [];
  load(async () => ({ id: "sample", source: null, blocks: null, ...(await (await api("/sample.json")).json()) }));
};
// Files from the reader's computer: markdown and text are read here, web pages go through the same
// extraction as links, and PDFs are converted by the server.
async function readFile(file) {
  const name = file.name || "Document", ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf" || file.type === "application/pdf") {
    const fd = new FormData();
    fd.append("file", file, name);
    const r = await fetch("/api/pdf", { method: "POST", body: fd });
    if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(m); }
    return r.json();
  }
  if (file.size > 5e6) throw new Error("That file is too large to read here.");
  const text = await file.text();
  if (ext === "html" || ext === "htm") {
    const parsed = Extract.run(text, "https://local.file/" + encodeURIComponent(name));
    return (await api("/api/doc", { ...parsed, source: null, byline: name })).json();
  }
  if (!/^(md|markdown|mdown|txt|text)$/.test(ext) && !file.type.startsWith("text/"))
    throw new Error("Tangent can read markdown, text, HTML and PDF files.");
  return markdownDoc(text, name);
}
const openFile = file => { state.trail = []; load(() => readFile(file)); };
$("#fileBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", e => { if (hasFiles(e)) { dragDepth++; $("#dropzone").hidden = false; } });
addEventListener("dragleave", e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; } });
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $("#dropzone").hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});
$("#pasteBtn").onclick = () => { $("#pasteForm").hidden = !$("#pasteForm").hidden; $("#pasteText").focus(); };
$("#pasteForm").addEventListener("submit", e => {
  e.preventDefault();
  const text = $("#pasteText").value;
  const first = text.trim().split("\n")[0].slice(0, 80);
  load(() => api("/api/text", { title: first || "Pasted text", text }));
});

let toastTimer;
function toast(msg, ms = 1800, action = null) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("actionable", !!action);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { action.fn(); t.classList.remove("show"); };
    t.append(b);
  }
  t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

window.addEventListener("offline", () => { document.body.classList.add("offline"); toast("You're offline. Answers will work again once you reconnect.", 4000); });
window.addEventListener("online", () => { document.body.classList.remove("offline"); toast("Back online"); });

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layoutNotes, 100); });
document.fonts?.ready.then(layoutNotes);

// ---------------------------------------------------------------- boot

applySettings();
fetch("/api/config").then(r => r.json()).then(c => {
  state.config = c;
  $("#modelInfo").textContent = `${c.provider} · quick: ${c.quick} · deep: ${c.deep}`;
}).catch(() => {});
// ---------------------------------------------------------------- markdown files (the tangent CLI)

// A markdown file becomes a document like pasted text; its first "# " heading is the title.
async function markdownDoc(text, name) {
  const h1 = text.match(/^\s*#\s+(.+?)\s*#*\s*$/m);
  const title = h1 && !text.slice(0, h1.index).trim() ? h1[1] : name.replace(/\.(md|markdown)$/i, "");
  const doc = await (await api("/api/text", { title, text })).json();
  return { ...doc, byline: name, keepUrl: true };
}

// tangent --web: the file travels in the link's #fragment (raw deflate, base64url), which never reaches a server.
async function openPacked(hash) {
  const p = new URLSearchParams(hash.slice(1));
  const b64 = p.get("md").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  return markdownDoc(text, p.get("name") || "Document");
}

// tangent FILE: a local server serves the file and says when it changes. Reloads keep the scroll
// position, and notes whose paragraph is unchanged stay attached to it.
async function openLocal() {
  const fetchDoc = async () => { const f = await (await api("/_local/doc")).json(); return markdownDoc(f.text, f.name); };
  if (!await load(fetchDoc)) return;
  const events = new EventSource("/_local/events");
  let busy = false;
  events.addEventListener("change", async () => {
    if (busy) return;
    busy = true;
    try {
      const old = state.doc, doc = await fetchDoc();
      if (state.doc !== old) return;  // the reader moved on to something else
      const notes = state.notes.filter(n => {
        const k = doc.paragraphs.indexOf(old.paragraphs[n.para]);
        if (k < 0) return false;
        n.para = k;
        return true;
      });
      openDoc(doc, { notes, cascades: new Map(), scaffold: state.scaffold, y: scrollY });
      toast("Updated", 1200);
    } catch (e) { toast("Couldn't reload: " + e.message, 4000); }
    finally { busy = false; }
  });
}

const initialUrl = new URLSearchParams(location.search).get("url");
const qs = new URLSearchParams(location.search);
// Links open a reading on arrival, but not inside another site's frame (each visit spends API credits).
const framed = window.top !== window.self;
if (framed) {}
else if (location.hash.startsWith("#md=")) load(() => openPacked(location.hash));
else if (qs.has("local")) openLocal();
else if (initialUrl && !framed) { $("#urlInput").value = initialUrl; load(() => readUrl(initialUrl)); }
else if (qs.get("q") && !framed) compose(qs.get("q"), { length: qs.get("len") || "primer", level: qs.get("level") || "standard" });
