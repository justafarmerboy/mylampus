'use strict';

// LAMPUS — food truck fireflies.
// A zero-dependency Node server: REST API for owners, Server-Sent Events for the map.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const seo = require('./seo');

const MIN_DURATION_MIN = 15;
const MAX_DURATION_MIN = 60;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 50;
const MAX_UPLOADS_PER_TRUCK = 80;
const CATEGORIES = ['food', 'drink'];
const FEEDBACK_KINDS = ['idea', 'bug', 'other'];
const MAX_FEEDBACK = 2000;               // oldest messages are dropped beyond this
const FEEDBACK_PER_IP = 5;               // at most this many messages…
const FEEDBACK_WINDOW_MS = 10 * 60 * 1000; // …per IP in this window
const MAX_CHAT_TEXT = 500;
const MAX_CHAT_MESSAGES = 200;           // per chat; oldest dropped
const MAX_CHATS_PER_TRUCK = 300;         // least recently active dropped
const CHAT_MSGS_PER_MIN = 10;            // per chat, customer side
const NEW_CHATS_PER_IP_HOUR = 10;
const UPLOAD_URL = /^\/uploads\/([a-f0-9]{24}\.(?:jpg|png|webp))$/;
const SWEEP_INTERVAL_MS = 5000;
const COLORS = ['#d4ff4f', '#ffd84f', '#ff9f4f', '#4fffb0', '#4fd8ff', '#ff6fd8'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Store: trucks kept in memory, persisted to a JSON file.
// ---------------------------------------------------------------------------

class TruckStore {
  constructor(file) {
    this.file = file;
    this.trucks = new Map();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of list) this.trucks.set(t.id, t);
    } catch (err) {
      console.error(`Could not read ${this.file}:`, err.message);
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.trucks.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(id) {
    return this.trucks.get(id);
  }

  add(truck) {
    this.trucks.set(truck.id, truck);
    this.save();
  }

  all() {
    return [...this.trucks.values()];
  }
}

// Private customer <-> truck conversations. Customers get an anonymous token per chat.
class ChatStore {
  constructor(file) {
    this.file = file;
    this.chats = new Map();
    if (file && fs.existsSync(file)) {
      try {
        for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))) this.chats.set(c.id, c);
      } catch (err) {
        console.error(`Could not read ${file}:`, err.message);
      }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.chats.values()]));
    fs.renameSync(tmp, this.file);
  }

  forTruck(truckId) {
    return [...this.chats.values()].filter((c) => c.truckId === truckId);
  }
}

// Messages the other side has written since this side last read the chat.
function unreadFor(chat, role) {
  const readAt = role === 'owner' ? chat.ownerReadN : chat.guestReadN;
  return chat.messages.filter((m) => m.from !== role && m.n > readAt).length;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Feedback messages to the app's creator, newest first, in their own JSON file.
class FeedbackStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    if (file && fs.existsSync(file)) {
      try {
        this.items = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        console.error(`Could not read ${file}:`, err.message);
      }
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.file);
  }

  add(item) {
    this.items.unshift(item);
    this.items.length = Math.min(this.items.length, MAX_FEEDBACK);
    this.save();
  }
}

function secretMatches(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || '';
}

function tokenMatches(truck, token) {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(truck.tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isOpen(truck, now = Date.now()) {
  return Boolean(truck.openUntil && truck.openUntil > now && truck.lat != null);
}

// Fields anyone on the map may see.
function publicView(truck) {
  return {
    id: truck.id,
    name: truck.name,
    menu: truck.menu,
    color: truck.color,
    photo: truck.photo || null,
    items: truck.items || [],
    lat: truck.lat,
    lng: truck.lng,
    openedAt: truck.openedAt,
    openUntil: truck.openUntil,
    // When the owner's phone last reported its position (older trucks: fall back to opening time).
    locatedAt: truck.locatedAt || truck.openedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function cleanText(value, field, maxLen, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (required && !text) throw new HttpError(400, `${field} is required`);
  if (text.length > maxLen) throw new HttpError(400, `${field} is too long (max ${maxLen})`);
  return text;
}

function cleanPhoto(value, truck) {
  if (value == null || value === '') return null;
  const match = typeof value === 'string' && value.match(UPLOAD_URL);
  if (!match || !(truck.uploads || []).includes(match[1])) throw new HttpError(400, 'invalid photo');
  return value;
}

function cleanItems(value, truck) {
  if (!Array.isArray(value)) throw new HttpError(400, 'items must be a list');
  if (value.length > MAX_ITEMS) throw new HttpError(400, `at most ${MAX_ITEMS} menu items`);
  return value.map((item, i) => {
    if (!item || typeof item !== 'object') throw new HttpError(400, `item ${i + 1} is invalid`);
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError(400, `item ${i + 1}: invalid price`);
    return {
      id: typeof item.id === 'string' && /^[\w-]{1,24}$/.test(item.id) ? item.id : crypto.randomBytes(4).toString('hex'),
      name: cleanText(item.name, `item ${i + 1} name`, 60, { required: true }),
      desc: cleanText(item.desc, `item ${i + 1} description`, 120),
      price: Math.round(price * 100) / 100,
      category: CATEGORIES.includes(item.category) ? item.category : 'food',
      photo: cleanPhoto(item.photo, truck),
      soldOut: Boolean(item.soldOut),
    };
  });
}

// Accept only real JPEG / PNG / WebP data (checked by magic bytes).
function imageExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function cleanCoords(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new HttpError(400, 'invalid lat');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new HttpError(400, 'invalid lng');
  return { lat, lng };
}

function cleanDuration(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_DURATION_MIN || minutes > MAX_DURATION_MIN) {
    throw new HttpError(400, `durationMin must be an integer between ${MIN_DURATION_MIN} and ${MAX_DURATION_MIN}`);
  }
  return minutes;
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req, MAX_BODY_BYTES);
  if (!raw.length) return {};
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  return body;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp({
  dataFile = path.join(__dirname, 'data', 'trucks.json'),
  publicDir = path.join(__dirname, 'public'),
  uploadsDir = path.join(path.dirname(dataFile), 'uploads'),
  feedbackFile = path.join(path.dirname(dataFile), 'feedback.json'),
  chatsFile = path.join(path.dirname(dataFile), 'chats.json'),
  adminKey = process.env.ADMIN_KEY,
  siteUrl = (process.env.SITE_URL || 'https://lampus.app').replace(/\/$/, ''),
  now = Date.now,
} = {}) {
  const store = new TruckStore(dataFile);
  const feedback = new FeedbackStore(feedbackFile);
  const feedbackHits = new Map(); // ip -> recent timestamps
  const chats = new ChatStore(chatsFile);
  const chatHits = new Map();     // ip -> recent chat creations; chat id -> recent customer messages

  // Sliding-window limiter shared by feedback-style endpoints.
  function limit(map, key, max, windowMs, message) {
    const t = now();
    const recent = (map.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= max) throw new HttpError(429, message);
    map.set(key, [...recent, t]);
  }

  function chatRole(chat, token) {
    if (typeof token !== 'string' || !token) return null;
    const a = Buffer.from(hashToken(token), 'hex');
    const b = Buffer.from(chat.guestTokenHash, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'guest';
    const truck = store.get(chat.truckId);
    return truck && tokenMatches(truck, token) ? 'owner' : null;
  }

  function authChat(id, token) {
    const chat = chats.chats.get(id);
    if (!chat) throw new HttpError(404, 'chat not found');
    const role = chatRole(chat, token);
    if (!role) throw new HttpError(403, 'wrong token');
    return { chat, role };
  }

  function chatSummary(chat, role) {
    const last = chat.messages[chat.messages.length - 1] || null;
    return {
      id: chat.id,
      truckId: chat.truckId,
      truckName: store.get(chat.truckId)?.name || null,
      guestName: chat.guestName,
      lastAt: chat.lastAt,
      last: last && { from: last.from, text: last.text, at: last.at },
      unread: unreadFor(chat, role),
    };
  }

  function authAdmin(body) {
    if (!adminKey) throw new HttpError(503, 'admin is not set up (ADMIN_KEY missing)');
    if (!secretMatches(adminKey, body.key)) throw new HttpError(403, 'wrong admin key');
  }
  const clients = new Set();

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function closeTruck(truck, reason) {
    const wasOpen = truck.openUntil != null;
    truck.openUntil = null;
    truck.openedAt = null;
    store.save();
    if (wasOpen) broadcast('closed', { id: truck.id, reason });
  }

  // Turn off fireflies whose time is up.
  function sweep() {
    const t = now();
    for (const truck of store.all()) {
      if (truck.openUntil && truck.openUntil <= t) closeTruck(truck, 'expired');
    }
  }

  // Delete this truck's uploaded images that are no longer used anywhere.
  function pruneUploads(truck) {
    const used = new Set([truck.photo, ...(truck.items || []).map((i) => i.photo)]
      .filter(Boolean).map((url) => url.match(UPLOAD_URL)[1]));
    for (const name of truck.uploads || []) {
      if (!used.has(name)) fs.rm(path.join(uploadsDir, name), { force: true }, () => {});
    }
    truck.uploads = [...used];
  }

  function authTruck(id, body) {
    const truck = store.get(id);
    if (!truck) throw new HttpError(404, 'truck not found');
    if (!tokenMatches(truck, body.token)) throw new HttpError(403, 'wrong token');
    return truck;
  }

  const routes = [
    ['GET', /^\/api\/trucks$/, () => {
      sweep();
      return { trucks: store.all().filter((t) => isOpen(t, now())).map(publicView), now: now() };
    }],

    ['POST', /^\/api\/trucks$/, async (req) => {
      const body = await readJson(req);
      const name = cleanText(body.name, 'name', 60, { required: true });
      const menu = cleanText(body.menu, 'menu', 200);
      const color = COLORS.includes(body.color) ? body.color : COLORS[store.trucks.size % COLORS.length];
      const token = crypto.randomBytes(24).toString('base64url');
      const truck = {
        id: crypto.randomBytes(6).toString('hex'),
        tokenHash: hashToken(token),
        name,
        menu,
        color,
        lat: null,
        lng: null,
        openedAt: null,
        openUntil: null,
        createdAt: now(),
      };
      store.add(truck);
      return [201, { id: truck.id, token, truck: publicView(truck) }];
    }],

    // Owner reads their own truck (open or not).
    ['POST', /^\/api\/trucks\/([\w-]+)\/me$/, async (req, id) => {
      const truck = authTruck(id, await readJson(req));
      sweep();
      return { truck: publicView(truck), open: isOpen(truck, now()), now: now() };
    }],

    ['POST', /^\/api\/trucks\/([\w-]+)\/profile$/, async (req, id) => {
      const body = await readJson(req);
      const truck = authTruck(id, body);
      if (body.name !== undefined) truck.name = cleanText(body.name, 'name', 60, { required: true });
      if (body.menu !== undefined) truck.menu = cleanText(body.menu, 'menu', 200);
      if (body.color !== undefined && COLORS.includes(body.color)) truck.color = body.color;
      if (body.photo !== undefined) truck.photo = cleanPhoto(body.photo, truck);
      if (body.items !== undefined) truck.items = cleanItems(body.items, truck);
      pruneUploads(truck);
      store.save();
      if (isOpen(truck, now())) broadcast('update', publicView(truck));
      return { truck: publicView(truck) };
    }],

    // Raw image body; token in the X-Token header. Returns a URL to use as a photo.
    ['POST', /^\/api\/trucks\/([\w-]+)\/upload$/, async (req, id) => {
      const truck = authTruck(id, { token: req.headers['x-token'] });
      truck.uploads = truck.uploads || [];
      if (truck.uploads.length >= MAX_UPLOADS_PER_TRUCK) throw new HttpError(429, 'too many images, save your menu first');
      const buf = await readRaw(req, MAX_IMAGE_BYTES);
      const ext = imageExt(buf);
      if (!ext) throw new HttpError(415, 'only JPEG, PNG or WebP images');
      const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
      await fs.promises.mkdir(uploadsDir, { recursive: true });
      await fs.promises.writeFile(path.join(uploadsDir, name), buf);
      truck.uploads.push(name);
      store.save();
      return [201, { url: `/uploads/${name}` }];
    }],

    // Light up (or extend) the firefly.
    ['POST', /^\/api\/trucks\/([\w-]+)\/open$/, async (req, id) => {
      const body = await readJson(req);
      const truck = authTruck(id, body);
      const { lat, lng } = cleanCoords(body);
      const minutes = cleanDuration(body.durationMin);
      const t = now();
      if (!isOpen(truck, t)) truck.openedAt = t;
      truck.lastOpenedAt = t; // kept after closing, for the shop page and sitemap
      truck.lat = lat;
      truck.lng = lng;
      truck.locatedAt = t;
      truck.openUntil = t + minutes * 60 * 1000;
      store.save();
      broadcast('update', publicView(truck));
      return { truck: publicView(truck), now: t };
    }],

    ['POST', /^\/api\/trucks\/([\w-]+)\/location$/, async (req, id) => {
      const body = await readJson(req);
      const truck = authTruck(id, body);
      if (!isOpen(truck, now())) throw new HttpError(409, 'truck is closed');
      const { lat, lng } = cleanCoords(body);
      truck.lat = lat;
      truck.lng = lng;
      truck.locatedAt = now();
      store.save();
      broadcast('update', publicView(truck));
      return { truck: publicView(truck) };
    }],

    ['POST', /^\/api\/trucks\/([\w-]+)\/close$/, async (req, id) => {
      const truck = authTruck(id, await readJson(req));
      closeTruck(truck, 'owner');
      return { ok: true };
    }],

    // Anyone can send feedback to the creator; rate-limited per IP.
    ['POST', /^\/api\/feedback$/, async (req) => {
      const body = await readJson(req);
      const message = cleanText(body.message, 'message', 1000, { required: true });
      const t = now();
      const ip = clientIp(req);
      const recent = (feedbackHits.get(ip) || []).filter((at) => t - at < FEEDBACK_WINDOW_MS);
      if (recent.length >= FEEDBACK_PER_IP) throw new HttpError(429, 'too many messages, try again later');
      feedbackHits.set(ip, [...recent, t]);
      const truckId = typeof body.truckId === 'string' && store.get(body.truckId) ? body.truckId : null;
      feedback.add({
        id: crypto.randomBytes(6).toString('hex'),
        kind: FEEDBACK_KINDS.includes(body.kind) ? body.kind : 'other',
        message,
        contact: cleanText(body.contact, 'contact', 120),
        from: body.from === 'owner' ? 'owner' : 'customer',
        truckId,
        truckName: truckId ? store.get(truckId).name : null,
        createdAt: t,
        done: false,
      });
      return [201, { ok: true }];
    }],

    ['POST', /^\/api\/admin\/feedback$/, async (req) => {
      authAdmin(await readJson(req));
      return { feedback: feedback.items };
    }],

    ['POST', /^\/api\/admin\/feedback\/([\w-]+)\/(done|delete)$/, async (req, id, action) => {
      const body = await readJson(req);
      authAdmin(body);
      const idx = feedback.items.findIndex((f) => f.id === id);
      if (idx < 0) throw new HttpError(404, 'feedback not found');
      if (action === 'delete') feedback.items.splice(idx, 1);
      else feedback.items[idx].done = body.done !== false;
      feedback.save();
      return { ok: true };
    }],

    // A customer starts a private chat with a truck.
    ['POST', /^\/api\/chats$/, async (req) => {
      const body = await readJson(req);
      const truck = store.get(body.truckId);
      if (!truck) throw new HttpError(404, 'truck not found');
      limit(chatHits, `ip:${clientIp(req)}`, NEW_CHATS_PER_IP_HOUR, 60 * 60 * 1000, 'too many new chats, try again later');
      const mine = chats.forTruck(truck.id).sort((a, b) => a.lastAt - b.lastAt);
      while (mine.length >= MAX_CHATS_PER_TRUCK) chats.chats.delete(mine.shift().id);
      const token = crypto.randomBytes(24).toString('base64url');
      const chat = {
        id: crypto.randomBytes(8).toString('hex'),
        truckId: truck.id,
        guestTokenHash: hashToken(token),
        guestName: cleanText(body.guestName, 'guestName', 30),
        createdAt: now(),
        lastAt: now(),
        seq: 0,
        messages: [],
        ownerReadN: 0,
        guestReadN: 0,
      };
      chats.chats.set(chat.id, chat);
      chats.save();
      return [201, { id: chat.id, token, truckName: truck.name }];
    }],

    // Read a chat (either side). `since` returns only newer messages; reading marks them read.
    ['POST', /^\/api\/chats\/([\w-]+)$/, async (req, id) => {
      const body = await readJson(req);
      const { chat, role } = authChat(id, body.token);
      const since = Number(body.since) || 0;
      const lastN = chat.messages.length ? chat.messages[chat.messages.length - 1].n : 0;
      const key = role === 'owner' ? 'ownerReadN' : 'guestReadN';
      if (chat[key] !== lastN) {
        chat[key] = lastN;
        chats.save();
      }
      return { role, chat: chatSummary(chat, role), messages: chat.messages.filter((m) => m.n > since) };
    }],

    ['POST', /^\/api\/chats\/([\w-]+)\/send$/, async (req, id) => {
      const body = await readJson(req);
      const { chat, role } = authChat(id, body.token);
      const text = cleanText(body.text, 'text', MAX_CHAT_TEXT, { required: true });
      if (role === 'guest') limit(chatHits, `chat:${chat.id}`, CHAT_MSGS_PER_MIN, 60 * 1000, 'too many messages, slow down');
      const message = { n: ++chat.seq, from: role, text, at: now() };
      chat.messages.push(message);
      if (chat.messages.length > MAX_CHAT_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_CHAT_MESSAGES);
      chat.lastAt = message.at;
      chat[role === 'owner' ? 'ownerReadN' : 'guestReadN'] = message.n;
      chats.save();
      return [201, { message }];
    }],

    ['POST', /^\/api\/chats\/([\w-]+)\/delete$/, async (req, id) => {
      const { chat, role } = authChat(id, (await readJson(req)).token);
      if (role !== 'owner') throw new HttpError(403, 'only the truck can delete a chat');
      chats.chats.delete(chat.id);
      chats.save();
      return { ok: true };
    }],

    // Customer: status of the chats saved on this device ({ id, token } pairs).
    ['POST', /^\/api\/chats-summary$/, async (req) => {
      const body = await readJson(req);
      if (!Array.isArray(body.chats) || body.chats.length > 50) throw new HttpError(400, 'chats must be a list (max 50)');
      return {
        chats: body.chats.map(({ id, token } = {}) => {
          const chat = chats.chats.get(id);
          return chat && chatRole(chat, token) === 'guest' ? chatSummary(chat, 'guest') : { id, gone: true };
        }),
      };
    }],

    // Owner: all chats for the truck, most recent first.
    ['POST', /^\/api\/trucks\/([\w-]+)\/chats$/, async (req, id) => {
      const truck = authTruck(id, await readJson(req));
      const list = chats.forTruck(truck.id).filter((c) => c.messages.length).sort((a, b) => b.lastAt - a.lastAt);
      return { chats: list.map((c) => chatSummary(c, 'owner')) };
    }],

    ['GET', /^\/api\/events$/, (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sweep();
      const snapshot = { trucks: store.all().filter((t) => isOpen(t, now())).map(publicView), now: now() };
      res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return null; // response stays open
    }],
  ];

  function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/owner') pathname = '/owner.html';
    if (pathname === '/admin') pathname = '/admin.html';
    const upload = pathname.match(UPLOAD_URL);
    const file = upload ? path.join(uploadsDir, upload[1]) : path.normalize(path.join(publicDir, pathname));
    if (!upload && !file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'not found');
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        // Uploaded file names are random and never reused, so they can be cached for good.
        'Cache-Control': upload ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // Server-rendered pages for search engines and link previews.
  function servePage(req, res, pathname) {
    let body;
    let type = 'text/html; charset=utf-8';
    const shop = pathname.match(/^\/t\/([\w-]+)$/);
    if (shop) {
      const truck = store.get(shop[1]);
      if (!truck) {
        const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LAMPUS</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/firefly.css"><main class="owner"><h1>✦ LAMPUS</h1><p class="sub">ไม่พบร้านนี้ · Shop not found</p><a class="btn" href="/">แผนที่ · Map →</a></main>';
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return true;
      }
      sweep();
      const lang = new URL(req.url, 'http://localhost').searchParams.get('lang') === 'en' ? 'en' : 'th';
      body = seo.renderShopPage({ site: siteUrl, truck, lang, open: isOpen(truck, now()), now: now() });
    } else if (pathname === '/sitemap.xml') {
      body = seo.sitemap({ site: siteUrl, trucks: store.all(), now: now() });
      type = 'application/xml; charset=utf-8';
    } else if (pathname === '/robots.txt') {
      body = seo.robots({ site: siteUrl });
      type = 'text/plain; charset=utf-8';
    } else {
      return false;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  async function handler(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) {
        for (const [method, pattern, fn] of routes) {
          const match = pathname.match(pattern);
          if (!match) continue;
          if (req.method !== method) continue;
          const result = await fn(req, ...(method === 'GET' ? [res] : match.slice(1)));
          if (result === null) return;
          const [status, data] = Array.isArray(result) ? result : [200, result];
          return sendJson(res, status, data);
        }
        throw new HttpError(404, 'no such endpoint');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (servePage(req, res, pathname)) return;
      serveStatic(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal error' : err.message });
      else res.end();
    }
  }

  const server = http.createServer(handler);
  const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweeper.unref();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();
  // Stop timers, end live streams and shut the server down.
  function close() {
    clearInterval(sweeper);
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  return { server, store, sweep, close };
}

module.exports = { createApp, COLORS, MIN_DURATION_MIN, MAX_DURATION_MIN };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, close } = createApp({ dataFile: process.env.DATA_FILE || undefined });
  server.listen(port, () => {
    console.log(`🪲 LAMPUS fireflies on http://localhost:${port}  (owner: /owner)`);
  });
  // Railway stops the old server on every deploy: finish cleanly instead of being killed mid-write.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      console.log(`${signal} received, shutting down`);
      close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
