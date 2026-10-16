// Browse: the notes reader, question list, card list and flagged cards.
//
//   render(root, ctx, subpath)  ->  Promise of a teardown function
//
// subpath is the array of URI-decoded segments after #/browse (app.js has
// already rejected malformed escapes and path-like segments):
//   []                                  Notes list (default tab)
//   ['notes']                           Notes list
//   ['notes', docId]                    one document
//   ['notes', docId, anchor]            one document, scrolled to a heading
//   ['questions'] ['cards'] ['flagged'] the other tabs
// Anything else is a friendly "Not found" panel, never an exception.
//
// All text goes in through el()/mount() as text nodes. The one place markup is
// parsed is a notes fragment: trusted local HTML, fetched only for a document id
// that exists in the notes index, parsed by DOMParser into an inert document
// (scripts there never run) and then adopted into the reader container.
import { el, mount } from './dom.js';
import { notesHref } from './dataurl.js';
import { loadText, showFigure, releaseUrls, isIntegrityError, DAMAGED_TEXT } from './access.js';

const PAGE_SIZE = 25;
const DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 30;
const TABS = [
  ['notes', 'Notes'],
  ['questions', 'Questions'],
  ['cards', 'Cards'],
  ['flagged', 'Flagged'],
];
const FIGURE_MISSING = 'This question refers to an image that was not captured. Open it in the course quiz on Canvas.';
const EMPTY_FLAGGED = 'No flagged cards yet — tap Flag on a card during a session.';
const CONFIRM_TEXT = 'This fact comes from the 2026 update and could not be verified.';

// Filters survive moving between tabs while the page stays open.
const memory = {
  questions: { module: 'all', quiz: 'all', text: '' },
  cards: { module: 'all', text: '' },
};

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function fold(s) {
  return String(s ?? '').replace(/[–—]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' ').toLowerCase();
}

function moduleOfCard(card) {
  const m = card && typeof card.noteDoc === 'string' ? /^m(\d+)/.exec(card.noteDoc) : null;
  return m ? Number(m[1]) : null;
}

function debounce(fn, ms, cleanups) {
  let timer = null;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  run.flush = (...args) => { clearTimeout(timer); timer = null; fn(...args); };
  cleanups.push(() => clearTimeout(timer));
  return run;
}

// ---------------------------------------------------------------- shared bits
function tabBar(current) {
  return el('nav', { class: 'subtabs', 'aria-label': 'Browse sections' },
    TABS.map(([key, label]) => el('a', {
      href: `#/browse/${key}`, 'aria-current': key === current ? 'page' : null,
    }, label)));
}

function notFound() {
  return el('section', { class: 'card panel b-notfound' },
    el('h2', null, 'Not found'),
    el('p', null, 'We could not find that page in Browse. It may have been mistyped or removed.'),
    el('div', { class: 'actions' },
      el('a', { class: 'btn primary', href: '#/browse/notes' }, 'All notes'),
      el('a', { class: 'btn', href: '#/browse/questions' }, 'Questions'),
      el('a', { class: 'btn', href: '#/browse/cards' }, 'Cards'),
      el('a', { class: 'btn', href: '#/home' }, 'Home')));
}

function field(labelText, control, id) {
  return el('div', { class: 'b-field' }, el('label', { for: id }, labelText), control);
}

function select(id, options, value, onchange) {
  const node = el('select', { id, onchange }, options.map(([v, text]) => el('option', { value: String(v) }, text)));
  node.value = String(value);
  if (node.value !== String(value)) node.value = String(options[0][0]);
  return node;
}

function toggleFlag(ctx, cardId) {
  ctx.store.update((d) => {
    if (has(d.flags, cardId)) delete d.flags[cardId];
    else d.flags[cardId] = true;
  });
  if (typeof ctx.refreshBanner === 'function') ctx.refreshBanner();
  return has(ctx.store.state().flags, cardId);
}

function isFlagged(ctx, cardId) {
  return has(ctx.store.state().flags, cardId);
}

function openInNotes(doc, anchor, label = 'Open in notes') {
  return el('a', { class: 'btn small-btn b-notes-link', href: notesHref(doc, anchor) }, label);
}

// ---------------------------------------------------------------- notes search
// A search box over all notes (ctx.search). onActive(true|false) tells the page
// when results replace its normal content.
function notesSearch(ctx, cleanups, onActive) {
  const input = el('input', {
    type: 'search', id: 'browse-notes-search', name: 'q', autocomplete: 'off', enterkeyhint: 'search',
    placeholder: 'Search all notes', 'aria-controls': 'browse-notes-results',
  });
  const status = el('p', { class: 'muted small b-status', role: 'status' });
  const list = el('ul', { class: 'b-results', id: 'browse-notes-results' });

  function run() {
    const q = input.value.trim();
    if (!q) {
      mount(list);
      mount(status);
      onActive(false);
      return;
    }
    const hits = ctx.search(q, SEARCH_LIMIT);
    onActive(true);
    if (hits.length === 0) {
      mount(list);
      mount(status, `No matches for “${q}”.`);
      return;
    }
    mount(status, `${hits.length} ${plural(hits.length, 'document matches', 'documents match')}.`);
    mount(list, hits.map((h) => {
      const entry = ctx.data.notesById.get(h.id);
      return el('li', null,
        el('a', { class: 'b-result', href: notesHref(h.id, h.anchor) },
          el('span', { class: 'b-result-title' }, h.title),
          entry ? el('span', { class: 'chip' }, `Module ${entry.module}`) : null,
          el('span', { class: 'b-snippet' }, h.snippet)));
    }));
  }

  const later = debounce(run, DEBOUNCE_MS, cleanups);
  input.addEventListener('input', later);
  const form = el('form', {
    class: 'b-search', role: 'search', novalidate: true,
    onsubmit: (ev) => { ev.preventDefault(); later.flush(); },
  }, el('label', { for: 'browse-notes-search' }, 'Search all notes'), input);
  return { form, status, list };
}

// ---------------------------------------------------------------- notes list
function notesList(ctx, cleanups) {
  const notes = ctx.data.notes;
  const modules = [...new Set(notes.map((n) => n.module))];
  const groups = el('div', { class: 'b-groups' }, modules.map((m) => el('section', { class: 'b-group' },
    el('h2', null, `Module ${m}`),
    el('ul', { class: 'b-docs' }, notes.filter((n) => n.module === m).map((n) => {
      const count = Array.isArray(n.headings) ? n.headings.length : 0;
      return el('li', null, el('a', { class: 'b-doc', href: notesHref(n.id) },
        el('span', { class: 'b-doc-title' }, n.title),
        el('span', { class: 'muted small' }, `${count} ${plural(count, 'heading', 'headings')}`)));
    })))));
  const s = notesSearch(ctx, cleanups, (active) => { groups.hidden = active; s.list.hidden = !active; });
  s.list.hidden = true;
  return el('div', { class: 'b-notes' }, s.form, s.status, s.list, groups);
}

// ---------------------------------------------------------------- notes reader
const LOAD_FAIL = 'These notes could not be loaded. Check your connection and try again.';

// ---- re-sanitising a fetched fragment (same strength as tools/build_notes.py)
// The build step already sanitises every fragment; this is the second, client-side
// layer, run on the INERT parsed document BEFORE anything is adopted, so nothing
// external is ever requested and nothing active can run. It must stay at least as
// strict as the build lists (REMOVE_TAGS, URL_ATTRS, DROP_ATTRS, SVG loaders).
const REMOVE_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'frame', 'frameset',
  'applet', 'portal', 'noscript', 'template', 'audio', 'video', 'source', 'track', 'canvas', 'textarea',
  'xmp', 'noembed', 'noframes', 'foreignobject', 'button', 'input', 'select',
  // SVG animation can rewrite href or an event handler after load.
  'animate', 'set', 'animatetransform', 'animatemotion',
]);
const DROP_ATTRS = new Set([
  'srcdoc', 'formaction', 'action', 'srcset', 'ping', 'poster', 'dynsrc', 'lowsrc', 'background',
]);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'data']);
const SVG_LOADERS = new Set(['image', 'use', 'feimage']);
const BAD_DECLARATION = /@import|expression\s*\(|behavior|-moz-binding|javascript:|vbscript:|\\|\b(image-set|image|cross-fade|src|element|paint)\s*\(|url\(\s*['"]?\s*(?!#)/i;

function normUrl(value) {
  // \s covers the Unicode spaces; the rest are controls and format characters browsers ignore inside a scheme.
  return String(value).replace(/[\s\u0000-\u001f\u007f-\u00a0\u2000-\u200f\u2028-\u202f\u2060-\u2064\ufeff]+/g, '').toLowerCase();
}

function isExternal(norm) {
  return /^[a-z][a-z0-9+.-]*:/.test(norm) || norm.startsWith('//');
}

function cleanStyle(value) {
  return String(value).split(';').filter((decl) => decl.trim() && !BAD_DECLARATION.test(decl)).join(';');
}

function resanitise(container) {
  const all = Array.from(container.querySelectorAll('*'));
  for (const node of all) {
    if (!container.contains(node)) continue; // inside an already removed element
    const tag = node.localName.toLowerCase();
    if (REMOVE_TAGS.has(tag)) node.remove();
  }
  for (const node of Array.from(container.querySelectorAll('*'))) {
    const tag = node.localName.toLowerCase();
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const norm = normUrl(attr.value);
      let drop = name.startsWith('on') || DROP_ATTRS.has(name);
      if (!drop && URL_ATTRS.has(name)) {
        const dataImage = norm.startsWith('data:image/') && (tag === 'img' || SVG_LOADERS.has(tag));
        if (/^(javascript|vbscript|file):/.test(norm)) drop = true;
        else if (norm.startsWith('data:') && !dataImage) drop = true;
        else if (SVG_LOADERS.has(tag) && !(norm.startsWith('#') || dataImage)) drop = true;
        else if (isExternal(norm) && !dataImage && !(tag === 'a' && name === 'href')) drop = true;
      }
      if (!drop && name === 'style') {
        const cleaned = cleanStyle(attr.value);
        if (cleaned) node.setAttribute(attr.name, cleaned);
        else drop = true;
      } else if (!drop && /url\(\s*['"]?\s*(?!#)/i.test(attr.value)) {
        drop = true; // fill="url(http://...)" and similar presentation attributes
      }
      if (drop) node.removeAttribute(attr.name);
    }
    if (tag === 'a' && node.hasAttribute('href') && isExternal(normUrl(node.getAttribute('href')))) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

// Make a parsed fragment safe and phone-friendly: wide tables and figures scroll
// sideways inside their own box (.sw > .tscroll / .figure) instead of widening
// the page. The boxes become tab stops only when they really overflow (see
// updateScrollBoxes), so keyboard users never meet dozens of idle regions.
function scrollBox(node, label) {
  const sw = el('div', { class: 'sw', 'data-label': label });
  node.replaceWith(sw);
  sw.appendChild(node);
  node.addEventListener('scroll', () => updateEdge(sw), { passive: true });
  return sw;
}

function labelFrom(root, selector, fallback) {
  const t = root.querySelector(selector);
  const text = t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 90) : fallback;
}

function prepareFragment(container) {
  resanitise(container);
  for (const table of Array.from(container.querySelectorAll('table'))) {
    const cols = Array.from(table.rows).reduce((max, row) => Math.max(max, row.cells.length), 0);
    const label = labelFrom(table, 'caption', 'Table');
    const box = el('div', { class: 'tscroll' });
    if (cols >= 3) table.style.minWidth = `${cols * 8}rem`;
    table.replaceWith(box);
    box.appendChild(table);
    scrollBox(box, label);
  }
  for (const fig of Array.from(container.querySelectorAll('.figure'))) {
    if (fig.querySelector('svg')) scrollBox(fig, labelFrom(fig, '.cap', 'Figure'));
  }
}

function updateEdge(sw) {
  const box = sw.firstElementChild;
  sw.classList.toggle('at-end', box.scrollLeft + box.clientWidth >= box.scrollWidth - 2);
}

function updateScrollBoxes(root) {
  for (const sw of root.querySelectorAll('.sw')) {
    const box = sw.firstElementChild;
    const over = box.scrollWidth > box.clientWidth + 1;
    sw.classList.toggle('can-scroll', over);
    if (over) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', `${sw.dataset.label}. Scrolls sideways.`);
      updateEdge(sw);
    } else {
      box.removeAttribute('tabindex');
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
      sw.classList.remove('at-end');
    }
  }
}

// Find an element by id INSIDE the container. Fragment ids repeat across
// documents (t1, summary, a...) and may start with a digit, so neither
// document.getElementById nor a '#id' selector is safe here.
function findInside(container, id) {
  for (const node of container.querySelectorAll('[id]')) {
    if (node.id === id) return node;
  }
  return null;
}

function notesReader(ctx, entry, anchor, cleanups) {
  const docId = entry.id;
  const siblings = ctx.data.notes.filter((n) => n.module === entry.module);
  const at = siblings.findIndex((n) => n.id === docId);
  const prev = at > 0 ? siblings[at - 1] : null;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null;
  let alive = true;
  let controller = null;
  cleanups.push(() => { alive = false; if (controller) controller.abort(); });

  const body = el('div', { class: 'note-body' });
  const panel = el('article', { class: 'note-panel', 'aria-label': entry.title }, body);
  const loading = el('p', { class: 'muted b-loading', role: 'status' }, 'Loading notes…');
  const holder = el('div', { class: 'b-fragment' }, loading);

  const headings = Array.isArray(entry.headings) ? entry.headings : [];
  const outline = headings.length === 0 ? null : el('details', { class: 'outline' },
    el('summary', null, 'On this page'),
    el('ol', null, headings.map((h) => {
      const href = notesHref(docId, h.id);
      return el('li', null, el('a', {
        href,
        onclick: (ev) => {
          // Stay on the page: scroll and record the link without re-rendering.
          if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
          if (!findInside(body, h.id)) return;
          try {
            history.pushState(null, '', href);
          } catch {
            return; // let the browser follow the link instead
          }
          ev.preventDefault();
          const box = ev.currentTarget.closest('details');
          if (box) box.open = false;
          goTo(h.id, true);
        },
      }, h.text));
    })));

  const pager = prev || next ? el('nav', { class: 'pager', 'aria-label': 'Other documents in this module' },
    prev ? el('a', { class: 'pager-prev', href: notesHref(prev.id), rel: 'prev' },
      el('span', { class: 'muted small' }, '← Previous'), el('span', null, prev.title)) : null,
    next ? el('a', { class: 'pager-next', href: notesHref(next.id), rel: 'next' },
      el('span', { class: 'muted small' }, 'Next →'), el('span', null, next.title)) : null) : null;

  const reader = el('div', { class: 'b-reader' }, outline, holder, pager);
  const s = notesSearch(ctx, cleanups, (active) => {
    reader.hidden = active;
    s.list.hidden = !active;
    if (!active) updateScrollBoxes(body);
  });
  s.list.hidden = true;
  const onResize = debounce(() => updateScrollBoxes(body), DEBOUNCE_MS, cleanups);
  window.addEventListener('resize', onResize);
  cleanups.push(() => window.removeEventListener('resize', onResize));

  // Scroll to a heading and move focus there. scroll-margin-top keeps it clear of the top edge.
  function goTo(id, focus) {
    const target = findInside(body, id);
    if (!target) return false;
    target.scrollIntoView({ block: 'start' });
    if (focus) {
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
    return true;
  }

  async function load() {
    mount(holder, loading);
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    let text;
    try {
      text = await loadText(`notes/${docId}.html`, controller ? { signal: controller.signal } : undefined);
    } catch (err) {
      if (!alive) return;
      mount(holder, el('div', { class: 'card panel b-loadfail', role: 'alert' },
        el('p', null, isIntegrityError(err) ? DAMAGED_TEXT : LOAD_FAIL),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'btn primary', id: 'browse-retry', onclick: () => { load(); } }, 'Retry'),
          el('a', { class: 'btn', href: '#/browse/notes' }, 'All notes'))));
      return;
    }
    if (!alive) return;
    // The only place markup is parsed: trusted local HTML, inert until adopted.
    const parsed = new DOMParser().parseFromString(text, 'text/html');
    prepareFragment(parsed.body);
    mount(body, Array.from(parsed.body.childNodes));
    mount(holder, panel);
    updateScrollBoxes(body);
    if (anchor) {
      // Runs after app.js has reset the scroll position for the new route.
      requestAnimationFrame(() => { if (alive) goTo(anchor, true); });
    }
  }

  const head = [
    el('p', { class: 'b-crumb' }, el('a', { href: '#/browse/notes' }, '← All notes')),
    el('h1', { class: 'doc-title' }, entry.title),
    el('p', { class: 'muted small' }, `Module ${entry.module}`),
    s.form, s.status, s.list, reader,
  ];
  return { nodes: head, load };
}

// ---------------------------------------------------------------- questions
function questionRow(q, figureOwner) {
  const missingFigure = q.needsFigure && !q.figure;
  const optionItems = (q.options || []).map((o) => {
    const isCorrect = o.key === q.correct;
    return el('li', { class: isCorrect ? 'opt-correct' : null },
      el('span', { class: 'b-opt-text' }, o.text),
      isCorrect ? el('strong', { class: 'b-mark' }, ' ✓ Course answer') : null);
  });
  const corr = q.correction
    ? el('section', { class: 'correction', 'aria-label': 'Course answer and corrected position' },
      el('div', { class: 'corr-block' }, el('h4', null, 'Course answer'), el('p', null, q.correction.courseAnswer)),
      el('div', { class: 'corr-block' }, el('h4', null, 'Corrected position'), el('p', null, q.correction.note)))
    : null;
  let figure = null;
  if (q.figure) {
    const img = el('img', {
      alt: 'Figure for this question', loading: 'lazy', decoding: 'async',
      onerror: () => { if (img.parentNode) img.replaceWith(el('p', { class: 'muted fig-error' }, 'Figure could not be loaded.')); },
    });
    showFigure(img, q.figure, figureOwner);
    figure = el('figure', { class: 'figure' }, img);
  }
  return el('article', { class: 'b-row', 'data-id': q.id },
    el('details', null,
      el('summary', null,
        el('span', { class: 'b-meta' },
          el('span', { class: 'chip b-id' }, q.id),
          el('span', { class: 'muted small' }, `Module ${q.module} · Quiz ${q.quiz}`),
          missingFigure ? el('span', { class: 'chip b-badge' }, 'Figure unavailable') : null),
        el('span', { class: 'b-stem' }, q.stem)),
      el('div', { class: 'b-detail' },
        q.scenario ? el('p', { class: 'scenario' }, q.scenario) : null,
        figure,
        el('ol', { class: 'b-opts' }, optionItems),
        corr,
        q.noteDoc ? el('p', null, openInNotes(q.noteDoc)) : null)),
    missingFigure ? el('p', { class: 'b-figure-note' }, FIGURE_MISSING,
      ' It is excluded from Learn and Review.') : null);
}

function questionsTab(ctx, cleanups) {
  // Figures are decrypted into object URLs in the encrypted build; revoke them on leaving.
  const figureOwner = {};
  cleanups.push(() => releaseUrls(figureOwner));
  const all = ctx.data.questions;
  const f = memory.questions;
  const hay = new Map(all.map((q) => [q.id, fold([q.id, q.stem, q.scenario, ...(q.options || []).map((o) => o.text)].join(' '))]));
  const quizzes = new Map(); // module -> sorted quiz numbers
  for (const q of all) {
    if (!quizzes.has(q.module)) quizzes.set(q.module, new Set());
    quizzes.get(q.module).add(q.quiz);
  }
  const modules = [...quizzes.keys()].sort((a, b) => a - b);

  const status = el('p', { class: 'muted b-status', role: 'status' });
  const list = el('div', { class: 'b-list' });
  const moreBox = el('div', { class: 'b-more' });
  let matches = [];
  let rendered = 0;

  const moduleSel = select('browse-q-module', [['all', 'All modules'], ...modules.map((m) => [m, `Module ${m}`])],
    f.module, () => { f.module = moduleSel.value; f.quiz = 'all'; fillQuizzes(); redraw(); });
  const quizSel = el('select', { id: 'browse-q-quiz', onchange: () => { f.quiz = quizSel.value; redraw(); } });
  function fillQuizzes() {
    const nums = f.module === 'all' ? [] : [...(quizzes.get(Number(f.module)) || [])].sort((a, b) => a - b);
    mount(quizSel, el('option', { value: 'all' }, 'All quizzes'),
      nums.map((n) => el('option', { value: String(n) }, `Quiz ${n}`)));
    quizSel.disabled = f.module === 'all';
    quizSel.value = String(f.quiz);
    if (quizSel.value !== String(f.quiz)) { f.quiz = 'all'; quizSel.value = 'all'; }
  }
  const textInput = el('input', {
    type: 'search', id: 'browse-q-text', autocomplete: 'off', placeholder: 'Search questions and options',
    value: f.text, enterkeyhint: 'search',
  });
  const later = debounce(() => { f.text = textInput.value; redraw(); }, DEBOUNCE_MS, cleanups);
  textInput.addEventListener('input', later);

  function matching() {
    const needle = fold(f.text).trim();
    return all.filter((q) => {
      if (f.module !== 'all' && q.module !== Number(f.module)) return false;
      if (f.quiz !== 'all' && q.quiz !== Number(f.quiz)) return false;
      return !needle || hay.get(q.id).includes(needle);
    });
  }

  function paint() {
    const total = matches.length;
    if (total === 0) {
      mount(status, 'No questions match these filters.');
    } else {
      mount(status, `Showing ${rendered} of ${total} ${plural(total, 'question', 'questions')}.`);
    }
    if (rendered < total) {
      const left = Math.min(PAGE_SIZE, total - rendered);
      mount(moreBox, el('button', { type: 'button', class: 'btn', id: 'browse-more', onclick: more },
        `Show more (${left} more)`));
    } else {
      mount(moreBox);
    }
  }

  function more() {
    const first = rendered;
    const rows = matches.slice(rendered, rendered + PAGE_SIZE).map((q) => questionRow(q, figureOwner));
    for (const row of rows) list.appendChild(row);
    rendered += rows.length;
    paint();
    const target = rows[0] && rows[0].querySelector('summary');
    if (first > 0 && target) target.focus();
  }

  function redraw() {
    matches = matching();
    rendered = 0;
    mount(list);
    more();
  }

  fillQuizzes();
  redraw();
  const form = el('form', { class: 'b-filters', onsubmit: (ev) => { ev.preventDefault(); later.flush(); } },
    field('Module', moduleSel, 'browse-q-module'),
    field('Quiz', quizSel, 'browse-q-quiz'),
    field('Search', textInput, 'browse-q-text'));
  return el('div', { class: 'b-questions' }, form, status, list, moreBox);
}

// ---------------------------------------------------------------- cards
// A visible message for a flag that could not be saved (store rejected the update).
function flagNotice() {
  const node = el('p', { class: 'status error b-flag-msg', role: 'status' });
  return {
    node,
    show: () => mount(node, 'That flag could not be saved, so nothing was changed. Try again, or reload the page.'),
    clear: () => mount(node),
  };
}

function flagButton(ctx, card, onChange, notice) {
  const btn = el('button', { type: 'button', class: 'btn small-btn flag-btn' });
  function paintFlag() {
    const on = isFlagged(ctx, card.id);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? '⚑ Flagged' : '⚑ Flag';
    btn.setAttribute('aria-label', `${on ? 'Unflag' : 'Flag'} card ${card.id}`);
  }
  btn.addEventListener('click', () => {
    try {
      toggleFlag(ctx, card.id);
      if (notice) notice.clear();
    } catch {
      if (notice) notice.show();
    }
    paintFlag();
    if (onChange) onChange();
  });
  paintFlag();
  return btn;
}

function confirmChip(card) {
  return card.confirm
    ? el('span', { class: 'chip confirm-chip', role: 'note', title: CONFIRM_TEXT, 'aria-label': `(confirm). ${CONFIRM_TEXT}` }, '(confirm)')
    : null;
}

function cardRow(ctx, card, notice) {
  const mod = moduleOfCard(card);
  return el('article', { class: 'b-row b-card', 'data-id': card.id },
    el('div', { class: 'b-cardhead' },
      el('details', null,
        el('summary', null,
          el('span', { class: 'b-meta' },
            el('span', { class: 'chip b-id' }, card.id),
            mod ? el('span', { class: 'muted small' }, `Module ${mod}`) : null,
            confirmChip(card)),
          el('span', { class: 'b-stem' }, card.front)),
        el('div', { class: 'b-detail' },
          el('p', { class: 'card-back-text' }, card.back),
          card.noteDoc ? el('p', null, openInNotes(card.noteDoc, card.anchor)) : null)),
      flagButton(ctx, card, null, notice)));
}

function cardsTab(ctx, cleanups) {
  const all = ctx.data.cards;
  const f = memory.cards;
  const notice = flagNotice();
  const hay = new Map(all.map((c) => [c.id, fold(`${c.id} ${c.front} ${c.back}`)]));
  const modules = [...new Set(all.map(moduleOfCard).filter((m) => m !== null))].sort((a, b) => a - b);
  const status = el('p', { class: 'muted b-status', role: 'status' });
  const list = el('div', { class: 'b-list' });
  const moreBox = el('div', { class: 'b-more' });
  let matches = [];
  let rendered = 0;

  const moduleSel = select('browse-c-module', [['all', 'All modules'], ...modules.map((m) => [m, `Module ${m}`])],
    f.module, () => { f.module = moduleSel.value; redraw(); });
  const textInput = el('input', {
    type: 'search', id: 'browse-c-text', autocomplete: 'off', placeholder: 'Search cards', value: f.text, enterkeyhint: 'search',
  });
  const later = debounce(() => { f.text = textInput.value; redraw(); }, DEBOUNCE_MS, cleanups);
  textInput.addEventListener('input', later);

  function matching() {
    const needle = fold(f.text).trim();
    return all.filter((c) => {
      if (f.module !== 'all' && moduleOfCard(c) !== Number(f.module)) return false;
      return !needle || hay.get(c.id).includes(needle);
    });
  }

  function paint() {
    const total = matches.length;
    mount(status, total === 0 ? 'No cards match these filters.'
      : `Showing ${rendered} of ${total} ${plural(total, 'card', 'cards')}.`);
    if (rendered < total) {
      const left = Math.min(PAGE_SIZE, total - rendered);
      mount(moreBox, el('button', { type: 'button', class: 'btn', id: 'browse-more', onclick: more }, `Show more (${left} more)`));
    } else {
      mount(moreBox);
    }
  }

  function more() {
    const first = rendered;
    const rows = matches.slice(rendered, rendered + PAGE_SIZE).map((c) => cardRow(ctx, c, notice));
    for (const row of rows) list.appendChild(row);
    rendered += rows.length;
    paint();
    const target = rows[0] && rows[0].querySelector('summary');
    if (first > 0 && target) target.focus();
  }

  function redraw() {
    matches = matching();
    rendered = 0;
    mount(list);
    more();
  }

  redraw();
  const form = el('form', { class: 'b-filters', onsubmit: (ev) => { ev.preventDefault(); later.flush(); } },
    field('Module', moduleSel, 'browse-c-module'),
    field('Search', textInput, 'browse-c-text'));
  return el('div', { class: 'b-cards' }, form, notice.node, status, list, moreBox);
}

// ---------------------------------------------------------------- flagged
async function copyText(text, area) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back to the textarea below */ }
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy') === true;
  } catch {
    return false;
  }
}

function flaggedTab(ctx) {
  const root = el('div', { class: 'b-flagged' });
  const notice = flagNotice();
  const heading = el('h2', { tabindex: '-1', class: 'b-flagged-title' });
  const listBox = el('div', { class: 'b-list' });
  const tools = el('div', { class: 'b-tools' });
  const copyStatus = el('p', { class: 'status', role: 'status', tabindex: '-1' });
  const area = el('textarea', {
    id: 'browse-flag-ids', readOnly: true, rows: '4', 'aria-label': 'Flagged card ids', spellcheck: 'false',
  });

  function ids() {
    const flags = ctx.store.state().flags;
    const known = ctx.data.cards.filter((c) => has(flags, c.id)).map((c) => c.id);
    const unknown = Object.keys(flags).filter((id) => !ctx.data.cardsById.has(id));
    return [...known, ...unknown];
  }

  function draw(refocus) {
    const flags = ctx.store.state().flags;
    const cards = ctx.data.cards.filter((c) => has(flags, c.id));
    const all = ids();
    mount(heading, `Flagged cards (${all.length})`);
    if (all.length === 0) {
      mount(listBox, el('div', { class: 'card panel b-empty' },
        el('p', null, EMPTY_FLAGGED),
        el('div', { class: 'actions' },
          el('a', { class: 'btn primary', href: '#/learn' }, 'Start learning'),
          el('a', { class: 'btn', href: '#/browse/cards' }, 'Browse cards'))));
      mount(tools);
    } else {
      mount(listBox, cards.map((c) => el('article', { class: 'b-row b-card', 'data-id': c.id },
        el('div', { class: 'b-meta' }, el('span', { class: 'chip b-id' }, c.id), confirmChip(c)),
        el('p', { class: 'b-stem-full' }, c.front),
        el('p', { class: 'card-back-text muted' }, c.back),
        el('div', { class: 'b-actions' },
          flagButton(ctx, c, () => draw(true), notice),
          c.noteDoc ? openInNotes(c.noteDoc, c.anchor) : null))));
      area.value = all.join('\n');
      mount(tools,
        el('h3', null, 'Copy ids'),
        area,
        el('button', {
          type: 'button', class: 'btn primary', id: 'browse-copy',
          onclick: async () => {
            const ok = await copyText(area.value, area);
            mount(copyStatus, ok
              ? `Copied ${all.length} ${plural(all.length, 'id', 'ids')} to the clipboard.`
              : 'Could not copy automatically. The ids are selected above, so copy them by hand.');
            copyStatus.classList.toggle('error', !ok);
            if (!ok) { area.focus(); area.select(); }
          },
        }, 'Copy ids'),
        copyStatus);
    }
    if (refocus) heading.focus({ preventScroll: true });
  }

  draw(false);
  mount(root, heading, notice.node, listBox, tools);
  return root;
}

// ---------------------------------------------------------------- entry point
export async function render(root, ctx, subpath) {
  const sub = Array.isArray(subpath) ? subpath : [];
  const cleanups = [];
  const teardown = () => {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* cleanup must not break navigation */ }
    }
  };
  const [first, ...rest] = sub;
  const tab = first === undefined ? 'notes' : first;
  const content = el('div', { class: 'browse-content' });
  const page = el('div', { class: 'browse' });
  const heading = el('h1', null, 'Browse');
  let pending = null;
  let current = tab;

  try {
    if (!ctx.data) throw new Error('no data');
    if (tab === 'notes' && rest.length === 0) {
      mount(content, notesList(ctx, cleanups));
    } else if (tab === 'notes' && rest.length <= 2) {
      const entry = ctx.data.notesById.get(rest[0]);
      if (!entry) {
        current = null;
        mount(content, notFound());
      } else {
        const reader = notesReader(ctx, entry, rest[1], cleanups);
        mount(content, reader.nodes);
        pending = reader.load();
        current = 'notes';
      }
    } else if (tab === 'questions' && rest.length === 0) {
      mount(content, questionsTab(ctx, cleanups));
    } else if (tab === 'cards' && rest.length === 0) {
      mount(content, cardsTab(ctx, cleanups));
    } else if (tab === 'flagged' && rest.length === 0) {
      mount(content, flaggedTab(ctx));
    } else {
      current = null;
      mount(content, notFound());
    }
  } catch (e) {
    console.error(e);
    current = null;
    mount(content, el('section', { class: 'card panel' },
      el('h2', null, 'Something went wrong'),
      el('p', null, 'Browse could not show this page. Try another section, or reload.'),
      el('a', { class: 'btn', href: '#/browse/notes' }, 'All notes')));
  }

  // On a document page the document title is the page heading.
  const isDoc = tab === 'notes' && rest.length >= 1 && pending !== null;
  mount(page, isDoc ? null : heading, tabBar(current), content);
  mount(root, page);
  if (pending) await pending;
  return teardown;
}
