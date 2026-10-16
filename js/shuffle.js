// Option shuffling. Options flagged `pinnedLast` ("All of the above" and the
// like) stay at the end in their original relative order; the rest are
// Fisher-Yates shuffled. Returns a new array of the same option objects and
// never mutates its input. Letters are assigned by the caller at display time.

export function shuffleOptions(options, rng = Math.random) {
  const free = [];
  const pinned = [];
  for (const o of options) (o && o.pinnedLast ? pinned : free).push(o);

  for (let i = free.length - 1; i > 0; i--) {
    // Math.min guards an out-of-contract rng that returns exactly 1.
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [free[i], free[j]] = [free[j], free[i]];
  }
  return free.concat(pinned);
}
