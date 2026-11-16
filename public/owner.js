'use strict';

// Owner page: register a truck, light up its firefly, share GPS while open.

const COLORS = ['#d4ff4f', '#ffd84f', '#ff9f4f', '#4fffb0', '#4fd8ff', '#ff6fd8'];
const STORAGE_KEY = 'mylampus.owner';
const SEND_EVERY_MS = 15000;   // at most one location update per 15 s…
const SEND_MIN_METERS = 20;    // …unless the truck moved further than this
const HEARTBEAT_MS = 60000;    // confirm the position at least this often, even when parked
// Links and QR codes always point at the real domain, even when this page was opened elsewhere.
const SITE = ['localhost', '127.0.0.1'].includes(location.hostname) ? location.origin : 'https://lampus.app';

const $ = (id) => document.getElementById(id);

let creds = loadCreds();       // { id, token }
let truck = null;
let open = false;
let clockSkew = 0;
let watchId = null;
let heartbeat = null;
let lastSent = null;           // { lat, lng, at }
let wakeLock = null;

function loadCreds() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
  } catch {
    return null;
  }
}

function saveCreds(c) {
  creds = c;
  try {
    if (c) localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode: keep in memory only */ }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(I18N.err(data.error || `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return data;
}

function setMsg(id, text, isErr = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

function makeSwatches(container, selected, onPick) {
  container.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', t('o.colorLabel', { c }));
    b.setAttribute('aria-pressed', String(c === selected));
    b.addEventListener('click', () => {
      for (const s of container.children) s.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onPick(c);
    });
    container.appendChild(b);
  }
}

function formatLeft(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error(t('o.noGeo')));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(t(err.code === 1 ? 'o.geoDenied' : 'o.geoFail'))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}

// ---------- Rendering ----------

function render() {
  const registered = Boolean(creds && truck);
  $('register').classList.toggle('hidden', registered);
  $('dashboard').classList.toggle('hidden', !registered);
  if (!registered) return;

  const status = $('status');
  status.style.setProperty('--c', truck.color);
  status.classList.toggle('on', open);
  $('status-text').textContent = t(open ? 'o.statusOpen' : 'o.statusClosed', { name: truck.name });
  $('open-controls').querySelector('#open-btn').classList.toggle('hidden', open);
  $('close-controls').classList.toggle('hidden', !open);
  tick();
}

function tick() {
  if (!truck) return;
  if (open) {
    const left = truck.openUntil - (Date.now() + clockSkew);
    if (left <= 0) {
      setClosed(t('o.expired'));
      return;
    }
    const until = new Date(truck.openUntil).toLocaleTimeString(I18N.locale, { hour: '2-digit', minute: '2-digit' });
    $('status-sub').textContent = t('o.visible', { time: until, left: formatLeft(left) });
  } else {
    $('status-sub').textContent = t('o.resting');
  }
}
setInterval(tick, 1000);

function fillProfile() {
  $('p-name').value = truck.name;
  $('p-menu').value = truck.menu || '';
  profileColor = truck.color;
  makeSwatches($('p-swatches'), truck.color, (c) => { profileColor = c; });
  showCover(truck.photo || null);
  items = (truck.items || []).map((i) => ({ ...i }));
  renderItems();
  $('code').value = `${creds.id}.${creds.token}`;
  const shopUrl = `${SITE}/t/${creds.id}`;
  $('shop-url').value = shopUrl;
  $('view-shop').href = shopUrl;
  drawQr($('shop-qr'), shopUrl);
  $('code-qr-box').classList.add('hidden');
  $('show-code-qr').textContent = t('o.qrShow');
}

// ---------- QR codes ----------

// Draw `text` as a QR code filling a square canvas (dark modules on white, 4-module quiet zone).
function drawQr(canvas, text, x = 0, y = 0, size = canvas.width) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.floor(size / (n + 8));
  const offset = Math.floor((size - cell * n) / 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#0b1020';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + offset + c * cell, y + offset + r * cell, cell, cell);
    }
  }
}

// A printable card: brand, shop name, QR and the address, as a PNG download.
$('download-qr').addEventListener('click', () => {
  const W = 900;
  const H = 1200;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0b1020';
  ctx.textAlign = 'center';
  ctx.font = '700 64px Prompt, sans-serif';
  ctx.fillText('✦ LAMPUS', W / 2, 120);
  ctx.font = '600 52px Prompt, sans-serif';
  ctx.fillText(truck.name, W / 2, 210, W - 80);
  drawQr(canvas, $('shop-url').value, 110, 260, 680);
  ctx.font = '500 38px Prompt, sans-serif';
  ctx.fillText(t('o.qrScan'), W / 2, 1010, W - 80);
  ctx.fillStyle = '#5a6478';
  ctx.font = '400 30px Prompt, sans-serif';
  ctx.fillText($('shop-url').value.replace(/^https?:\/\//, ''), W / 2, 1080, W - 80);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `lampus-qr-${creds.id}.png`;
  a.click();
});

// The shop code QR is a secret, so it stays hidden until asked for. It opens /owner with the
// code after "#", which browsers never send to the server.
$('show-code-qr').addEventListener('click', () => {
  const box = $('code-qr-box');
  const show = box.classList.contains('hidden');
  if (show) drawQr($('code-qr'), `${SITE}/owner#code=${creds.id}.${creds.token}`);
  box.classList.toggle('hidden', !show);
  $('show-code-qr').textContent = t(show ? 'o.qrHide' : 'o.qrShow');
});

$('share-shop').addEventListener('click', async () => {
  const url = $('shop-url').value;
  if (navigator.share) {
    navigator.share({ title: truck?.name || 'LAMPUS', url }).catch(() => {});
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    $('share-shop').textContent = t('o.copied');
  } catch {
    $('shop-url').select();
  }
});

// ---------- Photos & menu items ----------

let coverPhoto = null;
let items = [];
let pickPhoto = null; // callback for the shared file input

// With a photo, tapping the frame opens it full screen (lightbox.js reads data-zoom);
// without one, tapping it picks a photo.
function showPhoto(el, url) {
  el.style.backgroundImage = url ? `url("${url}")` : '';
  el.classList.toggle('has-photo', Boolean(url));
  if (url) el.dataset.zoom = url;
  else delete el.dataset.zoom;
}

function showCover(url) {
  coverPhoto = url;
  showPhoto($('p-cover'), url);
  $('cover-actions').classList.toggle('hidden', !url);
}

// Photo shapes, matching how they are shown: shop photo 16:9, menu item square.
const PHOTO_SIZES = { cover: [1280, 720], item: [480, 480] };

async function uploadImage(blob) {
  const res = await fetch(`/api/trucks/${creds.id}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Token': creds.token },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(I18N.err(data.error || `HTTP ${res.status}`));
  return data.url;
}

function choosePhoto(kind, onUrl) {
  pickPhoto = { kind, onUrl };
  $('file').value = '';
  $('file').click();
}

$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file || !pickPhoto) return;
  const done = pickPhoto;
  pickPhoto = null;
  try {
    // The owner frames the photo themselves, in the shape customers will see.
    const blob = await Cropper.open(file, PHOTO_SIZES[done.kind]);
    if (!blob) return;
    setMsg('profile-msg', t('o.uploading'));
    done.onUrl(await uploadImage(blob));
    setMsg('profile-msg', t('o.uploaded'));
  } catch (err) {
    setMsg('profile-msg', err.message, true);
  }
});

$('p-cover').addEventListener('click', () => choosePhoto('cover', showCover));
$('cover-change').addEventListener('click', () => choosePhoto('cover', showCover));
$('cover-remove').addEventListener('click', () => {
  if (confirm(t('o.confirmRemovePhoto'))) showCover(null);
});

function renderItems() {
  const box = $('items');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = `<div class="empty-items">${t('o.noItems')}</div>`;
    return;
  }
  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <button type="button" class="thumb" aria-label="${t('o.itemPhoto')}">📷</button>
      <input class="name" maxlength="60" placeholder="${t('o.itemName')}" required>
      <input class="price" type="number" min="0" step="any" inputmode="decimal" placeholder="${t('o.itemPrice')}" required>
      <input class="desc" maxlength="120" placeholder="${t('o.itemDesc')}">
      <div class="row">
        <select class="cat"><option value="food">${t('o.catFood')}</option><option value="drink">${t('o.catDrink')}</option></select>
        <label><input type="checkbox" class="sold"> ${t('o.soldOut')}</label>
        <button type="button" class="del">${t('o.delete')}</button>
      </div>
      <div class="photo-actions">
        <button type="button" class="photo-change">${t('o.changePhoto')}</button>
        <button type="button" class="photo-remove danger-link">${t('o.removePhoto')}</button>
      </div>`;
    const q = (s) => row.querySelector(s);
    q('.name').value = item.name || '';
    q('.price').value = item.price ?? '';
    q('.desc').value = item.desc || '';
    q('.cat').value = item.category || 'food';
    q('.sold').checked = Boolean(item.soldOut);
    const setItemPhoto = (url) => {
      item.photo = url;
      showPhoto(q('.thumb'), url);
      q('.photo-actions').classList.toggle('hidden', !url);
    };
    setItemPhoto(item.photo || null);
    q('.name').addEventListener('input', (e) => { item.name = e.target.value; });
    q('.price').addEventListener('input', (e) => { item.price = e.target.value; });
    q('.desc').addEventListener('input', (e) => { item.desc = e.target.value; });
    q('.cat').addEventListener('change', (e) => { item.category = e.target.value; });
    q('.sold').addEventListener('change', (e) => { item.soldOut = e.target.checked; });
    q('.thumb').addEventListener('click', () => choosePhoto('item', setItemPhoto));
    q('.photo-change').addEventListener('click', () => choosePhoto('item', setItemPhoto));
    q('.photo-remove').addEventListener('click', () => {
      if (confirm(t('o.confirmRemovePhoto'))) setItemPhoto(null);
    });
    q('.del').addEventListener('click', () => {
      items.splice(idx, 1);
      renderItems();
    });
    box.appendChild(row);
  });
}

for (const btn of document.querySelectorAll('[data-add]')) {
  btn.addEventListener('click', () => {
    items.push({ name: '', price: '', desc: '', category: btn.dataset.add, photo: null, soldOut: false });
    renderItems();
    $('items').lastElementChild.querySelector('.name').focus();
  });
}

// ---------- Location sharing ----------

async function sendLocation(pos, force = false) {
  const now = Date.now();
  if (!force && lastSent && now - lastSent.at < SEND_EVERY_MS && distanceMeters(lastSent, pos) < SEND_MIN_METERS) return;
  lastSent = { ...pos, at: now };
  try {
    const data = await api(`/api/trucks/${creds.id}/location`, { token: creds.token, ...pos });
    truck = data.truck;
  } catch (err) {
    if (err.status === 409) setClosed(t('o.expiredShort'));
  }
}

function startSharing() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => sendLocation({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => setMsg('msg', t('o.gpsLost'), true),
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
  // A parked phone may not report new positions, so tell customers "still here" every minute.
  heartbeat = setInterval(() => {
    if (document.visibilityState === 'visible' && lastSent && Date.now() - lastSent.at >= HEARTBEAT_MS) {
      getPosition().then((pos) => sendLocation(pos, true)).catch(() => {});
    }
  }, 15000);
  requestWakeLock();
}

function stopSharing() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  clearInterval(heartbeat);
  heartbeat = null;
  lastSent = null;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// Keep the screen on so the browser keeps sending GPS.
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not critical */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && open) {
    requestWakeLock();
    getPosition().then((pos) => sendLocation(pos, true)).catch(() => {});
  }
});

function setClosed(message) {
  open = false;
  stopSharing();
  render();
  if (message) setMsg('msg', message);
}

// ---------- Actions ----------

let registerColor = COLORS[0];
let profileColor = COLORS[0];
makeSwatches($('swatches'), registerColor, (c) => { registerColor = c; });

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const data = await api('/api/trucks', { name: $('name').value, menu: $('menu').value, color: registerColor });
    saveCreds({ id: data.id, token: data.token });
    truck = data.truck;
    open = false;
    fillProfile();
    render();
    loadChats();
    setMsg('msg', t('o.created'));
  } catch (err) {
    setMsg('register-msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
});


$('restore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const [id, token] = $('restore-code').value.trim().split('.');
  if (!id || !token) return setMsg('register-msg', t('o.badCode'), true);
  saveCreds({ id, token });
  await loadTruck();
});

async function openShop(isExtend) {
  const btn = isExtend ? $('extend-btn') : $('open-btn');
  btn.disabled = true;
  setMsg('msg', t('o.locating'));
  try {
    const pos = await getPosition();
    const data = await api(`/api/trucks/${creds.id}/open`, {
      token: creds.token,
      durationMin: Number($('duration').value),
      ...pos,
    });
    truck = data.truck;
    clockSkew = data.now - Date.now();
    open = true;
    lastSent = { ...pos, at: Date.now() };
    startSharing();
    render();
    setMsg('msg', t(isExtend ? 'o.extended' : 'o.opened'));
  } catch (err) {
    setMsg('msg', err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('open-btn').addEventListener('click', () => openShop(false));
$('extend-btn').addEventListener('click', () => openShop(true));

$('close-btn').addEventListener('click', async () => {
  if (!confirm(t('o.confirmClose'))) return;
  $('close-btn').disabled = true;
  try {
    await api(`/api/trucks/${creds.id}/close`, { token: creds.token });
    setClosed(t('o.closedNow'));
  } catch (err) {
    setMsg('msg', err.message, true);
  } finally {
    $('close-btn').disabled = false;
  }
});

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api(`/api/trucks/${creds.id}/profile`, {
      token: creds.token,
      name: $('p-name').value,
      menu: $('p-menu').value,
      color: profileColor,
      photo: coverPhoto,
      items: items.map((i) => ({ ...i, price: Number(i.price) })),
    });
    truck = data.truck;
    fillProfile();
    render();
    setMsg('profile-msg', t(open ? 'o.savedLive' : 'o.saved'));
  } catch (err) {
    setMsg('profile-msg', err.message, true);
  }
});

$('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('code').value);
    $('copy-code').textContent = t('o.copied');
  } catch {
    $('code').select();
  }
});

$('logout').addEventListener('click', () => {
  if (!confirm(t('o.confirmLogout'))) return;
  stopSharing();
  ownerThread?.stop();
  ownerThread = null;
  saveCreds(null);
  truck = null;
  render();
});

// ---------- Customer messages ----------

let ownerThread = null;
let lastUnread = null;          // null until the first load, so old messages don't alert
const baseTitle = document.title;

// Tell the owner about new messages: tab title, vibration and (if allowed) a system notification.
function alertNewMessages(list, unread) {
  document.title = unread ? `(${unread}) ${baseTitle}` : baseTitle;
  if (lastUnread != null && unread > lastUnread) {
    const newest = list.filter((c) => c.unread).sort((a, b) => b.lastAt - a.lastAt)[0];
    navigator.vibrate?.([120, 60, 120]);
    if (newest && 'Notification' in window && Notification.permission === 'granted') {
      const body = t('o.notifyBody', { name: newest.guestName || t('chat.guest'), text: newest.last?.text || '' });
      const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'lampus-chat', renotify: true, data: { url: '/owner' } };
      navigator.serviceWorker?.ready
        .then((reg) => reg.showNotification(t('o.notifyTitle'), opts))
        .catch(() => { try { new Notification(t('o.notifyTitle'), opts); } catch { /* not supported */ } });
    }
  }
  lastUnread = unread;
}

function renderNotifyButton() {
  const show = 'Notification' in window && Notification.permission === 'default';
  $('notify-btn').classList.toggle('hidden', !show);
}

$('notify-btn').addEventListener('click', async () => {
  await Notification.requestPermission().catch(() => {});
  renderNotifyButton();
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadChats() {
  if (!creds || !truck) return;
  renderNotifyButton();
  let list;
  try {
    list = (await api(`/api/trucks/${creds.id}/chats`, { token: creds.token })).chats;
  } catch {
    return;
  }
  const unread = list.reduce((n, c) => n + c.unread, 0);
  alertNewMessages(list, unread);
  $('chats-count').textContent = unread;
  $('chats-count').classList.toggle('hidden', !unread);
  if (ownerThread) return; // keep the open conversation on screen
  $('chats').innerHTML = list.length ? list.map((c) => `
    <div class="mine-row">
      <button type="button" class="mine-main" data-owner-chat="${c.id}" data-name="${escapeHtml(c.guestName || t('chat.guest'))}">
        <span class="dot${c.unread ? ' unread' : ''}"></span>
        <span><b>${escapeHtml(c.guestName || t('chat.guest'))}</b><small>${escapeHtml(c.last?.text || '')}</small></span>
      </button>
      ${c.unread ? `<span class="count">${c.unread}</span>` : ''}
    </div>`).join('') : `<p class="sub" style="margin:0">${t('o.noChats')}</p>`;
}

$('chats').addEventListener('click', (e) => {
  const row = e.target.closest('[data-owner-chat]');
  if (!row) return;
  const back = () => { ownerThread = null; lastUnread = null; loadChats(); };
  $('chats').innerHTML = '<div class="owner-chat"></div>';
  ownerThread = ChatView($('chats').firstElementChild, {
    id: row.dataset.ownerChat,
    token: creds.token,
    role: 'owner',
    title: t('chat.with', { name: row.dataset.name }),
    onBack: back,
    onDelete: back,
    onGone: () => setTimeout(back, 1500),
  });
});

// Keep checking in a background tab too, so the owner hears about new messages.
setInterval(loadChats, 15000);

if (I18N.lang === 'en') $('privacy-link').href = '/privacy?lang=en';

// ---------- Boot ----------

async function loadTruck() {
  if (!creds) return render();
  try {
    const data = await api(`/api/trucks/${creds.id}/me`, { token: creds.token });
    truck = data.truck;
    open = data.open;
    clockSkew = data.now - Date.now();
    fillProfile();
    render();
    loadChats();
    if (open) {
      startSharing();
      setMsg('msg', t('o.resumed'));
    }
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      saveCreds(null);
      truck = null;
      render();
      setMsg('register-msg', t('o.notFound'), true);
    } else {
      setMsg('register-msg', t('o.offline'), true);
      $('register').classList.remove('hidden');
    }
  }
}

// Arrived by scanning a shop code QR: sign in with it, then drop it from the address bar.
function codeFromHash() {
  const m = location.hash.match(/^#code=([\w-]+)\.([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (creds && creds.id !== m[1] && !confirm(t('o.confirmSwitch'))) return;
  saveCreds({ id: m[1], token: m[2] });
}

codeFromHash();
loadTruck();
