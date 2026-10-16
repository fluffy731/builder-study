// Session queue building and local-day helpers. Pure: the clock is always an
// argument, never read here.
//
// Item = { ease, interval, reps, lapses, due, last } (see srs.js).
// Question ids and card ids occupy distinct namespaces (m3q3n1, m3v1-c01), so
// a session can hold both in one list of strings.

// End of the local calendar day containing `ms`. Built from calendar parts,
// never "+24 hours", so it stays correct on 23- and 25-hour DST days.
export function endOfLocalDay(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new RangeError('endOfLocalDay: invalid time');
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

// Local calendar date as YYYY-MM-DD.
export function localDateStr(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new RangeError('localDateStr: invalid time');
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function moduleMatcher(module) {
  if (module === undefined || module === null || module === 'all') return () => true;
  const want = Number(module);
  return (m) => m !== null && m === want;
}

function cardModule(card) {
  const m = card && typeof card.noteDoc === 'string' ? /^m(\d+)/.exec(card.noteDoc) : null;
  return m ? Number(m[1]) : null;
}

function eligible({ questions, cards, module }) {
  const match = moduleMatcher(module);
  const qs = (questions || []).filter((q) => q && !q.needsFigure && match(Number(q.module)));
  const cs = (cards || []).filter((c) => c && match(cardModule(c)));
  return { qs, cs };
}

function has(items, id) {
  return !!items && Object.prototype.hasOwnProperty.call(items, id);
}

// Ids that are due by the end of today, oldest first (ties by id). An item
// whose `due` is not a finite number is never due.
export function dueIds(args) {
  const { items, now } = args;
  const { qs, cs } = eligible(args);
  const limit = endOfLocalDay(now);
  const due = [];
  for (const e of [...qs, ...cs]) {
    if (!has(items, e.id)) continue;
    const it = items[e.id];
    const t = it && typeof it === 'object' ? it.due : undefined;
    if (typeof t === 'number' && Number.isFinite(t) && t <= limit) due.push({ id: e.id, t });
  }
  due.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return due.map((d) => d.id);
}

function wholeCount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Unseen ids, up to newCap - newToday. Questions and cards interleave
// round-robin (q, c, q, c ...), each in data order, leftovers appended.
export function newIds(args) {
  const { items } = args;
  const remaining = Math.max(0, wholeCount(args.newCap) - wholeCount(args.newToday));
  if (remaining === 0) return [];
  const { qs, cs } = eligible(args);
  const fresh = (list) => list.filter((e) => !has(items, e.id)).map((e) => e.id);
  const a = fresh(qs);
  const b = fresh(cs);
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < remaining; i++) {
    if (i < a.length && out.length < remaining) out.push(a[i]);
    if (i < b.length && out.length < remaining) out.push(b[i]);
  }
  return out;
}

// Due items, then new items. Callers wanting a Review-only or Learn-only
// session use dueIds() or newIds() directly.
export function buildSession(args) {
  return [...dueIds(args), ...newIds(args)];
}

// Put `id` back into the queue after `gap` other items. The caller has already
// removed `id` from the head, so index `gap` of what remains is "gap positions
// later"; a shorter queue, or a gap that is not a finite number, puts it at
// the end. Returns a new array.
export function requeue(queue, id, gap = 3) {
  const out = Array.from(queue);
  const g = Number.isFinite(gap) ? Math.max(0, Math.floor(gap)) : out.length;
  out.splice(Math.min(g, out.length), 0, id);
  return out;
}
