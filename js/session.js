// Learn and Review sessions.
//
//   startSession(root, ctx, 'learn' | 'review')  ->  teardown function
//
// Learn works through today's new items (capped by the daily limit and the
// module filter); Review works through everything due. Both use exactly the
// queue.js arguments Home uses, so the counts on Home equal the session
// lengths. Items are questions and flashcards mixed. All text goes in through
// el()/mount() as text nodes; nothing is ever parsed as markup.
import { el, mount } from './dom.js';
import { dueIds, newIds, requeue } from './queue.js';
import { review, newItem } from './srs.js';
import { shuffleOptions } from './shuffle.js';
import { notesHref } from './dataurl.js';
import { showFigure, releaseUrls } from './access.js';

const GUARD_MS = 350; // ignore pointer activation this long after a screen changes
const WRONG_GAP = 3; // a missed item comes back after this many other items
const GRADES = [
  ['again', 'Again'],
  ['hard', 'Hard'],
  ['good', 'Good'],
  ['easy', 'Easy'],
];
const CONFIRM_TEXT = 'This fact comes from the 2026 update and could not be verified.';
const SAVE_MSG = 'Your progress could not be saved. You can keep going, but it may not be kept.';
const MANY = 1e9; // "no cap" for counting eligible items

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function shortText(text, max = 140) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function startSession(root, ctx, mode) {
  const isLearn = mode === 'learn';
  const store = ctx.store;
  const data = ctx.data;
  const title = isLearn ? 'Learn' : 'Review';

  let queue = [];
  let total = 0;
  let completed = 0;
  let seen = new Set(); // ids shown at least once this round
  let results = new Map(); // id -> { firstTry: boolean }
  let current = null; // { id, kind, ... } for the screen on show
  let armedAt = 0;
  let readyTimer = null;
  let torn = false;
  let saveFailed = false;

  // ------------------------------------------------------------ queue
  function queueArgs() {
    const state = store.state();
    return { questions: data.questions, cards: data.cards, items: state.items, now: Date.now(), module: state.settings.module };
  }

  // Everything the session decision needs, from one fresh read of the store.
  function situation() {
    const state = store.state();
    const args = queueArgs();
    const due = dueIds(args);
    const fresh = newIds({ ...args, newCap: state.settings.newPerDay, newToday: state.daily.newCount });
    const eligible = newIds({ ...args, items: {}, newCap: MANY, newToday: 0 }).length;
    const unseen = newIds({ ...args, newCap: MANY, newToday: 0 }).length;
    return { state, due, fresh, eligible, unseen };
  }

  // ------------------------------------------------------------ guards
  // Call after the screen is on the page. data-ready flips on once the guard
  // window has passed (tests wait for it; users never notice).
  function arm() {
    armedAt = performance.now();
    const host = root.firstElementChild;
    if (host) host.removeAttribute('data-ready');
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      const h = root.firstElementChild;
      if (h && !torn) h.setAttribute('data-ready', 'true');
    }, GUARD_MS);
  }

  // Wrap a click handler: pointer clicks (detail > 0) are ignored for a short
  // time after the screen changed, and the second click of a double-click is
  // always ignored. Keyboard activation (detail 0) is never delayed.
  function guarded(fn) {
    return (ev) => {
      if (ev.detail > 0) {
        if (performance.now() - armedAt < GUARD_MS) return;
        if (ev.detail > 1) return;
      }
      fn(ev);
    };
  }

  // ------------------------------------------------------------ persistence
  function saveGrade(id, grade) {
    saveFailed = false;
    try {
      store.rollDaily({ streak: false });
      store.update((d) => {
        const isNew = !has(d.items, id);
        d.items[id] = review(isNew ? newItem() : d.items[id], grade, Date.now());
        if (isNew) d.daily.newCount += 1;
      });
      store.recordStudy();
    } catch {
      saveFailed = true;
    }
    noteSave();
  }

  // store.update() does not throw when the browser refuses the write (storage
  // full or blocked): it keeps the change in memory and reports it through
  // store.persistent. So ask the store, not just the exception.
  function noteSave() {
    if (!store.persistent) saveFailed = true;
    refreshSaveNotice();
    if (typeof ctx.refreshBanner === 'function') ctx.refreshBanner();
  }

  function saveBroken() {
    return saveFailed || !store.persistent;
  }

  function refreshSaveNotice() {
    const host = root.querySelector('.save-notice-host');
    if (host) mount(host, saveBroken() ? el('p', { class: 'status error save-notice' }, SAVE_MSG) : null);
  }

  // ------------------------------------------------------------ chrome
  function exitButton() {
    return el('button', { type: 'button', class: 'btn small-btn exit-btn', onclick: () => ctx.navigate('#/home') }, 'Exit');
  }

  function header() {
    const n = Math.min(seen.size, total);
    return el('header', { class: 'session-head' },
      // Stays on every screen of the session while saving is broken; it has no
      // dismiss button, and goes as soon as a save works again.
      el('div', { class: 'save-notice-host' }),
      el('div', { class: 'session-top' },
        el('h1', { class: 'session-title' }, title),
        exitButton()),
      el('div', { class: 'session-progress' },
        el('span', { class: 'progress-text', id: 'progress-text' }, `${n} of ${total}`),
        el('div', {
          class: 'bar thin', role: 'progressbar', 'aria-label': `${title} progress`,
          'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': completed,
        }, el('span', { style: { width: `${total ? Math.round((completed / total) * 100) : 0}%` } }))));
  }

  function draw(...children) {
    mount(root, el('section', { class: 'session', 'data-mode': mode }, ...children));
    refreshSaveNotice();
    arm();
    window.scrollTo(0, 0);
  }

  function focusFirst(node) {
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  function saveWarning() {
    return saveBroken() ? el('p', { class: 'status error save-notice', role: 'alert' }, SAVE_MSG) : null;
  }

  // ------------------------------------------------------------ empty states
  function emptyState(heading, text, ...actions) {
    current = null;
    const h = el('h1', { class: 'empty-title', tabindex: -1 }, heading);
    mount(root, el('section', { class: 'session empty', 'data-mode': mode },
      el('div', { class: 'card panel' }, h, el('p', null, text),
        actions.length ? el('div', { class: 'actions' }, actions) : null)));
    arm();
    focusFirst(h);
  }

  const homeBtn = (primary) => el('button', {
    type: 'button', class: primary ? 'btn primary' : 'btn', onclick: () => ctx.navigate('#/home'),
  }, 'Back to Home');
  const settingsLink = (primary) => el('a', { class: primary ? 'btn primary' : 'btn', href: '#/settings' }, 'Open Settings');
  const goBtn = (label, hash, primary) => el('button', {
    type: 'button', class: primary ? 'btn primary' : 'btn', onclick: () => ctx.navigate(hash),
  }, label);

  function moduleLabel(state) {
    return state.settings.module === 'all' ? null : `Module ${state.settings.module}`;
  }

  // Returns true when it drew an empty state instead of starting.
  function maybeEmpty(sit) {
    const label = moduleLabel(sit.state);
    if (sit.eligible === 0) {
      if (label) {
        emptyState('Nothing to study here',
          `No items in ${label} match — change the module filter in Settings.`,
          settingsLink(true), homeBtn(false));
      } else {
        emptyState('Nothing to study yet',
          'None of the questions or flashcards in this data can be used in a session. Questions that depend on a figure are available in Browse.',
          homeBtn(true), goBtn('Open Browse', '#/browse', false));
      }
      return true;
    }
    if (isLearn) {
      if (sit.fresh.length > 0) return false;
      if (sit.unseen > 0) {
        const cap = sit.state.settings.newPerDay;
        emptyState('Today\'s new items are done',
          `You've done today's ${cap} new ${plural(cap, 'item', 'items')} — come back tomorrow or raise the limit in Settings.`,
          settingsLink(true),
          sit.due.length > 0 ? goBtn('Start review', '#/review', false) : null,
          homeBtn(false));
      } else {
        emptyState('You\'ve started everything',
          `You've started every item${label ? ` in ${label}` : ''}. From here, review brings them back when they are due.`,
          sit.due.length > 0 ? goBtn('Start review', '#/review', true) : homeBtn(true),
          sit.due.length > 0 ? homeBtn(false) : settingsLink(false));
      }
      return true;
    }
    if (sit.due.length > 0) return false;
    emptyState('All caught up',
      'Nothing due right now — you\'re all caught up.',
      sit.fresh.length > 0 ? goBtn('Learn new items', '#/learn', true) : homeBtn(true),
      sit.fresh.length > 0 ? homeBtn(false) : settingsLink(false));
    return true;
  }

  // ------------------------------------------------------------ flow
  function begin() {
    const sit = situation();
    if (maybeEmpty(sit)) return;
    queue = (isLearn ? sit.fresh : sit.due).filter((id) => data.questionsById.has(id) || data.cardsById.has(id));
    if (queue.length === 0) {
      emptyState('Nothing to study yet', 'There is nothing to show in this session.', homeBtn(true));
      return;
    }
    total = queue.length;
    completed = 0;
    seen = new Set();
    results = new Map();
    next();
  }

  function next() {
    if (queue.length === 0) {
      summary();
      return;
    }
    const id = queue.shift();
    const retry = seen.has(id);
    seen.add(id);
    if (data.questionsById.has(id)) showQuestion(data.questionsById.get(id), retry);
    else showCard(data.cardsById.get(id), retry);
  }

  // Record the outcome of one answer and decide what happens to the queue.
  function finish(item, grade) {
    const correct = grade !== 'again';
    saveGrade(item.id, grade);
    if (!results.has(item.id)) results.set(item.id, { firstTry: correct });
    if (correct) completed += 1;
    else queue = requeue(queue, item.id, WRONG_GAP);
    const bar = root.querySelector('.session-progress .bar');
    if (bar) {
      bar.setAttribute('aria-valuenow', String(completed));
      const fill = bar.firstElementChild;
      if (fill) fill.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
    }
  }

  function nextLabel() {
    return queue.length === 0 ? 'Finish' : 'Next';
  }

  // Scroll so the whole Next button (and, if there is one, the start of the
  // correction panel) sits above the fixed tab bar.
  function clearTabBar(nextBtn, panel) {
    const tabs = document.querySelector('nav.tabs');
    const tabH = tabs ? tabs.offsetHeight : 0;
    const s0 = window.scrollY;
    const room = window.innerHeight - tabH;
    const lower = nextBtn.getBoundingClientRect().bottom + s0 + 12 - room; // Next fully visible
    let target = Math.max(s0, lower);
    if (panel) {
      const upper = panel.getBoundingClientRect().top + s0 - 8; // panel start at the top edge
      if (lower <= upper) target = Math.min(Math.max(s0, lower), upper);
      else target = lower;
    }
    window.scrollTo(0, Math.max(0, target));
  }

  // ------------------------------------------------------------ question
  function showQuestion(q, retry) {
    const options = shuffleOptions(q.options);
    let answered = false;
    const optBtns = [];

    const feedback = el('div', { class: 'feedback', 'aria-live': 'polite' });

    function choose(index) {
      if (answered) return;
      answered = true;
      current.answered = true;
      const picked = options[index];
      const correct = picked.key === q.correct;
      finish(q, correct ? 'good' : 'again');
      arm();

      optBtns.forEach((btn, i) => {
        btn.setAttribute('aria-disabled', 'true');
        const opt = options[i];
        let mark = null;
        if (opt.key === q.correct) {
          btn.classList.add('correct');
          mark = '✓ Correct answer';
        } else if (i === index) {
          btn.classList.add('wrong');
          mark = '✗ Your answer';
        }
        if (i === index) btn.classList.add('picked');
        if (mark) btn.append(el('span', { class: 'opt-mark' }, mark));
      });

      const nextBtn = el('button', {
        type: 'button', class: 'btn primary next-btn', id: 'next-btn',
        onclick: guarded(next),
      }, nextLabel());

      const panel = q.correction
        ? el('section', { class: 'correction', 'aria-label': 'Course answer and corrected position' },
          el('div', { class: 'corr-block' },
            el('h3', null, 'Course answer'),
            el('p', null, q.correction.courseAnswer)),
          el('div', { class: 'corr-block' },
            el('h3', null, 'Corrected position'),
            el('p', null, q.correction.note)),
          el('p', { class: 'muted small' }, 'The course marks the first as correct. The second is the corrected position.'))
        : null;

      mount(feedback,
        el('p', { class: correct ? 'result ok' : 'result bad' },
          correct ? '✓ Correct.' : '✗ Not quite. This one will come back shortly.'),
        panel,
        q.noteDoc ? el('p', null, el('a', { class: 'btn', href: notesHref(q.noteDoc) }, 'Open in notes')) : null,
        saveWarning(),
        nextBtn);
      focusFirst(nextBtn);
      clearTabBar(nextBtn, panel);
    }

    options.forEach((opt, i) => {
      optBtns.push(el('button', {
        type: 'button', class: 'opt', 'data-key': opt.key,
        'aria-keyshortcuts': i < 6 ? `${String.fromCharCode(65 + i)} ${i + 1}` : null,
        onclick: guarded(() => choose(i)),
      }, el('span', { class: 'opt-letter', 'aria-hidden': 'true' }, String.fromCharCode(65 + i)),
      el('span', { class: 'opt-text' }, opt.text)));
    });

    const stem = el('h2', { class: 'stem', id: 'stem', tabindex: -1 }, q.stem);
    let figure = null;
    if (q.figure) {
      const img = el('img', {
        alt: 'Figure for this question',
        onerror: (ev) => {
          const bad = ev.target;
          if (bad.parentNode) bad.replaceWith(el('p', { class: 'muted fig-error' }, 'Figure could not be loaded.'));
        },
      });
      showFigure(img, q.figure, root);
      figure = el('figure', { class: 'figure' }, img);
    }

    current = { id: q.id, kind: 'question', choose: (i) => { if (i < optBtns.length) choose(i); }, answered: false };
    draw(
      header(),
      el('article', { class: 'card q-card' },
        el('p', { class: 'muted small q-label' },
          `Module ${q.module} · Quiz ${q.quiz} · Question ${q.n}`,
          retry ? el('span', { class: 'chip retry' }, 'Another go') : null),
        q.scenario ? el('div', { class: 'scenario' }, el('p', null, q.scenario)) : null,
        figure,
        stem,
        el('div', { class: 'options', role: 'group', 'aria-labelledby': 'stem' }, optBtns),
        feedback));
    focusFirst(stem);
  }

  // ------------------------------------------------------------ card
  function showCard(card, retry) {
    let revealed = false;
    const flagged = () => has(store.state().flags, card.id);

    const flagBtn = el('button', {
      type: 'button', class: 'btn small-btn flag-btn', 'aria-pressed': flagged() ? 'true' : 'false',
      onclick: () => {
        try {
          store.update((d) => {
            if (has(d.flags, card.id)) delete d.flags[card.id];
            else d.flags[card.id] = true;
          });
        } catch {
          saveFailed = true;
        }
        noteSave();
        flagBtn.setAttribute('aria-pressed', flagged() ? 'true' : 'false');
        flagBtn.textContent = flagged() ? '⚑ Flagged' : '⚑ Flag';
      },
    }, flagged() ? '⚑ Flagged' : '⚑ Flag');

    const chip = card.confirm
      ? el('span', {
        class: 'chip confirm-chip', role: 'note', title: CONFIRM_TEXT,
        'aria-label': `(confirm). ${CONFIRM_TEXT}`,
      }, '(confirm)')
      : null;

    const backHost = el('div', { class: 'card-back-host' });
    const actions = el('div', { class: 'actions card-actions' });

    function grade(g) {
      if (!revealed || current.answered) return;
      current.answered = true;
      finish(card, g);
      arm();
      actions.classList.remove('grades');
      mount(actions, el('button', {
        type: 'button', class: 'btn primary next-btn', id: 'next-btn', onclick: guarded(next),
      }, nextLabel()));
      const warn = saveWarning();
      if (warn) backHost.append(warn);
      const btn = actions.firstElementChild;
      focusFirst(btn);
      clearTabBar(btn, null);
    }

    function reveal() {
      if (revealed) return;
      revealed = true;
      arm();
      const back = el('div', { class: 'card-back', tabindex: -1 },
        el('h3', null, 'Answer'),
        el('p', { class: 'card-text' }, card.back),
        card.confirm ? el('p', { class: 'muted small' }, CONFIRM_TEXT) : null,
        card.noteDoc ? el('p', null, el('a', { class: 'btn', href: notesHref(card.noteDoc, card.anchor) }, 'Open in notes')) : null);
      mount(backHost, back);
      actions.classList.add('grades');
      mount(actions, GRADES.map(([g, label]) => el('button', {
        type: 'button', class: 'btn grade', 'data-grade': g,
        'aria-keyshortcuts': String(GRADES.findIndex(([x]) => x === g) + 1),
        onclick: guarded(() => grade(g)),
      }, label)));
      focusFirst(back);
      clearTabBar(actions.lastElementChild, back);
    }

    mount(actions, el('button', {
      type: 'button', class: 'btn primary show-btn', id: 'show-answer', onclick: guarded(reveal),
    }, 'Show answer'));

    current = { id: card.id, kind: 'card', grade, answered: false, isRevealed: () => revealed };
    draw(
      header(),
      el('article', { class: 'card flash' },
        el('div', { class: 'flash-top' },
          el('p', { class: 'muted small q-label' }, 'Flashcard', retry ? el('span', { class: 'chip retry' }, 'Another go') : null, chip),
          flagBtn),
        el('h2', { class: 'card-front', id: 'card-front', tabindex: -1 }, card.front),
        backHost,
        actions,
        el('p', { class: 'muted small keys-hint' }, 'Keys 1 to 4 grade a revealed card.')));
    focusFirst(root.querySelector('#show-answer'));
  }

  // ------------------------------------------------------------ summary
  function summary() {
    current = null;
    const answered = results.size;
    const right = [...results.values()].filter((r) => r.firstTry).length;
    const percent = answered ? Math.round((right / answered) * 100) : 0;
    const missed = [...results.entries()].filter(([, r]) => !r.firstTry).map(([id]) => id);

    const label = (id) => {
      const q = data.questionsById.get(id);
      if (q) return { text: shortText(q.stem), doc: q.noteDoc, anchor: null };
      const c = data.cardsById.get(id);
      return c ? { text: shortText(c.front), doc: c.noteDoc, anchor: c.anchor } : { text: id, doc: null, anchor: null };
    };

    const sit = situation();
    const more = isLearn ? sit.fresh.length > 0 : sit.due.length > 0;
    const h = el('h1', { class: 'summary-title', tabindex: -1 }, `${title} complete`);
    mount(root, el('section', { class: 'session summary', 'data-mode': mode },
      el('div', { class: 'card' },
        h,
        el('div', { class: 'stats' },
          el('div', { class: 'stat' }, el('div', { class: 'stat-value', id: 'sum-answered' }, String(answered)),
            el('div', { class: 'stat-label' }, plural(answered, 'item answered', 'items answered'))),
          el('div', { class: 'stat' }, el('div', { class: 'stat-value', id: 'sum-correct' }, `${percent}%`),
            el('div', { class: 'stat-label' }, 'right first time')),
          el('div', { class: 'stat' }, el('div', { class: 'stat-value', id: 'sum-revisit' }, String(missed.length)),
            el('div', { class: 'stat-label' }, plural(missed.length, 'item to revisit', 'items to revisit')))),
        missed.length
          ? el('div', { class: 'revisit' },
            el('h2', null, 'Items to revisit'),
            el('ul', { class: 'revisit-list' }, missed.map((id) => {
              const l = label(id);
              return el('li', null, el('span', null, l.text),
                l.doc ? el('a', { href: notesHref(l.doc, l.anchor) }, ' Open in notes') : null);
            })))
          : el('p', { class: 'muted' }, 'Nothing to revisit. Nicely done.'),
        el('div', { class: 'actions' },
          more ? el('button', { type: 'button', class: 'btn primary', id: 'keep-going', onclick: guarded(begin) }, 'Keep going') : null,
          el('button', { type: 'button', class: more ? 'btn' : 'btn primary', id: 'back-home', onclick: () => ctx.navigate('#/home') }, 'Back to Home')))));
    arm();
    window.scrollTo(0, 0);
    focusFirst(h);
  }

  // ------------------------------------------------------------ keyboard
  function isInteractive(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function onKeyDown(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = ev.key;
    const activate = key === 'Enter' || key === ' ';
    // A held key must never activate the next screen's controls.
    if (ev.repeat && (activate || /^[1-6a-fA-F]$/.test(key))) {
      if (activate) ev.preventDefault();
      return;
    }
    if (isInteractive(ev.target) || !current) return;
    if (current.kind === 'question' && !current.answered) {
      const m = /^([a-fA-F])$/.exec(key);
      const d = /^([1-6])$/.exec(key);
      const index = m ? m[1].toUpperCase().charCodeAt(0) - 65 : d ? Number(d[1]) - 1 : -1;
      if (index >= 0) {
        ev.preventDefault();
        current.choose(index);
      }
    } else if (current.kind === 'card' && current.isRevealed() && !current.answered) {
      const d = /^([1-4])$/.exec(key);
      if (d) {
        ev.preventDefault();
        current.grade(GRADES[Number(d[1]) - 1][0]);
      }
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  begin();

  return function teardown() {
    torn = true;
    current = null;
    releaseUrls(root);
    clearTimeout(readyTimer);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}
