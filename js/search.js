// Notes search over the NoteIndexEntry list: { id, title, module, headings:[{id,text}], text }.
// Pure and literal: tokens are matched with String.includes, never as regular
// expressions, so "(confirm)" and "Part 10.7" mean exactly what they say.
//
// Folded text (lower-cased, en/em dashes to "-", NBSP to a space) is cached per
// entry object in a WeakMap, so repeated searches do not re-fold ~30 documents.
// The cache assumes entries are not edited after the first search.

const DEFAULT_LIMIT = 20;
const SNIPPET_LEN = 120;
const ELLIPSIS = '…';

function fold(s) {
  return String(s ?? '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
    .toLowerCase();
}

const cache = new WeakMap();

function folded(entry) {
  let f = cache.get(entry);
  if (!f) {
    const text = String(entry.text ?? '');
    const lower = fold(text);
    f = {
      title: fold(entry.title),
      headings: Array.isArray(entry.headings)
        ? entry.headings.filter((x) => x && typeof x === 'object').map((x) => ({ id: x.id, text: fold(x.text) }))
        : [],
      text: lower,
      // Folding keeps the length except for a few special characters (such as a
      // capital dotted I). Only then do snippets come from the folded text, so
      // match positions can never drift against the original.
      source: lower.length === text.length ? text : lower,
    };
    cache.set(entry, f);
  }
  return f;
}

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function snippetFor(f, tokens) {
  const text = f.source;
  let pos = -1;
  let len = 0;
  for (const t of tokens) {
    const i = f.text.indexOf(t);
    if (i !== -1) { pos = i; len = t.length; break; }
  }
  if (pos === -1) {
    const head = collapse(text.slice(0, SNIPPET_LEN));
    return text.length > SNIPPET_LEN ? head + ELLIPSIS : head;
  }
  const w = Math.max(SNIPPET_LEN, len + 20);
  let start = Math.max(0, pos - Math.floor((w - len) / 2));
  let end = start + w;
  if (end > text.length) {
    end = text.length;
    start = Math.max(0, end - w);
  }
  return (start > 0 ? ELLIPSIS : '') + collapse(text.slice(start, end)) + (end < text.length ? ELLIPSIS : '');
}

function clampLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT;
  const n = Math.floor(Number(limit));
  return Number.isNaN(n) ? 0 : Math.max(0, n);
}

export function search(index, query, limit) {
  const max = clampLimit(limit);
  if (typeof query !== 'string' || !Array.isArray(index) || max === 0) return [];
  const tokens = fold(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const hits = [];
  index.forEach((entry, order) => {
    if (!entry || typeof entry !== 'object') return;
    const f = folded(entry);
    const all = `${f.title}\n${f.headings.map((x) => x.text).join('\n')}\n${f.text}`;
    if (!tokens.every((t) => all.includes(t))) return;

    let score = 0;
    for (const t of tokens) {
      if (f.title.includes(t)) score += 100;
      if (f.headings.some((x) => x.text.includes(t))) score += 10;
      if (f.text.includes(t)) score += 1;
    }
    hits.push({ entry, f, score, order });
  });

  hits.sort((a, b) => b.score - a.score || a.order - b.order);

  return hits.slice(0, max).map(({ entry, f }) => {
    const result = { id: entry.id, title: entry.title };
    // Only point at a heading when ONE heading holds every token; a heading
    // matching just one word would jump the reader to the wrong place.
    const heading = f.headings.find((x) => tokens.every((t) => x.text.includes(t)));
    if (heading && heading.id !== undefined) result.anchor = heading.id;
    result.snippet = snippetFor(f, tokens);
    return result;
  });
}
