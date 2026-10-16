// Settings: study options, progress backup (export / import) and reset.
// Does not need the study data, so it works even when the data failed to load.
import { el, mount } from './dom.js';
import { localDateStr } from './queue.js';

const MAX_NEW = 100;

function errText(e) {
  return e && e.message ? e.message : 'Something went wrong.';
}

export function renderSettings(root, ctx) {
  const { store } = ctx;
  let confirming = false;
  let exported = '';

  function status(message, isError) {
    return el('p', {
      id: 'settings-status', class: `status${isError ? ' error' : ''}`, role: 'status', tabindex: '-1',
    }, message || '');
  }

  // Redraw everything from the stored state. Focus moves to the status node
  // so the message is announced and focus is not dropped to <body>.
  function draw(message, isError, focusId) {
    const { settings } = store.state();
    const statusNode = status(message, isError);

    const perDay = el('input', {
      id: 'new-per-day', name: 'newPerDay', type: 'number', inputmode: 'numeric',
      min: 1, max: MAX_NEW, step: 1, required: true, 'aria-describedby': 'per-day-hint', value: String(settings.newPerDay),
    });
    const moduleSel = el('select', { id: 'module-filter', name: 'module' },
      el('option', { value: 'all' }, 'All modules'),
      [1, 2, 3, 4, 5, 6].map((m) => el('option', { value: String(m) }, `Module ${m}`)));
    moduleSel.value = String(settings.module);

    const importBox = el('textarea', {
      id: 'import-text', rows: 5, spellcheck: 'false', autocomplete: 'off',
      placeholder: 'Paste exported progress here.',
    });
    const fileInput = el('input', { id: 'import-file', type: 'file', accept: '.json,application/json' });
    const exportBox = el('textarea', {
      id: 'export-text', rows: 6, readOnly: true, spellcheck: 'false', 'aria-label': 'Exported progress',
    });
    exportBox.value = exported;

    mount(root,
      el('h1', null, 'Settings'),
      statusNode,

      el('form', {
        class: 'card', 'aria-labelledby': 'study-h', novalidate: true,
        onsubmit: (ev) => { ev.preventDefault(); save(perDay.value, moduleSel.value); },
      },
        el('h2', { id: 'study-h' }, 'Study'),
        el('label', { for: 'new-per-day' }, 'New items per day'),
        el('p', { class: 'muted small', id: 'per-day-hint' }, `A whole number from 1 to ${MAX_NEW}. The default is 10.`),
        perDay,
        el('label', { for: 'module-filter' }, 'Module'),
        el('p', { class: 'muted small' }, 'Learn and Review only use items from this module.'),
        moduleSel,
        el('button', { type: 'submit', class: 'btn primary' }, 'Save settings')),

      el('section', { class: 'card', 'aria-labelledby': 'backup-h' },
        el('h2', { id: 'backup-h' }, 'Back up your progress'),
        el('p', { class: 'muted small' },
          'Progress is stored only in this browser. Export a copy now and then; import it to restore or move to another device.'),
        el('button', { type: 'button', id: 'export-btn', class: 'btn', onclick: doExport }, 'Export progress'),
        exported ? el('label', { for: 'export-text' }, 'If the download did not start, copy this text:') : null,
        exported ? exportBox : null,

        el('h3', null, 'Import progress'),
        el('label', { for: 'import-file' }, 'Choose an exported file'),
        fileInput,
        el('label', { for: 'import-text' }, 'Or paste exported progress'),
        importBox,
        el('button', { type: 'button', id: 'import-btn', class: 'btn', onclick: () => doImport(importBox.value) },
          'Import progress'),
        el('p', { class: 'muted small' }, 'Importing replaces the progress stored in this browser.'),

        store.hasBackup()
          ? [
            el('h3', null, 'Saved copy'),
            el('p', { class: 'muted small' },
              'If the app cannot read your saved progress, it keeps a copy of the original first. Restoring replaces the progress stored in this browser with that copy.'),
            el('button', { type: 'button', id: 'restore-btn', class: 'btn', onclick: doRestore }, 'Restore saved copy'),
          ]
          : null),

      el('section', { class: 'card', 'aria-labelledby': 'reset-h' },
        el('h2', { id: 'reset-h' }, 'Reset'),
        el('p', { class: 'muted small' },
          'Erases all progress, daily counts, streak and flagged cards on this device. Your settings are kept.'),
        confirming
          ? el('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm reset' },
            el('p', null, 'This cannot be undone. Export first if you might want it back.'),
            el('button', { type: 'button', id: 'reset-confirm', class: 'btn danger', onclick: doReset }, 'Really erase all progress?'),
            el('button', { type: 'button', id: 'reset-cancel', class: 'btn', onclick: cancelReset }, 'Cancel'))
          : el('button', { type: 'button', id: 'reset-btn', class: 'btn danger-outline', onclick: askReset }, 'Reset progress')),

      ctx.vault && typeof ctx.lockNow === 'function'
        ? el('section', { class: 'card', 'aria-labelledby': 'security-h' },
          el('h2', { id: 'security-h' }, 'Security'),
          el('p', null, 'Data is encrypted. Unlocked on this device.'),
          el('p', { class: 'muted small', id: 'security-remember' },
            ctx.vault.remembered
              ? 'This browser keeps an unlock key on this device (not your passphrase). Script on the page cannot export it, but it sits in the browser profile on disk, so a copy or backup of that profile, or anyone using this browser, can open the data. Use Lock now on shared devices: it deletes the key and locks every open tab, and you will be asked for the passphrase again.'
              : 'This device does not keep an unlock key. You will be asked for the passphrase again after closing this tab. Lock now also locks every other open tab.'),
          el('button', { type: 'button', id: 'lock-btn', class: 'btn', onclick: () => { ctx.lockNow(); } }, 'Lock now'))
        : null,

      el('section', { class: 'card', 'aria-labelledby': 'about-h' },
        el('h2', { id: 'about-h' }, 'About'),
        el('p', { class: 'small' },
          'Builder Study works offline once loaded. Question text belongs to the course provider and is included for personal study only.')));

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        importBox.value = await file.text();
        setStatus(`Loaded ${file.name}. Choose Import progress to use it.`, false);
      } catch {
        setStatus('That file could not be read.', true);
      }
    });

    if (ctx.refreshBanner) ctx.refreshBanner();
    const target = focusId ? document.getElementById(focusId) : message ? statusNode : null;
    if (target) target.focus({ preventScroll: false });
  }

  // Message without a redraw (keeps whatever the user has typed).
  function setStatus(message, isError) {
    const node = document.getElementById('settings-status');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('error', !!isError);
    node.focus();
  }

  function save(rawPerDay, rawModule) {
    const n = Number(String(rawPerDay).trim());
    if (String(rawPerDay).trim() === '' || !Number.isInteger(n) || n < 1 || n > MAX_NEW) {
      const input = document.getElementById('new-per-day');
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'per-day-hint settings-status');
      }
      setStatus(`New items per day must be a whole number from 1 to ${MAX_NEW}.`, true);
      return;
    }
    const m = rawModule === 'all' ? 'all' : Number.parseInt(rawModule, 10);
    try {
      store.update((s) => { s.settings.newPerDay = n; s.settings.module = m; });
    } catch (e) {
      setStatus(errText(e), true);
      return;
    }
    exported = ''; // the old export would show stale settings
    draw('Settings saved.', false);
  }

  function doExport() {
    const json = store.exportJSON();
    exported = json;
    let message = 'Progress exported. If no download appeared, copy the text below.';
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `builder-study-progress-${localDateStr(Date.now())}.json`, hidden: true });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      message = 'The download could not be started. Copy the text below instead.';
    }
    draw(message, false);
  }

  function doImport(text) {
    if (!text || !text.trim()) {
      setStatus('Paste exported progress or choose a file first.', true);
      return;
    }
    let result;
    try {
      result = store.importJSON(text);
    } catch (e) {
      result = { ok: false, error: errText(e) };
    }
    if (!result.ok) {
      setStatus(`Import failed: ${result.error} Your current progress has not been changed.`, true);
      return;
    }
    exported = '';
    const n = Object.keys(store.state().items).length;
    draw(`Progress imported (${n} ${n === 1 ? 'item' : 'items'}).`, false);
  }

  function doRestore() {
    let result;
    try {
      result = store.restoreBackup();
    } catch (e) {
      result = { ok: false, error: errText(e) };
    }
    if (!result.ok) {
      setStatus(`The saved copy could not be restored. ${result.error} Your current progress has not been changed.`, true);
      return;
    }
    exported = '';
    const n = Object.keys(store.state().items).length;
    draw(`Your saved copy was restored (${n} ${n === 1 ? 'item' : 'items'}).`, false);
  }

  function askReset() {
    confirming = true;
    draw('', false, 'reset-cancel');
  }

  function cancelReset() {
    confirming = false;
    draw('Reset cancelled. Nothing was erased.', false);
  }

  function doReset() {
    try {
      store.update((s) => {
        s.items = {};
        s.daily = { date: '', newCount: 0 };
        s.streak = { last: '', count: 0 };
        s.flags = {};
      });
    } catch (e) {
      confirming = false;
      draw(errText(e), true);
      return;
    }
    confirming = false;
    exported = '';
    draw('All progress has been erased. Your settings were kept.', false);
  }

  draw();
}
