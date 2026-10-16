// SM-2-lite scheduler. Pure: no clock, no storage, no globals. The caller passes
// the current time (epoch ms) and receives a brand new item back.
//
// Item = { ease, interval (days), reps, lapses, due (epoch ms), last (epoch ms) }

const DAY_MS = 86400000;
const MIN_EASE = 1.3;
const MAX_EASE = 10;
const MAX_INTERVAL = 36500; // 100 years; keeps every output finite and storable
const MAX_TIME = 8.64e15; // the limit of the JS Date range
const GRADES = ['again', 'hard', 'good', 'easy'];

export function newItem() {
  return { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, last: 0 };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Keep eases tidy (2.65, not 2.6500000000000004) so stored JSON stays stable.
function tidy(ease) {
  return Math.round(ease * 10000) / 10000;
}

function finiteOr(n, fallback) {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function count(n) {
  const v = finiteOr(n, 0);
  return v > 0 ? Math.floor(v) : 0;
}

// Repair a damaged input rather than let NaN or Infinity travel any further.
function normalise(item) {
  const src = item && typeof item === 'object' ? item : {};
  return {
    ease: clamp(finiteOr(src.ease, 2.5), MIN_EASE, MAX_EASE),
    interval: clamp(finiteOr(src.interval, 0), 0, MAX_INTERVAL),
    reps: count(src.reps),
    lapses: count(src.lapses),
  };
}

export function review(item, grade, nowMs) {
  if (!GRADES.includes(grade)) {
    throw new TypeError(`Unknown grade: ${String(grade)}`);
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || Math.abs(nowMs) > MAX_TIME) {
    throw new TypeError('nowMs must be a finite epoch time in milliseconds');
  }

  const cur = normalise(item);
  let { ease, interval, reps, lapses } = cur;

  if (grade === 'again') {
    reps = 0;
    lapses += 1;
    ease = Math.max(MIN_EASE, ease - 0.2);
    interval = 0;
  } else if (grade === 'hard') {
    ease = Math.max(MIN_EASE, ease - 0.15);
    interval = Math.max(1, Math.round(interval * 1.2));
    reps += 1;
  } else {
    // good and easy share the same base interval, computed from the previous ease.
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.max(1, Math.round(interval * ease));
    if (grade === 'easy') {
      interval = Math.max(1, Math.round(interval * 1.3));
      ease = Math.min(MAX_EASE, ease + 0.15);
    }
  }

  interval = Math.min(MAX_INTERVAL, interval);
  // A clock that moved backwards cannot hurt: interval is never negative, so
  // due >= nowMs always holds. `last` simply records the time given.
  const due = Math.min(MAX_TIME, nowMs + interval * DAY_MS);

  return { ease: tidy(ease), interval, reps, lapses, due, last: nowMs };
}
