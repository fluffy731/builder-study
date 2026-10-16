// The ONLY way the views read provider data (questions, cards, notes, figures).
//
//   plaintext build (site/, the development and test build): plain fetches of
//     <data base>questions.json and so on, exactly as before.
//   encrypted build (publish/): the page carries <meta name="builder-vault" content="1">;
//     every read fetches <data base><rel>.enc and decrypts it in memory with the key
//     from the passphrase (see vault.js for the format; AAD = rel). Decrypted data
//     is never written to localStorage, IndexedDB or any Cache; object URLs for
//     figures are revoked by releaseUrls() / lock().
//
// `rel` is always relative to the data folder: 'questions.json', 'notes/m3v1.html',
// 'img/m3q2n1.jpg'. createAccess() takes its environment as arguments so the logic
// can be tested in Node; the default instance below uses the page's globals.
import { dataBase, figureUrl } from './dataurl.js';

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

function mimeOf(rel) {
  const m = /\.([a-z0-9]+)$/i.exec(rel);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

// "notes/m3v1.html" -> "notes/m3v1.html" with each segment URI-encoded.
function encodePath(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

// A data file that was fetched fine but does not decrypt (flipped byte, truncated, from another
// publish). Retrying cannot fix it, so views show "damaged or out of date" instead of a network hint.
export const DAMAGED_TEXT = 'This file is damaged or out of date. Reload the page, or re-upload the published folder.';

export function isIntegrityError(err) {
  return !!err && err.name === 'VaultIntegrityError';
}

export function createAccess(env = {}) {
  const getFetch = env.fetch || ((...a) => globalThis.fetch(...a));
  const getBase = env.base || dataBase;
  const detectVault = env.vault || (() => {
    try {
      const m = globalThis.document && globalThis.document.querySelector('meta[name="builder-vault"]');
      return !!m && m.getAttribute('content') === '1';
    } catch {
      return false;
    }
  });
  // vault.js is only loaded in the encrypted build, so the plaintext build requests nothing extra.
  const decrypt = env.decrypt || (async (...args) => (await import('./vault.js')).decryptBlob(...args));
  const makeUrl = env.createObjectURL || ((blob) => URL.createObjectURL(blob));
  const dropUrl = env.revokeObjectURL || ((u) => URL.revokeObjectURL(u));
  const makeBlob = env.Blob || ((parts, opts) => new Blob(parts, opts));

  let key = null;
  const NO_OWNER = {};
  const owners = new Map(); // owner -> Set of object URLs
  const released = new WeakSet(); // owners whose views have been torn down

  function isVaultMode() {
    return detectVault();
  }

  function isUnlocked() {
    return !isVaultMode() || key !== null;
  }

  // Called by the unlock flow once a key has been verified against vault.json.
  function setKey(k) {
    key = k || null;
  }

  function releaseUrls(owner) {
    if (owner !== undefined && owner !== null && typeof owner === 'object') released.add(owner);
    const o = owner === undefined || owner === null ? NO_OWNER : owner;
    const set = owners.get(o);
    if (set) {
      for (const u of set) {
        try { dropUrl(u); } catch { /* already gone */ }
      }
      owners.delete(o);
    }
  }

  function releaseAll() {
    for (const o of [...owners.keys()]) releaseUrls(o);
  }

  // Forget the key and every object URL. Progress in localStorage is untouched.
  function lock() {
    key = null;
    releaseAll();
  }

  async function fetchBytes(rel, opts) {
    const res = await getFetch(`${getBase()}${encodePath(rel)}.enc`, opts);
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  async function decryptRel(rel, opts) {
    const k = key;
    if (!k) throw new Error('The study data is locked.');
    const blob = await fetchBytes(rel, opts);
    let plain;
    try {
      plain = await decrypt(k, String(rel), blob);
    } catch (cause) {
      if (k !== key) throw new Error('The study data was locked while it loaded.');
      const err = new Error(`${rel}: this file is damaged or out of date`);
      err.name = 'VaultIntegrityError';
      err.cause = cause;
      throw err;
    }
    if (k !== key) throw new Error('The study data was locked while it loaded.');
    return plain;
  }

  async function plainFetch(rel, opts) {
    const res = await getFetch(`${getBase()}${encodePath(rel)}`, opts);
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res;
  }

  async function loadText(rel, opts) {
    if (!isVaultMode()) return (await plainFetch(rel, opts)).text();
    return new TextDecoder().decode(await decryptRel(rel, opts));
  }

  async function loadJSON(rel, opts) {
    if (!isVaultMode()) return (await plainFetch(rel, opts)).json();
    return JSON.parse(await loadText(rel, opts));
  }

  // A URL an <img> can show. Plaintext build: the ordinary URL. Encrypted build: an object
  // URL for the decrypted bytes, owned by `owner` (a view's root element) so that view's
  // teardown can revoke it. A view that was already torn down gets a rejection, not a leak.
  async function imageObjectUrl(rel, owner) {
    if (!isVaultMode()) return `${getBase()}${encodePath(rel)}`;
    const plain = await decryptRel(rel);
    if (owner && released.has(owner)) throw new Error('The view was closed while the figure loaded.');
    const url = makeUrl(makeBlob([plain], { type: mimeOf(rel) }));
    const o = owner === undefined || owner === null ? NO_OWNER : owner;
    if (!owners.has(o)) owners.set(o, new Set());
    owners.get(o).add(url);
    return url;
  }

  return { isVaultMode, isUnlocked, setKey, lock, loadText, loadJSON, imageObjectUrl, releaseUrls, urlCount: () => [...owners.values()].reduce((n, s) => n + s.size, 0) };
}

const instance = createAccess();

export const isVaultMode = instance.isVaultMode;
export const isUnlocked = instance.isUnlocked;
export const setKey = instance.setKey;
export const lock = instance.lock;
export const loadText = instance.loadText;
export const loadJSON = instance.loadJSON;
export const imageObjectUrl = instance.imageObjectUrl;
export const releaseUrls = instance.releaseUrls;

// "data/img/m3q2n1.jpg" (a question's `figure`) -> "img/m3q2n1.jpg"
export function figureRel(figure) {
  return String(figure).replace(/^data\//, '');
}

// Point an <img> at a question figure. Plaintext build: src is set at once (as before).
// Encrypted build: decrypt, then set an object URL; on any failure the image gets an
// 'error' event, so the caller's onerror fallback text still shows.
export function showFigure(img, figure, owner) {
  const rel = figureRel(figure);
  if (!isVaultMode()) {
    img.src = figureUrl(figure);
    return;
  }
  imageObjectUrl(rel, owner).then(
    (url) => { img.src = url; },
    () => { img.dispatchEvent(new Event('error')); },
  );
}
