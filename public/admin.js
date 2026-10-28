'use strict';

// Creator's inbox: read, mark done and delete feedback. The admin key stays in this browser only.

const KEY = 'mylampus.admin';
const KINDS = { idea: '💡 ข้อเสนอแนะ', bug: '🐞 แจ้งปัญหา', other: '💬 อื่น ๆ' };
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
    const err = new Error(res.status === 403 ? 'รหัสไม่ถูกต้อง' : res.status === 503 ? 'ยังไม่ได้ตั้ง ADMIN_KEY บนเซิร์ฟเวอร์' : (data.error || `HTTP ${res.status}`));
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
        <span>${f.from === 'owner' ? `🚚 เจ้าของร้าน${f.truckName ? ` · ${escapeHtml(f.truckName)}` : ''}` : '🙂 ลูกค้า'}</span>
        <span>${new Date(f.createdAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <p>${escapeHtml(f.message)}</p>
      ${f.contact ? `<div class="fb-contact">ติดต่อกลับ: ${escapeHtml(f.contact)}</div>` : ''}
      <div class="link-row">
        <button type="button" data-act="done">${f.done ? 'ทำเป็นยังไม่อ่าน' : '✓ อ่านแล้ว'}</button>
        <button type="button" data-act="delete">ลบ</button>
      </div>
    </article>`).join('') : '<p class="sub">ไม่มีข้อความ ✦</p>';
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
  if (btn.dataset.act === 'delete' && !confirm('ลบข้อความนี้?')) return;
  await call(`/api/admin/feedback/${id}/${btn.dataset.act}`, { done: !item.done });
  load();
});

for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => { filter = b.dataset.filter; render(); });
}
$('refresh').addEventListener('click', load);
$('logout').addEventListener('click', () => { setKey(''); location.reload(); });

if (getKey()) load();
