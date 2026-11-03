'use strict';

// Owner page: register a truck, light up its firefly, share GPS while open.

const COLORS = ['#d4ff4f', '#ffd84f', '#ff9f4f', '#4fffb0', '#4fd8ff', '#ff6fd8'];
const STORAGE_KEY = 'mylampus.owner';
const SEND_EVERY_MS = 15000;   // at most one location update per 15 s…
const SEND_MIN_METERS = 20;    // …unless the truck moved further than this
const HEARTBEAT_MS = 60000;    // confirm the position at least this often, even when parked

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
    const err = new Error(data.error || `HTTP ${res.status}`);
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
  coverPhoto = truck.photo || null;
  showPhoto($('p-cover'), coverPhoto);
  items = (truck.items || []).map((i) => ({ ...i }));
  renderItems();
  $('code').value = `${creds.id}.${creds.token}`;
  const shopUrl = `${location.origin}/t/${creds.id}`;
  $('shop-url').value = shopUrl;
  $('view-shop').href = shopUrl;
}

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

function showPhoto(el, url) {
  el.style.backgroundImage = url ? `url("${url}")` : '';
  el.classList.toggle('has-photo', Boolean(url));
}

// Shrink to at most 1024 px and re-encode as JPEG so uploads stay small.
async function resizeImage(file, max = 1024) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(t('o.badImage')));
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

async function uploadImage(file) {
  const blob = await resizeImage(file);
  const res = await fetch(`/api/trucks/${creds.id}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Token': creds.token },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.url;
}

function choosePhoto(onUrl) {
  pickPhoto = onUrl;
  $('file').value = '';
  $('file').click();
}

$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file || !pickPhoto) return;
  const done = pickPhoto;
  pickPhoto = null;
  setMsg('profile-msg', t('o.uploading'));
  try {
    done(await uploadImage(file));
    setMsg('profile-msg', t('o.uploaded'));
  } catch (err) {
    setMsg('profile-msg', err.message, true);
  }
});

$('p-cover').addEventListener('click', () => {
  if (coverPhoto && confirm(t('o.removeCover'))) {
    coverPhoto = null;
    showPhoto($('p-cover'), null);
    return;
  }
  choosePhoto((url) => { coverPhoto = url; showPhoto($('p-cover'), url); });
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
      </div>`;
    const q = (s) => row.querySelector(s);
    q('.name').value = item.name || '';
    q('.price').value = item.price ?? '';
    q('.desc').value = item.desc || '';
    q('.cat').value = item.category || 'food';
    q('.sold').checked = Boolean(item.soldOut);
    showPhoto(q('.thumb'), item.photo);
    q('.name').addEventListener('input', (e) => { item.name = e.target.value; });
    q('.price').addEventListener('input', (e) => { item.price = e.target.value; });
    q('.desc').addEventListener('input', (e) => { item.desc = e.target.value; });
    q('.cat').addEventListener('change', (e) => { item.category = e.target.value; });
    q('.sold').addEventListener('change', (e) => { item.soldOut = e.target.checked; });
    q('.thumb').addEventListener('click', () => {
      if (item.photo && confirm(t('o.removeItemPhoto'))) {
        item.photo = null;
        showPhoto(q('.thumb'), null);
        return;
      }
      choosePhoto((url) => { item.photo = url; showPhoto(q('.thumb'), url); });
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadChats() {
  if (!creds || !truck || ownerThread) return;
  let list;
  try {
    list = (await api(`/api/trucks/${creds.id}/chats`, { token: creds.token })).chats;
  } catch {
    return;
  }
  if (ownerThread) return;
  const unread = list.reduce((n, c) => n + c.unread, 0);
  $('chats-count').textContent = unread;
  $('chats-count').classList.toggle('hidden', !unread);
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
  const back = () => { ownerThread = null; loadChats(); };
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

setInterval(() => { if (document.visibilityState === 'visible') loadChats(); }, 20000);

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

loadTruck();
