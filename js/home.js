// Home: what is due, what is new today, the streak, and per-module mastery.
import { el, mount } from './dom.js';
import { dueIds, newIds, localDateStr } from './queue.js';

const MASTERED_DAYS = 21;
const MODULES = [1, 2, 3, 4, 5, 6];

function cardModule(card) {
  const m = card && typeof card.noteDoc === 'string' ? /^m(\d+)/.exec(card.noteDoc) : null;
  return m ? Number(m[1]) : null;
}

// Streak shown only while it is still alive: last studied today or yesterday.
export function shownStreak(streak, nowMs) {
  if (!streak || !streak.last || !Number.isFinite(streak.count)) return 0;
  const d = new Date(nowMs);
  const yesterday = localDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime());
  return streak.last === localDateStr(nowMs) || streak.last === yesterday ? streak.count : 0;
}

// Pure: everything Home shows, from data + state + clock.
export function homeStats(data, state, nowMs) {
  const questions = data.questions;
  const cards = data.cards;
  const args = { questions, cards, items: state.items, now: nowMs, module: state.settings.module };
  const due = dueIds(args).length;
  const fresh = newIds({ ...args, newCap: state.settings.newPerDay, newToday: state.daily.newCount }).length;

  // Mastery: settled items over ALL eligible items in the module (the same
  // eligible set as queue.js: questions without needsFigure, plus cards).
  const settled = (id) => Object.prototype.hasOwnProperty.call(state.items, id)
    && state.items[id].interval >= MASTERED_DAYS;
  const mastery = MODULES.map((module) => {
    let total = 0;
    let mastered = 0;
    const count = (id) => {
      total += 1;
      if (settled(id)) mastered += 1;
    };
    for (const q of questions) if (!q.needsFigure && Number(q.module) === module) count(q.id);
    for (const c of cards) if (cardModule(c) === module) count(c.id);
    return { module, total, mastered, percent: total ? Math.round((mastered / total) * 100) : 0 };
  });

  return { due, fresh, streak: shownStreak(state.streak, nowMs), mastery };
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

export function renderHome(root, ctx) {
  ctx.store.rollDaily({ streak: false });
  const state = ctx.store.state();
  const s = homeStats(ctx.data, state, Date.now());
  const filter = state.settings.module === 'all' ? 'all modules' : `Module ${state.settings.module}`;

  const stat = (value, label, id) => el('div', { class: 'stat' },
    el('div', { class: 'stat-value', id }, String(value)),
    el('div', { class: 'stat-label' }, label));

  mount(root,
    el('h1', null, 'Home'),
    el('p', { class: 'muted' }, `Studying ${filter}.`),
    el('section', { class: 'stats', 'aria-label': 'Today' },
      stat(s.due, plural(s.due, 'item due today', 'items due today'), 'stat-due'),
      stat(s.fresh, plural(s.fresh, 'new item available', 'new items available'), 'stat-new'),
      stat(s.streak, plural(s.streak, 'day streak', 'day streak'), 'stat-streak')),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => ctx.navigate('#/learn') }, 'Start learning'),
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.navigate('#/review') }, 'Start review')),
    el('section', { class: 'card', 'aria-labelledby': 'mastery-h' },
      el('h2', { id: 'mastery-h' }, 'Mastery by module'),
      el('p', { class: 'muted small' },
        `Share of each module's questions and cards that are settled (an interval of ${MASTERED_DAYS} days or more).`),
      el('ul', { class: 'mastery' },
        s.mastery.map((m) => el('li', { class: 'mastery-row', 'data-module': m.module },
          el('div', { class: 'mastery-head' },
            el('span', null, `Module ${m.module}`),
            el('span', { class: 'mastery-pct' }, `${m.percent}%`)),
          el('div', {
            class: 'bar', role: 'progressbar', 'aria-label': `Module ${m.module} mastery`,
            'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': m.percent,
          }, el('span', { style: { width: `${m.percent}%` } })),
          el('div', { class: 'muted small' },
            m.total ? `${m.mastered} of ${m.total} ${plural(m.total, 'item', 'items')} settled` : 'No items in this module'))))));
}
