// "Remember on this device": the derived AES key (a non-extractable CryptoKey, so
// script cannot read its bytes) plus the vault `check` string it was verified
// against, kept in IndexedDB database "builder-study-vault", object store "keys".
// "Non-extractable" only stops script on the page from reading the key. The key still
// sits in the browser profile on disk, so anyone who can open this browser, or who has a
// copy of the profile files (a device backup, for example), can open the app until the
// next re-publish. The passphrase itself is never stored. Every function is
// failure-tolerant: private mode, blocked storage, a quota error or a hung open
// all resolve to "nothing remembered" and never break unlocking.
export const DB_NAME = 'builder-study-vault';
export const STORE = 'keys';
const RECORD_ID = 'vault';
const TIMEOUT_MS = 4000;

function withTimeout(promise, ms = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('IndexedDB timed out')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = window.indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(STORE); } catch { /* reported by onerror */ }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

async function run(mode, action) {
  const db = await withTimeout(openDb());
  try {
    return await withTimeout(new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out.result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    }));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export function isAvailable() {
  try {
    return typeof window.indexedDB !== 'undefined' && window.indexedDB !== null;
  } catch {
    return false;
  }
}

// Store the key with the check string. Resolves true if saved, false on any failure.
export async function saveKey(key, check) {
  try {
    await run('readwrite', (store) => store.put({ key, check }, RECORD_ID));
    return true;
  } catch {
    return false;
  }
}

// { key, check } or null (nothing remembered, unreadable, or storage unavailable).
export async function loadKey() {
  try {
    const rec = await run('readonly', (store) => store.get(RECORD_ID));
    if (rec && typeof rec.check === 'string' && rec.key) return { key: rec.key, check: rec.check };
  } catch { /* nothing remembered */ }
  return null;
}

export async function clearKey() {
  try {
    await run('readwrite', (store) => store.delete(RECORD_ID));
    return true;
  } catch {
    return false;
  }
}
