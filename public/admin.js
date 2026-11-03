'use strict';

// Creator's inbox: read, mark done and delete feedback. The admin key stays in this browser only.

const KEY = 'mylampus.admin';
const KINDS = { idea: t('a.idea'), bug: t('a.bug'), other: t('a.other') };
const $ = (id) => document.getElementById(id);
let items = [];
let filter = 'new';

function getKey() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

function setKey(k) {
  try { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY); } catch { /* memory only */ }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function call(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: getKey(), ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(res.status === 403 ? t('a.wrongKey') : res.status === 503 ? t('a.noKey') : (data.error || `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return data;
}

function render() {
  $('count-new').textContent = items.filter((f) => !f.done).length;
  $('count-all').textContent = items.length;
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  const shown = filter === 'new' ? items.filter((f) => !f.done) : items;
  $('list').innerHTML = shown.length ? shown.map((f) => `
    <article class="card fb-item${f.done ? ' done' : ''}" data-id="${f.id}">
      <div class="fb-meta">
        <span>${KINDS[f.kind] || f.kind}</span>
        <span>${f.from === 'owner' ? `${t('a.fromOwner')}${f.truckName ? ` · ${escapeHtml(f.truckName)}` : ''}` : t('a.fromCustomer')}</span>
        <span>${new Date(f.createdAt).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <p>${escapeHtml(f.message)}</p>
      ${f.contact ? `<div class="fb-contact">${t('a.contact', { c: escapeHtml(f.contact) })}</div>` : ''}
      <div class="link-row">
        <button type="button" data-act="done">${t(f.done ? 'a.markUnread' : 'a.markRead')}</button>
        <button type="button" data-act="delete">${t('a.delete')}</button>
      </div>
    </article>`).join('') : `<p class="sub">${t('a.empty')}</p>`;
}

async function load() {
  try {
    items = (await call('/api/admin/feedback')).feedback;
    $('login').classList.add('hidden');
    $('inbox').classList.remove('hidden');
    render();
  } catch (err) {
    if (err.status === 403) setKey('');
    $('login').classList.remove('hidden');
    $('inbox').classList.add('hidden');
    $('login-msg').textContent = err.message;
    $('login-msg').classList.add('err');
  }
}

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  setKey($('key').value);
  load();
});

$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const item = items.find((f) => f.id === id);
  if (btn.dataset.act === 'delete' && !confirm(t('a.confirmDelete'))) return;
  await call(`/api/admin/feedback/${id}/${btn.dataset.act}`, { done: !item.done });
  load();
});

for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => { filter = b.dataset.filter; render(); });
}
// ---------- Shops (moderation) ----------

async function loadShops() {
  const { trucks } = await call('/api/admin/trucks');
  $('shops').innerHTML = trucks.length ? trucks.map((s) => `
    <article class="card fb-item${s.hidden ? ' done' : ''}" data-shop="${s.id}" style="--c:${escapeHtml(s.color)}">
      <div class="fb-meta">
        <span>${s.hidden ? t('a.suspended') : s.open ? t('mine.openNow') : t('mine.closed')}</span>
        <span>${t('a.lastOpen')}: ${s.lastOpenedAt ? new Date(s.lastOpenedAt).toLocaleString(I18N.locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</span>
        <span>💬 ${s.chats}</span>
      </div>
      <p><b>${escapeHtml(s.name)}</b>${s.menu ? `<br><small>${escapeHtml(s.menu)}</small>` : ''}</p>
      <div class="link-row">
        <a href="/t/${s.id}" target="_blank" rel="noopener">${t('a.view')}</a>
        <button type="button" data-shop-act="hide">${t(s.hidden ? 'a.unsuspend' : 'a.suspend')}</button>
        <button type="button" data-shop-act="delete">${t('a.delete')}</button>
      </div>
    </article>`).join('') : `<p class="sub">${t('a.noShops')}</p>`;
}

$('shops').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-shop-act]');
  if (!btn) return;
  const card = btn.closest('[data-shop]');
  const id = card.dataset.shop;
  if (btn.dataset.shopAct === 'delete') {
    if (!confirm(t('a.confirmDeleteShop'))) return;
    await call(`/api/admin/trucks/${id}/delete`);
  } else {
    const hidden = !card.classList.contains('done');
    if (hidden && !confirm(t('a.confirmSuspend'))) return;
    await call(`/api/admin/trucks/${id}/hide`, { hidden });
  }
  loadShops();
});

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('[data-view]')) x.setAttribute('aria-pressed', String(x === b));
    $('view-feedback').classList.toggle('hidden', b.dataset.view !== 'feedback');
    $('view-shops').classList.toggle('hidden', b.dataset.view !== 'shops');
    if (b.dataset.view === 'shops') loadShops();
  });
}

// Full data backup as a file, to keep somewhere other than the server.
$('backup').addEventListener('click', async () => {
  const data = await call('/api/admin/backup');
  const day = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `lampus-backup-${day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('refresh').addEventListener('click', load);
$('logout').addEventListener('click', () => { setKey(''); location.reload(); });

if (getKey()) load();
