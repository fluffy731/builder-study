// Passphrase unlock for the encrypted build: vault.json loading, the remembered-key
// check and the unlock screen. Only static copy is shown before the data is open.
// All text goes through el() / mount() (text nodes only).
import { el, mount } from './dom.js';
import { dataBase } from './dataurl.js';
import { deriveKey, verifyCheck } from './vault.js';
import { setKey } from './access.js';
import { saveKey, loadKey, clearKey, isAvailable } from './keystore.js';

export const WRONG_TEXT = "That passphrase didn't unlock the data.";
export const BUSY_TEXT = 'Unlocking… this can take a few seconds on a phone.';
export const RETRY_DELAY_MS = 1000;

// vault.json (public: salt, iteration count, passphrase check, file names).
export async function loadVaultMeta() {
  const res = await fetch(`${dataBase()}vault.json`);
  if (!res.ok) throw new Error(`vault.json: HTTP ${res.status}`);
  const meta = await res.json();
  if (!meta || meta.v !== 1 || typeof meta.salt !== 'string' || typeof meta.check !== 'string'
    || !Number.isInteger(meta.iterations) || meta.iterations < 1) {
    throw new Error('vault.json: unexpected format');
  }
  return meta;
}

// A key kept from an earlier visit, if it still opens the CURRENT vault. A key that
// fails (the data was re-published with a new passphrase) is deleted. Returns true when unlocked.
export async function unlockWithRemembered(meta) {
  const saved = await loadKey();
  if (!saved) return false;
  let ok = false;
  try {
    ok = typeof CryptoKey !== 'undefined' && saved.key instanceof CryptoKey && await verifyCheck(saved.key, meta.check);
  } catch {
    ok = false;
  }
  if (!ok) {
    await clearKey();
    return false;
  }
  setKey(saved.key);
  return true;
}

// Derive, verify, and (if asked) remember. Resolves { ok, remembered }; a wrong passphrase is { ok: false }.
export async function tryPassphrase(meta, passphrase, remember) {
  const key = await deriveKey(passphrase, meta.salt, meta.iterations, { extractable: false });
  if (!(await verifyCheck(key, meta.check))) return { ok: false, remembered: false };
  setKey(key);
  let remembered = false;
  if (remember) remembered = await saveKey(key, meta.check);
  else await clearKey(); // an earlier remembered key must not survive an un-ticked unlock
  return { ok: true, remembered };
}

// Draw the unlock screen into `root`. Resolves { remembered } once the passphrase is right.
export function showUnlock(root, meta) {
  return new Promise((resolve) => {
    let busy = false;
    let blockedUntil = 0;

    const input = el('input', {
      id: 'passphrase', name: 'passphrase', type: 'password', autocomplete: 'current-password',
      autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-describedby': 'remember-hint',
    });
    const show = el('input', {
      id: 'show-passphrase', type: 'checkbox',
      onchange: () => { input.type = show.checked ? 'text' : 'password'; },
    });
    const remember = el('input', { id: 'remember', type: 'checkbox', checked: true });
    const button = el('button', { id: 'unlock-btn', type: 'submit', class: 'btn primary' }, 'Unlock');
    const message = el('div', { id: 'unlock-message' });
    const status = el('p', { id: 'unlock-status', class: 'muted small', role: 'status' });
    const form = el('form', { id: 'unlock-form', novalidate: true }, null);

    function setMessage(text) {
      mount(message, text ? el('p', { id: 'unlock-error', class: 'status error', role: 'alert' }, text) : null);
    }

    function setBusy(on) {
      busy = on;
      button.disabled = on;
      if (on) {
        form.setAttribute('aria-busy', 'true');
        button.setAttribute('aria-busy', 'true');
      } else {
        form.removeAttribute('aria-busy');
        button.removeAttribute('aria-busy');
      }
      mount(status, on ? BUSY_TEXT : null);
    }

    async function submit(ev) {
      ev.preventDefault();
      if (busy || Date.now() < blockedUntil) return;
      const text = input.value;
      setMessage('');
      if (text === '') {
        setMessage('Enter your passphrase first.');
        input.focus();
        return;
      }
      setBusy(true);
      let result;
      try {
        // Let the busy state paint before the key derivation starts.
        await new Promise((r) => setTimeout(r, 0));
        result = await tryPassphrase(meta, text, remember.checked);
      } catch {
        setBusy(false);
        setMessage("This browser couldn't unlock the data. The page needs HTTPS (or localhost) and a recent browser.");
        input.focus();
        return;
      }
      if (result.ok) {
        input.value = '';
        resolve({ remembered: result.remembered });
        return;
      }
      blockedUntil = Date.now() + RETRY_DELAY_MS;
      setBusy(false);
      button.disabled = true; // a short pause before another attempt is accepted
      setTimeout(() => { if (!busy) button.disabled = false; }, RETRY_DELAY_MS);
      setMessage(WRONG_TEXT);
      input.focus();
      input.select();
    }

    form.addEventListener('submit', submit);
    mount(form,
      el('label', { for: 'passphrase' }, 'Passphrase'),
      input,
      el('label', { class: 'check-row', for: 'show-passphrase' }, show, el('span', null, 'Show passphrase')),
      el('label', { class: 'check-row', for: 'remember' }, remember, el('span', null, 'Remember on this device')),
      el('p', { id: 'remember-hint', class: 'muted small' }, 'This browser keeps an unlock key (not your passphrase) on this device. Anyone who can use this browser, or who has a copy of its files such as a backup, can open the app. Untick this on a shared device.'),
      isAvailable() ? null : el('p', { class: 'muted small' }, "This browser can't keep an unlock key on this device, so you will be asked for the passphrase each time."),
      message,
      status,
      button);

    mount(root, el('section', { class: 'card panel unlock' },
      el('h1', null, 'Builder Study'),
      el('p', null, 'Enter your passphrase to unlock the study data.'),
      form));
    input.focus();
  });
}
