'use strict';

// Mylampus — food truck fireflies.
// A zero-dependency Node server: REST API for owners, Server-Sent Events for the map.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIN_DURATION_MIN = 15;
const MAX_DURATION_MIN = 12 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const SWEEP_INTERVAL_MS = 5000;
const COLORS = ['#d4ff4f', '#ffd84f', '#ff9f4f', '#4fffb0', '#4fd8ff', '#ff6fd8'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
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
    lat: truck.lat,
    lng: truck.lng,
    openedAt: truck.openedAt,
    openUntil: truck.openUntil,
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return reject(new HttpError(400, 'body must be a JSON object'));
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
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

function createApp({ dataFile = path.join(__dirname, 'data', 'trucks.json'), publicDir = path.join(__dirname, 'public'), now = Date.now } = {}) {
  const store = new TruckStore(dataFile);
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
      store.save();
      if (isOpen(truck, now())) broadcast('update', publicView(truck));
      return { truck: publicView(truck) };
    }],

    // Light up (or extend) the firefly.
    ['POST', /^\/api\/trucks\/([\w-]+)\/open$/, async (req, id) => {
      const body = await readJson(req);
      const truck = authTruck(id, body);
      const { lat, lng } = cleanCoords(body);
      const minutes = cleanDuration(body.durationMin);
      const t = now();
      if (!isOpen(truck, t)) truck.openedAt = t;
      truck.lat = lat;
      truck.lng = lng;
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
      store.save();
      broadcast('update', publicView(truck));
      return { truck: publicView(truck) };
    }],

    ['POST', /^\/api\/trucks\/([\w-]+)\/close$/, async (req, id) => {
      const truck = authTruck(id, await readJson(req));
      closeTruck(truck, 'owner');
      return { ok: true };
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
    const file = path.normalize(path.join(publicDir, pathname));
    if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'not found');
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
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
  const { server } = createApp({ dataFile: process.env.DATA_FILE || undefined });
  server.listen(port, () => {
    console.log(`🪲 Mylampus fireflies on http://localhost:${port}  (owner: /owner)`);
  });
}
