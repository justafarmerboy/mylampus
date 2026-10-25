/* global L */
'use strict';

// Customer map: every open food truck is a firefly drifting around its real position.

const WANDER_PX = 28;          // how far a firefly drifts from its true spot
const DIM_START_MIN = 30;      // starts dimming this many minutes before closing
const MIN_ENERGY = 0.3;

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([13.7563, 100.5018], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

const fireflies = new Map(); // id -> { truck, marker, el, seed, cur, target }
let clockSkew = 0;           // serverNow - clientNow
let firstFit = true;

const serverNow = () => Date.now() + clockSkew;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatLeft(ms) {
  if (ms <= 0) return 'กำลังจะปิด';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `อีก ${min} นาที`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `อีก ${h} ชม. ${m} นาที` : `อีก ${h} ชม.`;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function energyFor(truck) {
  const leftMin = (truck.openUntil - serverNow()) / 60000;
  if (leftMin >= DIM_START_MIN) return 1;
  return Math.max(MIN_ENERGY, MIN_ENERGY + (1 - MIN_ENERGY) * (leftMin / DIM_START_MIN));
}

function popupHtml(truck) {
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${truck.lat},${truck.lng}`;
  return `<div class="truck-pop" style="--c:${truck.color}">
    <h3>${escapeHtml(truck.name)}</h3>
    ${truck.menu ? `<p>${escapeHtml(truck.menu)}</p>` : ''}
    <p>เปิดถึง ${formatClock(truck.openUntil)} · <span class="left" data-left="${truck.id}">${formatLeft(truck.openUntil - serverNow())}</span></p>
    <a class="nav" href="${nav}" target="_blank" rel="noopener">นำทางไปที่ร้าน →</a>
  </div>`;
}

function fireflyHtml(truck, seed) {
  return `<div class="firefly igniting" style="--c:${truck.color};--pulse:${(1.8 + seed.p * 1.4).toFixed(2)}s;--delay:-${(seed.p * 2).toFixed(2)}s">
    <div class="glow-wrap"><div class="halo"></div></div>
    <div class="bug">
      <div class="wing l"></div><div class="wing r"></div>
      <div class="head"></div>
      <div class="glow-wrap"><div class="tail"></div></div>
    </div>
    <div class="label">${escapeHtml(truck.name)}</div>
  </div>`;
}

function upsert(truck) {
  const existing = fireflies.get(truck.id);
  if (existing && !existing.dying) {
    existing.truck = truck;
    existing.target = [truck.lat, truck.lng];
    existing.marker.setPopupContent(popupHtml(truck));
    existing.el.querySelector('.label').textContent = truck.name;
    existing.el.style.setProperty('--c', truck.color);
    return;
  }
  if (existing) removeNow(truck.id);

  // Each firefly gets its own flight pattern.
  const seed = {
    p: Math.random(),
    f1: 0.00035 + Math.random() * 0.0003,
    f2: 0.0009 + Math.random() * 0.0006,
    f3: 0.0002 + Math.random() * 0.0002,
    o1: Math.random() * Math.PI * 2,
    o2: Math.random() * Math.PI * 2,
    o3: Math.random() * Math.PI * 2,
  };
  const icon = L.divIcon({ className: 'firefly-icon', html: fireflyHtml(truck, seed), iconSize: [0, 0] });
  const marker = L.marker([truck.lat, truck.lng], { icon, keyboard: true, title: truck.name, riseOnHover: true })
    .bindPopup(popupHtml(truck), { offset: [0, -10] })
    .addTo(map);
  const el = marker.getElement().querySelector('.firefly');
  el.addEventListener('animationend', () => el.classList.remove('igniting'), { once: true });
  fireflies.set(truck.id, { truck, marker, el, seed, cur: [truck.lat, truck.lng], target: [truck.lat, truck.lng], prev: null });
}

function extinguish(id) {
  const ff = fireflies.get(id);
  if (!ff || ff.dying) return;
  ff.dying = true;
  ff.marker.closePopup();
  ff.el.classList.add('dying');
  setTimeout(() => removeNow(id), 2300);
  updateCounter();
}

function removeNow(id) {
  const ff = fireflies.get(id);
  if (!ff) return;
  map.removeLayer(ff.marker);
  fireflies.delete(id);
}

function updateCounter() {
  const n = [...fireflies.values()].filter((f) => !f.dying).length;
  document.getElementById('counter').innerHTML = n
    ? `✦ มีหิ่งห้อย <b>${n}</b> ตัวกำลังบินอยู่`
    : 'ยังไม่มีหิ่งห้อยตอนนี้ — แวะมาใหม่นะ';
}

// ---------- Flight loop ----------

function frame(t) {
  for (const ff of fireflies.values()) {
    // Glide toward the latest real position when the truck moves.
    ff.cur[0] += (ff.target[0] - ff.cur[0]) * 0.04;
    ff.cur[1] += (ff.target[1] - ff.cur[1]) * 0.04;
    if (Math.abs(ff.target[0] - ff.cur[0]) > 1e-7 || Math.abs(ff.target[1] - ff.cur[1]) > 1e-7) {
      ff.marker.setLatLng(ff.cur);
    }

    // Lissajous-like wandering around the true spot.
    const s = ff.seed;
    const x = WANDER_PX * (0.65 * Math.sin(t * s.f1 + s.o1) + 0.35 * Math.sin(t * s.f2 + s.o2));
    const y = WANDER_PX * (0.6 * Math.cos(t * s.f1 * 1.3 + s.o3) + 0.4 * Math.sin(t * s.f3 + s.o2)) - 6 * Math.abs(Math.sin(t * s.f2 * 2));
    if (ff.prev) {
      const dx = x - ff.prev[0];
      const dy = y - ff.prev[1];
      if (dx * dx + dy * dy > 0.0004) {
        const heading = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        ff.el.style.setProperty('--heading', `${heading.toFixed(1)}deg`);
      }
    }
    ff.prev = [x, y];
    ff.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Clock: dim near closing, extinguish on expiry ----------

setInterval(() => {
  for (const ff of fireflies.values()) {
    if (ff.dying) continue;
    if (ff.truck.openUntil <= serverNow()) {
      extinguish(ff.truck.id);
      continue;
    }
    ff.el.style.setProperty('--energy', energyFor(ff.truck).toFixed(2));
    const left = document.querySelector(`[data-left="${ff.truck.id}"]`);
    if (left) left.textContent = formatLeft(ff.truck.openUntil - serverNow());
  }
}, 1000);

// ---------- Live updates ----------

function applySnapshot(data) {
  clockSkew = data.now - Date.now();
  const ids = new Set(data.trucks.map((t) => t.id));
  for (const id of fireflies.keys()) if (!ids.has(id)) extinguish(id);
  for (const t of data.trucks) upsert(t);
  updateCounter();
  if (firstFit && data.trucks.length) {
    firstFit = false;
    map.fitBounds(L.latLngBounds(data.trucks.map((t) => [t.lat, t.lng])).pad(0.4), { maxZoom: 16 });
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => applySnapshot(JSON.parse(e.data)));
  es.addEventListener('update', (e) => {
    upsert(JSON.parse(e.data));
    updateCounter();
  });
  es.addEventListener('closed', (e) => extinguish(JSON.parse(e.data).id));
  es.onerror = () => {
    document.getElementById('counter').textContent = 'กำลังเชื่อมต่อใหม่…';
  };
}
connect();

// ---------- My location ----------

let meMarker = null;
document.getElementById('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (meMarker) meMarker.setLatLng(ll);
      else meMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#4fa3ff', fillOpacity: 1 }).addTo(map);
      map.setView(ll, 16);
      firstFit = false;
    },
    () => alert('ไม่สามารถหาตำแหน่งของคุณได้'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});
