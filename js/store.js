// Progress store. One versioned localStorage key, validated on every way in
// (load, import, update) so the in-memory state is always well formed.
//
// Several tabs or windows can share this storage (a Chrome tab and an installed
// PWA window, for example). Each store therefore re-reads the stored blob before
// every change (update, rollDaily, recordStudy, import): if its text differs
// from the last text this store wrote or read, that blob is adopted as the base
// (after the usual sanitising) and only then is the change applied, so another
// tab's progress is never overwritten by a stale in-memory snapshot. The window
// `storage` event (see app.js) calls reload() to pick changes up sooner.
//
// Known limitations (deliberate, parked):
// - Due times use fixed 24-hour arithmetic (see srs.js). That is intentional,
//   because due-ness is decided by local calendar day (queue.js). The cost: an
//   item reviewed between 23:00 and midnight on the night before a spring-
//   forward day (clocks go forward an hour, so that calendar day is only 23
//   hours long) comes due one calendar day later than "interval days" would
//   suggest, because +N x 24 h lands an hour into the following calendar day.
//   Example: graded Good at 23:30 on 3 October 2026 in Melbourne, due 00:30 on
//   5 October, so it skips 4 October. It is accepted: it affects one night a
//   year, only late-night reviews, and costs a learner one extra day.
// - A clock that moves backwards can reset the daily new-item counter (the
//   stored date no longer matches "today").
//
// A load warning (unreadable blob, wrong version, dropped items) stays until the
// learner dismisses the banner or imports successfully; saving does not clear
// it, so the automatic write on app open cannot hide it. A copy of the original
// blob is kept in the .bak key as soon as it is found unreadable.
//
// The storage object is an argument (anything with getItem/setItem), so tests
// run in plain Node and a throwing or missing storage degrades to memory-only
// operation instead of breaking the app. No window/document/localStorage here.
//
// State = {
//   v: 1,
//   items: { [id]: { ease, interval, reps, lapses, due, last } },
//   settings: { newPerDay: 1..100, module: "all" | 1..6 },
//   daily: { date: "YYYY-MM-DD" | "", newCount },
//   streak: { last: "YYYY-MM-DD" | "", count },
//   flags: { [cardId]: true },
// }

import { localDateStr } from './queue.js';

const KEY = 'builder-study.v1';
export const STORAGE_KEY = KEY; // for the window `storage` event listener in app.js
const BAK_KEY = 'builder-study.v1.bak';
const MAX_TIME = 8.64e15;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MSG_UNREADABLE = 'Your saved progress could not be read, so the app has started fresh. A copy of the unreadable data was kept.';
const MSG_SKIPPED = 'Some saved progress could not be read and was skipped. A copy of the original was kept.';
const MSG_NO_WRITE = "Progress can't be saved in this browser (storage is unavailable or full). It will be lost when you close the tab — use Export in Settings.";
const MSG_BACKUP_FAILED = 'Saved progress could not be read and a backup copy could not be made, so nothing will be saved this session, to avoid overwriting it \u2014 use Export in Settings.';
const MSG_READ_FAILED = 'Saved progress could not be loaded because browser storage is unavailable. Nothing will be saved this session, so earlier progress is not overwritten — use Export in Settings.';

function defaultState() {
  return {
    v: 1,
    items: {},
    settings: { newPerDay: 10, module: 'all' },
    daily: { date: '', newCount: 0 },
    streak: { last: '', count: 0 },
    flags: {},
  };
}

function isPlain(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

function show(id) {
  const s = String(id);
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);
}

function inRange(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

function isCount(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

// Returns { item } or { error }. Strings are never coerced to numbers.
function sanitiseItem(raw) {
  if (!isPlain(raw)) return { error: 'is not an object' };
  if (!inRange(raw.ease, 1.3, 10)) return { error: 'has an ease outside 1.3 to 10' };
  if (!inRange(raw.interval, 0, 36500)) return { error: 'has an interval outside 0 to 36500 days' };
  if (!isCount(raw.reps)) return { error: 'has a reps count that is not a whole number of 0 or more' };
  const lapses = raw.lapses === undefined ? 0 : raw.lapses;
  if (!isCount(lapses)) return { error: 'has a lapses count that is not a whole number of 0 or more' };
  if (!inRange(raw.due, -MAX_TIME, MAX_TIME)) return { error: 'has a due time that is not a valid date' };
  const last = raw.last === undefined ? 0 : raw.last;
  if (!inRange(last, -MAX_TIME, MAX_TIME)) return { error: 'has a last-studied time that is not a valid date' };
  return { item: { ease: raw.ease, interval: raw.interval, reps: raw.reps, lapses, due: raw.due, last } };
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && id !== '__proto__';
}

class StateError extends Error {}

// Validate and rebuild a state object. `mode` is one of:
//   'load'   - lenient: bad items, ids and fields are skipped or reset to
//              defaults and recorded in `problems` (the caller warns);
//   'import' - strict: the first problem throws, naming it. Malformed dates
//              alone are replaced with "" (so an old export still loads);
//   'update' - strict, dates included, so a UI bug cannot silently change a
//              setting or counter.
function parseState(raw, mode) {
  const strict = mode !== 'load';
  const problems = [];
  const bad = (msg) => {
    if (strict) throw new StateError(msg);
    problems.push(msg);
  };

  if (!isPlain(raw)) throw new StateError('That is not a Builder Study progress object.');
  if (raw.v !== 1) throw new StateError('This progress is from a different version of the app (expected version 1).');
  if (!isPlain(raw.items)) throw new StateError('The progress data has no valid "items" section.');

  const out = defaultState();

  for (const id of Object.keys(raw.items)) {
    if (!validId(id)) { bad(`Item id ${show(id)} is not allowed.`); continue; }
    const r = sanitiseItem(raw.items[id]);
    if (r.error) { bad(`Item ${show(id)} ${r.error}.`); continue; }
    out.items[id] = r.item;
  }

  const section = (name) => {
    const v = raw[name];
    if (v === undefined) return null;
    if (!isPlain(v)) { bad(`The "${name}" section must be an object.`); return null; }
    return v;
  };

  // A field that is absent keeps its default; one that is present but invalid
  // is reported (strict) or reset to its default (load).
  const field = (obj, section_, key, valid, hint, apply) => {
    const v = obj[key];
    if (v === undefined) return;
    if (valid(v)) apply(v);
    else bad(`${section_}.${key} must be ${hint}.`);
  };
  const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
  const dateField = (obj, section_, key, apply) => {
    const v = obj[key];
    if (v === undefined) return;
    if (isDate(v) || v === '') apply(v);
    else if (mode === 'update') bad(`${section_}.${key} must be a date written YYYY-MM-DD.`);
    // load and import: an unusable date is replaced by "" (the default)
  };
  const COUNT = 'a whole number of 0 or more';

  const settings = section('settings');
  if (settings) {
    field(settings, 'settings', 'newPerDay',
      (n) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 100,
      'a whole number from 1 to 100', (n) => { out.settings.newPerDay = n; });
    field(settings, 'settings', 'module',
      (m) => m === 'all' || (typeof m === 'number' && Number.isInteger(m) && m >= 1 && m <= 6),
      '"all" or a whole number from 1 to 6', (m) => { out.settings.module = m; });
  }

  const daily = section('daily');
  if (daily) {
    dateField(daily, 'daily', 'date', (d) => { out.daily.date = d; });
    field(daily, 'daily', 'newCount', isCount, COUNT, (n) => { out.daily.newCount = n; });
  }

  const streak = section('streak');
  if (streak) {
    dateField(streak, 'streak', 'last', (d) => { out.streak.last = d; });
    field(streak, 'streak', 'count', isCount, COUNT, (n) => { out.streak.count = n; });
  }

  const flags = section('flags');
  if (flags) {
    for (const id of Object.keys(flags)) {
      if (!validId(id)) { bad(`Flag id ${show(id)} is not allowed.`); continue; }
      if (flags[id] === true) out.flags[id] = true;
      else bad(`Flag ${show(id)} must be true (remove the key to clear a flag).`);
    }
  }

  return { state: out, problems };
}

function deepFreeze(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(o);
}

// How trustworthy a stored blob looks, used so a poor blob never replaces a
// better existing backup: 2 = readable progress, 1 = some JSON object, 0 = junk.
function blobQuality(text) {
  try {
    const raw = JSON.parse(text);
    if (!isPlain(raw)) return 0;
    return raw.v === 1 && isPlain(raw.items) ? 2 : 1;
  } catch {
    return 0;
  }
}

export function createStore(storage, nowFn = Date.now) {
  let current = deepFreeze(defaultState());
  let loadWarning = null;
  let loadKind = null; // 'unreadable' | 'skipped' while loadWarning is set
  let readBlockedWarning = null; // getItem threw: never write this session
  let writeFailed = false;
  let lastText = null; // the last text this store wrote to, or read from, KEY

  // Returns false only when a backup was needed but could not be made.
  function backUp(text) {
    try {
      if (text.trim() === '') return true;
      const existing = storage.getItem(BAK_KEY);
      if (typeof existing === 'string' && existing.trim() !== '' && blobQuality(text) < blobQuality(existing)) return true;
      storage.setItem(BAK_KEY, text);
      return true;
    } catch {
      return false;
    }
  }

  // An unreadable or partly unreadable blob: remember why, and keep a copy
  // before anything can replace it. Without a copy, writing would destroy the
  // only record, so stay memory-only for the rest of the session.
  function flagUnreadable(text, kind) {
    loadKind = kind;
    loadWarning = kind === 'skipped' ? MSG_SKIPPED : MSG_UNREADABLE;
    if (typeof text === 'string' && !backUp(text)) readBlockedWarning = MSG_BACKUP_FAILED;
  }

  // Make `text` (what is in storage) the base state. On the first load a blob
  // that cannot be parsed leaves the defaults in place; later, it leaves the
  // in-memory state in place (still a valid snapshot) and the blob is kept in .bak.
  function adopt(text) {
    if (typeof text !== 'string') { flagUnreadable(null, 'unreadable'); return; }
    try {
      const { state, problems } = parseState(JSON.parse(text), 'load');
      current = deepFreeze(state);
      if (problems.length) flagUnreadable(text, 'skipped');
    } catch {
      flagUnreadable(text, 'unreadable');
    }
  }

  function load() {
    if (!storage) return;
    let text;
    try {
      text = storage.getItem(KEY);
    } catch {
      readBlockedWarning = MSG_READ_FAILED;
      return;
    }
    if (text === undefined) text = null;
    lastText = text;
    if (text !== null) adopt(text);
  }

  // Re-read the stored blob; if it is not what this store last wrote or read,
  // another tab changed it, so adopt it. Returns true if the state was replaced.
  function sync() {
    if (!storage || readBlockedWarning) return false;
    let text;
    try {
      text = storage.getItem(KEY);
    } catch {
      return false;
    }
    if (text === undefined) text = null;
    if (text === lastText) return false;
    lastText = text;
    if (text === null) return false; // cleared elsewhere: this tab's memory rewrites it on the next change
    const before = current;
    adopt(text);
    return current !== before;
  }

  function persist() {
    if (!storage || readBlockedWarning) return;
    try {
      const text = JSON.stringify(current);
      storage.setItem(KEY, text);
      lastText = text;
      writeFailed = false; // only the unavailable-storage warning ends here; a load warning stays
    } catch {
      writeFailed = true;
    }
  }

  function commit(next) {
    current = deepFreeze(next);
    persist();
  }

  load();

  function bumpStreak(streak, today, yesterday) {
    if (streak.last === today) return streak;
    if (streak.last === yesterday) return { last: today, count: streak.count + 1 };
    return { last: today, count: 1 };
  }

  function dayStrings() {
    const now = nowFn();
    const d = new Date(now);
    // Calendar arithmetic (noon avoids DST edges), never "minus 24 hours".
    const yesterday = localDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime());
    return { today: localDateStr(now), yesterday };
  }

  return {
    // Returns the current state, frozen. A NEW object is created after every
    // successful update, import or roll, so callers must re-read state()
    // rather than hold on to an old reference. Mutate only through update().
    state() {
      return current;
    },

    get persistent() {
      return !!storage && !readBlockedWarning && !writeFailed;
    },

    get warning() {
      if (readBlockedWarning) return readBlockedWarning;
      if (!storage || writeFailed) return MSG_NO_WRITE;
      return loadWarning;
    },

    // 'unavailable' (cannot read or write storage), 'unreadable' (the saved
    // blob could not be read, a copy was kept), 'skipped' (some items dropped)
    // or null. Matches whatever `warning` currently returns.
    get warningKind() {
      if (readBlockedWarning || !storage || writeFailed) return 'unavailable';
      return loadWarning ? loadKind : null;
    },

    // Another tab may have changed the stored progress: re-read it. Returns
    // true if this store's state was replaced.
    reload() {
      return sync();
    },

    // Is there a kept copy of an unreadable blob (the .bak key)?
    hasBackup() {
      if (!storage) return false;
      try {
        const text = storage.getItem(BAK_KEY);
        return typeof text === 'string' && text.trim() !== '';
      } catch {
        return false;
      }
    },

    // Import the kept copy. Never throws; { ok } or { ok:false, error }.
    restoreBackup() {
      if (!storage) return { ok: false, error: 'Browser storage is unavailable, so there is no saved copy to restore.' };
      let text;
      try {
        text = storage.getItem(BAK_KEY);
      } catch {
        return { ok: false, error: 'Browser storage is unavailable, so the saved copy could not be read.' };
      }
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'No saved copy was found.' };
      try {
        return this.importJSON(text);
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : 'The saved copy could not be restored.' };
      }
    },

    // fn receives a mutable deep copy. The result is validated before it
    // replaces the state; on any error the state is left exactly as it was
    // and the error is thrown.
    update(fn) {
      if (typeof fn !== 'function') throw new TypeError('update() needs a function');
      sync();
      const draft = structuredClone(current);
      const returned = fn(draft);
      if (returned && typeof returned.then === 'function') {
        if (typeof returned.catch === 'function') returned.catch(() => {});
        throw new TypeError('update() needs a synchronous function; an async callback would change the draft after it was checked');
      }
      let next;
      try {
        next = parseState(draft, 'update').state;
      } catch (e) {
        throw new Error(`Progress update rejected: ${e.message}`);
      }
      commit(next);
    },

    exportJSON() {
      return JSON.stringify(current, null, 2);
    },

    importJSON(text) {
      if (typeof text !== 'string') return { ok: false, error: 'There was nothing to import.' };
      sync();
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, error: 'That file is not valid JSON.' };
      }
      let next;
      try {
        next = parseState(raw, 'import').state;
      } catch (e) {
        return { ok: false, error: e.message };
      }
      loadWarning = null;
      loadKind = null;
      commit(next);
      return { ok: true };
    },

    // Start a new local day: resets the daily new-item counter. The streak is
    // left alone (opening the app never counts as studying); only
    // rollDaily({ streak: true }) or recordStudy() bumps it. Idempotent within
    // a day.
    rollDaily(opts) {
      sync();
      const { today, yesterday } = dayStrings();
      let { daily, streak } = current;
      if (daily.date !== today) daily = { date: today, newCount: 0 };
      if (opts && opts.streak === true) streak = bumpStreak(streak, today, yesterday);
      if (daily === current.daily && streak === current.streak) return;
      commit({ ...current, daily, streak });
    },

    // Called when the user answers something: bumps the streak, once per day.
    recordStudy() {
      sync();
      const { today, yesterday } = dayStrings();
      const streak = bumpStreak(current.streak, today, yesterday);
      if (streak === current.streak) return;
      commit({ ...current, streak });
    },
  };
}
