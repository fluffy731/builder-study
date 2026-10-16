// App shell: loads the data, owns the store, routes #/home #/learn #/review
// #/browse[/...] #/settings, and draws the warning banner and error screens.
// Every URL is relative so the site works from a repo subpath.
import { el, mount } from './dom.js';
import { createStore, STORAGE_KEY } from './store.js';
import { search } from './search.js';
import { renderHome } from './home.js';
import { renderSettings } from './settings.js';
import { isVaultMode, isUnlocked, lock as lockAccess, loadJSON, isIntegrityError, DAMAGED_TEXT } from './access.js';

const ROUTES = ['home', 'learn', 'review', 'browse', 'settings'];
const view = document.getElementById('view');
const banner = document.getElementById('banner');

function getStorage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

const store = createStore(getStorage());

// ---------------------------------------------------------------- data
// All data goes through access.js: plain files in the development build, files
// decrypted in memory in the encrypted (published) build.
async function fetchJSON(rel) {
  const body = await loadJSON(rel);
  if (!Array.isArray(body)) throw new Error(`${rel}: unexpected format`);
  return body;
}

function indexById(list) {
  const map = new Map();
  for (const x of list) map.set(x.id, x);
  return map;
}

async function loadData() {
  const [questions, cards, notes] = await Promise.all([
    fetchJSON('questions.json'),
    fetchJSON('cards.json'),
    fetchJSON('notes-index.json'),
  ]);
  return {
    questions, cards, notes,
    questionsById: indexById(questions),
    cardsById: indexById(cards),
    notesById: indexById(notes),
  };
}

let dataPromise = null;
function getData() {
  if (!dataPromise) {
    dataPromise = loadData().then((d) => { ctx.data = d; return d; }, (e) => { dataPromise = null; throw e; });
  }
  return dataPromise;
}

// ---------------------------------------------------------------- banner
// The store's warning (stays until dismissed here, or cleared by a successful
// import / restore) plus an optional one-off note about a Restore copy attempt.
let dismissedWarning = null;
let bannerNote = null; // { text, error }

function restoreFromBanner() {
  let result;
  try {
    result = store.restoreBackup();
  } catch (e) {
    result = { ok: false, error: e && e.message ? e.message : 'Something went wrong.' };
  }
  if (result.ok) {
    const n = Object.keys(store.state().items).length;
    bannerNote = { text: `Your saved copy was restored (${n} ${n === 1 ? 'item' : 'items'}).`, error: false };
    route_(); // redraw the current screen from the restored progress
  } else {
    bannerNote = { text: `The saved copy could not be restored. ${result.error} Your current progress has not been changed.`, error: true };
    refreshBanner();
  }
  const note = banner.querySelector('.banner-note');
  if (note) note.focus({ preventScroll: true });
}

function refreshBanner() {
  const warning = store.warning;
  const showWarning = !!warning && warning !== dismissedWarning;
  if (!showWarning && !bannerNote) {
    banner.hidden = true;
    mount(banner);
    return;
  }
  banner.hidden = false;
  const canRestore = showWarning && store.warningKind === 'unreadable' && store.hasBackup();
  mount(banner,
    showWarning ? el('span', { class: 'banner-text' }, warning) : null,
    bannerNote ? el('span', { class: `banner-note${bannerNote.error ? ' error' : ''}`, tabindex: '-1' }, bannerNote.text) : null,
    canRestore ? el('button', { type: 'button', id: 'banner-restore', class: 'btn small-btn', onclick: restoreFromBanner }, 'Restore copy') : null,
    el('button', {
      type: 'button', class: 'btn small-btn', 'aria-label': 'Dismiss warning',
      onclick: () => {
        if (showWarning) dismissedWarning = warning;
        bannerNote = null;
        refreshBanner();
        view.focus({ preventScroll: true });
      },
    }, 'Dismiss'));
}

// ---------------------------------------------------------------- context
const ctx = {
  data: null,
  store,
  navigate(hash) { window.location.hash = hash; },
  search(q, limit) { return search(ctx.data ? ctx.data.notes : [], q, limit); },
  refreshBanner,
  // Encrypted build only: { remembered } and lockNow(); null in the plaintext build.
  vault: isVaultMode() ? { remembered: null } : null,
  lockNow() { return lockNow(); },
};

// ---------------------------------------------------------------- router
function parseHash() {
  let raw = window.location.hash.replace(/^#/, '');
  // A query string after the path (#/browse/notes?x=1) is ignored everywhere.
  const q = raw.indexOf('?');
  if (q !== -1) raw = raw.slice(0, q);
  if (!raw.startsWith('/')) return null;
  const parts = raw.slice(1).split('/');
  const name = parts[0];
  if (!ROUTES.includes(name)) return null;
  const sub = [];
  for (const part of parts.slice(1)) {
    if (part === '') continue;
    let seg;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    // Never let a decoded segment act as a path.
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\')) return null;
    sub.push(seg);
  }
  return { name, sub };
}

function setTabs(name) {
  for (const a of document.querySelectorAll('nav.tabs a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function panel(title, text, ...actions) {
  return el('section', { class: 'card panel' }, el('h1', null, title), el('p', null, text), actions.length ? el('div', { class: 'actions' }, actions) : null);
}

function errorPanel(onRetry, err) {
  return panel('Could not load the study data',
    isIntegrityError(err)
      ? `${DAMAGED_TEXT} Settings and your saved progress are still available.`
      : 'The question and notes files did not load. Check your connection and try again. Settings and your saved progress are still available.',
    el('button', { type: 'button', id: 'retry-btn', class: 'btn primary', onclick: onRetry }, 'Retry'),
    el('a', { class: 'btn', href: '#/settings' }, 'Open Settings'));
}

let routeToken = 0;
let teardown = null;
let firstRender = true;

// Views live in their own modules, loaded on demand. A failed import (offline
// and not cached, flaky network) is a normal, recoverable error: the person sees
// a message with a Retry button. Retry loads the module under a new query string
// so a cached failure can never be replayed.
let importAttempt = 0;
const MODULES = {
  session: (q) => import(`./session.js${q}`),
  browse: (q) => import(`./browse.js${q}`),
};

// A module that loaded once is kept, so a successful Retry never leaves a
// second copy (and a ?retry URL) behind: later routes reuse it. Offline note for
// the service worker: Retry requests carry ?retry=N, so cache matching must
// ignore the query string (ignoreSearch) or let those requests reach the network.
const loadedModules = {};

async function loadModule(name) {
  if (loadedModules[name]) return loadedModules[name];
  const mod = await MODULES[name](importAttempt ? `?retry=${importAttempt}` : '');
  loadedModules[name] = mod;
  importAttempt = 0;
  return mod;
}

function sectionErrorPanel() {
  return panel('Could not load this section',
    'This part of the app did not load. Check your connection and try again. Home and Settings are still available.',
    el('button', {
      type: 'button', id: 'retry-btn', class: 'btn primary',
      onclick: () => { importAttempt += 1; route_(); },
    }, 'Retry'),
    el('a', { class: 'btn', href: '#/home' }, 'Go to Home'));
}

// Run a view that lives in its own module. It renders into a fresh host
// element inside <main>, so a slow view that finishes after the user has moved
// on can only paint into a detached element, and its teardown is called at once.
async function runView(token, moduleName, exportName, call) {
  let fn;
  try {
    const mod = await loadModule(moduleName);
    fn = mod[exportName];
  } catch {
    if (token !== routeToken) return;
    mount(view, sectionErrorPanel());
    return;
  }
  if (token !== routeToken) return;
  if (typeof fn !== 'function') throw new TypeError(`${moduleName}.js does not export ${exportName}()`);
  const host = el('div', { class: 'view-host' });
  mount(view, host);
  const result = await call(fn, host);
  if (token !== routeToken) {
    if (typeof result === 'function') {
      try { result(); } catch { /* ignore */ }
    }
    return;
  }
  teardown = result;
}

async function renderRoute(route, token) {
  const { name, sub } = route;
  if (name === 'settings') {
    renderSettings(view, ctx);
    return;
  }
  let data;
  try {
    data = await getData();
  } catch (err) {
    if (token !== routeToken) return;
    mount(view, errorPanel(() => { dataPromise = null; route_(); }, err));
    return;
  }
  if (token !== routeToken) return;
  ctx.data = data;
  if (name === 'home') {
    renderHome(view, ctx);
  } else if (name === 'learn' || name === 'review') {
    await runView(token, 'session', 'startSession', (fn, host) => fn(host, ctx, name));
  } else if (name === 'browse') {
    await runView(token, 'browse', 'render', (fn, host) => fn(host, ctx, sub));
  }
}

async function route_() {
  if (locked) return; // nothing is drawn (and no tab is active) while the data is locked
  const route = parseHash();
  if (!route) {
    window.location.replace('#/home');
    return;
  }
  const token = ++routeToken;
  if (typeof teardown === 'function') {
    try { teardown(); } catch { /* a view's cleanup must not break navigation */ }
  }
  teardown = null;
  view.removeAttribute('data-view-ready');
  setTabs(route.name);
  try {
    store.rollDaily({ streak: false });
  } catch { /* progress still works in memory */ }
  try {
    await renderRoute(route, token);
  } catch (e) {
    if (token !== routeToken) return;
    console.error(e);
    mount(view, panel('Something went wrong', 'This screen could not be shown. Try another tab, or reload the page.',
      el('a', { class: 'btn', href: '#/home' }, 'Go to Home')));
  }
  if (token !== routeToken) return;
  refreshBanner();
  if (!firstRender) {
    // Move focus to the new view unless the view already placed it.
    if (!view.contains(document.activeElement)) view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  firstRender = false;
  view.setAttribute('data-view-ready', route.name);
}

// ---------------------------------------------------------------- offline
// Register the service worker after the page has loaded, so it never competes
// with the first render. Skipped on file:// and other non-web protocols, when the
// browser has no service workers, and when a test sets window.BUILDER_NO_SW. A
// failure is silent: the app works online without it, so no banner, no console noise.
let workerRequested = false;
function registerWorker() {
  if (workerRequested) return;
  workerRequested = true;
  if (window.BUILDER_NO_SW) return;
  if (!/^https?:$/.test(window.location.protocol)) return;
  if (!('serviceWorker' in navigator)) return;
  const go = () => {
    try {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
    } catch { /* same */ }
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}

document.getElementById('skip').addEventListener('click', (ev) => {
  ev.preventDefault();
  view.focus();
});
window.addEventListener('hashchange', () => {
  bannerNote = null; // a one-off note belongs to the screen it was shown on
  route_();
});

// Another tab or window changed the stored progress. Re-read it so this tab
// never works from a stale snapshot, and redraw the screens that show it. A
// session in progress keeps its own queue and is not redrawn: its next change
// goes through store.update(), which re-reads the stored progress again.
window.addEventListener('storage', (ev) => {
  if (locked) return;
  if (ev.key !== null && ev.key !== STORAGE_KEY) return;
  try {
    if (ev.storageArea && ev.storageArea !== getStorage()) return;
  } catch { return; }
  let changed = false;
  try {
    changed = store.reload();
  } catch { /* keep what is in memory */ }
  if (!changed) return;
  const route = parseHash();
  const shows = route && (route.name === 'home' || route.name === 'settings'
    || (route.name === 'browse' && (route.sub[0] === 'cards' || route.sub[0] === 'flagged')));
  if (shows) route_();
  else refreshBanner();
});
// ---------------------------------------------------------------- encrypted build
// In the published build the data files are ciphertext. Nothing is requested or
// drawn except vault.json until the passphrase (or a remembered key) opens them.
// Locking forgets the key, drops the decrypted data and shows the unlock screen again.
const tabBar = document.querySelector('nav.tabs');
let locked = false;

function setLocked(on) {
  locked = on;
  if (tabBar) tabBar.hidden = on;
  document.body.classList.toggle('locked', on);
  if (on) {
    banner.hidden = true;
    mount(banner);
    view.removeAttribute('data-view-ready');
    setTabs(null);
  }
}

async function bootVault() {
  setLocked(true);
  let unlockMod;
  let meta;
  try {
    unlockMod = await import('./unlock.js');
    meta = await unlockMod.loadVaultMeta();
  } catch {
    mount(view, panel('Could not load the study data',
      'The data files did not load. Check your connection and try again.',
      el('button', { type: 'button', id: 'retry-btn', class: 'btn primary', onclick: () => { bootVault().then(startVault); } }, 'Retry')));
    return false;
  }
  if (await unlockMod.unlockWithRemembered(meta)) {
    ctx.vault.remembered = true;
  } else {
    const result = await unlockMod.showUnlock(view, meta);
    ctx.vault.remembered = result.remembered;
  }
  setLocked(false);
  return true;
}

function startVault(ok) {
  if (ok === false) return;
  route_();
  registerWorker();
}

// Lock now must lock every open tab of the app, not just the one it was pressed in. Tabs tell
// each other over a BroadcastChannel; where that does not exist, a write to a harmless
// localStorage key fires a `storage` event in the other tabs. A tab that is already locked
// ignores the message, so it never ends up with two unlock screens.
const LOCK_CHANNEL = 'builder-study-vault';
const LOCK_STORAGE_KEY = 'builder-study.lock';
let lockChannel = null;

function broadcastLock() {
  if (lockChannel) {
    try { lockChannel.postMessage('lock'); } catch { /* the other tabs stay unlocked until reloaded */ }
    return;
  }
  try {
    window.localStorage.setItem(LOCK_STORAGE_KEY, String(Date.now()));
    window.localStorage.removeItem(LOCK_STORAGE_KEY);
  } catch { /* storage blocked: nothing to tell the others with */ }
}

function onLockSignal() {
  if (isUnlocked()) lockNow(false);
}

function listenForLock() {
  try {
    if (typeof BroadcastChannel === 'function') {
      lockChannel = new BroadcastChannel(LOCK_CHANNEL);
      lockChannel.onmessage = (event) => { if (event && event.data === 'lock') onLockSignal(); };
      return;
    }
  } catch { lockChannel = null; }
  window.addEventListener('storage', (event) => {
    if (event.key === LOCK_STORAGE_KEY && event.newValue !== null) onLockSignal();
  });
}

async function lockNow(broadcast = true) {
  if (broadcast) broadcastLock();
  routeToken += 1; // views still loading can no longer paint
  if (typeof teardown === 'function') {
    try { teardown(); } catch { /* a view's cleanup must not break locking */ }
  }
  teardown = null;
  lockAccess(); // forget the key, revoke object URLs
  ctx.data = null;
  dataPromise = null;
  try {
    const { clearKey } = await import('./keystore.js');
    await clearKey();
  } catch { /* nothing was remembered */ }
  if (ctx.vault) ctx.vault.remembered = null;
  startVault(await bootVault());
}

if (isVaultMode()) {
  listenForLock();
  bootVault().then(startVault);
} else {
  route_();
  registerWorker();
}
