'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mylampus-'));
  const app = createApp({ dataFile: path.join(dir, 'trucks.json'), ...opts });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };
  return { ...app, base, post, get, dir, stop: app.close };
}

const BKK = { lat: 13.7563, lng: 100.5018 };

test('register, open, move, close lifecycle', async (t) => {
  const app = await start();
  t.after(app.stop);

  const reg = await app.post('/api/trucks', { name: '  ข้าวมันไก่  ', menu: 'ไก่ต้ม', color: '#4fd8ff' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.truck.name, 'ข้าวมันไก่');
  assert.ok(reg.body.token);
  const { id, token } = reg.body;

  assert.deepEqual((await app.get('/api/trucks')).body.trucks, [], 'not visible before opening');

  const opened = await app.post(`/api/trucks/${id}/open`, { token, durationMin: 60, ...BKK });
  assert.equal(opened.status, 200);
  let list = (await app.get('/api/trucks')).body.trucks;
  assert.equal(list.length, 1);
  assert.equal(list[0].lat, BKK.lat);
  assert.equal(list[0].tokenHash, undefined, 'secrets never leak');

  const moved = await app.post(`/api/trucks/${id}/location`, { token, lat: 13.76, lng: 100.51 });
  assert.equal(moved.status, 200);
  assert.equal((await app.get('/api/trucks')).body.trucks[0].lat, 13.76);

  assert.equal((await app.post(`/api/trucks/${id}/close`, { token })).status, 200);
  list = (await app.get('/api/trucks')).body.trucks;
  assert.equal(list.length, 0);
  assert.equal((await app.post(`/api/trucks/${id}/location`, { token, ...BKK })).status, 409);
});

test('rejects wrong token and bad input', async (t) => {
  const app = await start();
  t.after(app.stop);
  const { id, token } = (await app.post('/api/trucks', { name: 'A' })).body;

  assert.equal((await app.post(`/api/trucks/${id}/open`, { token: 'nope', durationMin: 60, ...BKK })).status, 403);
  assert.equal((await app.post('/api/trucks/missing/open', { token, durationMin: 60, ...BKK })).status, 404);
  assert.equal((await app.post(`/api/trucks/${id}/open`, { token, durationMin: 5, ...BKK })).status, 400);
  assert.equal((await app.post(`/api/trucks/${id}/open`, { token, durationMin: 61, ...BKK })).status, 400, 'max 1 hour');
  assert.equal((await app.post(`/api/trucks/${id}/open`, { token, durationMin: 60, lat: 200, lng: 0 })).status, 400);
  assert.equal((await app.post('/api/trucks', { name: '' })).status, 400);
});

test('firefly goes dark when time runs out', async (t) => {
  let clock = 1_000_000;
  const app = await start({ now: () => clock });
  t.after(app.stop);
  const { id, token } = (await app.post('/api/trucks', { name: 'B' })).body;
  await app.post(`/api/trucks/${id}/open`, { token, durationMin: 30, ...BKK });
  assert.equal((await app.get('/api/trucks')).body.trucks.length, 1);

  clock += 30 * 60 * 1000;
  assert.equal((await app.get('/api/trucks')).body.trucks.length, 0);
  const me = await app.post(`/api/trucks/${id}/me`, { token });
  assert.equal(me.body.open, false);
});

test('event stream announces open and close', async (t) => {
  const app = await start();
  t.after(app.stop);
  const { id, token } = (await app.post('/api/trucks', { name: 'C' })).body;

  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(`${app.base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const waitFor = async (needle) => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      text += decoder.decode(value);
    }
  };

  await waitFor('event: snapshot');
  await app.post(`/api/trucks/${id}/open`, { token, durationMin: 60, ...BKK });
  await waitFor('event: update');
  await app.post(`/api/trucks/${id}/close`, { token });
  await waitFor('"reason":"owner"');
});

test('data survives restart', async (t) => {
  const app = await start();
  const { id, token } = (await app.post('/api/trucks', { name: 'D' })).body;
  await app.post(`/api/trucks/${id}/open`, { token, durationMin: 60, ...BKK });
  await app.stop();

  const again = await start({ dataFile: path.join(app.dir, 'trucks.json') });
  t.after(again.stop);
  assert.equal((await again.get('/api/trucks')).body.trucks.length, 1);
});

test('serves pages and blocks path traversal', async (t) => {
  const app = await start();
  t.after(app.stop);
  assert.equal((await fetch(`${app.base}/`)).status, 200);
  assert.equal((await fetch(`${app.base}/owner`)).status, 200);
  assert.equal((await fetch(`${app.base}/..%2fserver.js`)).status, 404);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('menu items with photos', async (t) => {
  const app = await start();
  t.after(app.stop);
  const { id, token } = (await app.post('/api/trucks', { name: 'E' })).body;
  const upload = (buf, tok = token) => fetch(`${app.base}/api/trucks/${id}/upload`, {
    method: 'POST', headers: { 'X-Token': tok, 'Content-Type': 'image/png' }, body: buf,
  });

  assert.equal((await upload(PNG, 'bad')).status, 403);
  assert.equal((await upload(Buffer.from('<svg/>'))).status, 415, 'non-images rejected');
  const up = await (await upload(PNG)).json();
  assert.match(up.url, /^\/uploads\/[a-f0-9]{24}\.png$/);
  const img = await fetch(app.base + up.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  const saved = await app.post(`/api/trucks/${id}/profile`, {
    token,
    photo: up.url,
    items: [
      { name: 'ข้าวมันไก่', price: '50', category: 'food', photo: up.url },
      { name: 'ชาเย็น', price: 25, category: 'drink', soldOut: true },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.truck.photo, up.url);
  assert.deepEqual(saved.body.truck.items.map((i) => [i.name, i.price, i.category, i.soldOut]),
    [['ข้าวมันไก่', 50, 'food', false], ['ชาเย็น', 25, 'drink', true]]);

  // Photos must be this truck's own uploads; prices must be sane.
  assert.equal((await app.post(`/api/trucks/${id}/profile`, { token, photo: '/uploads/aaaaaaaaaaaaaaaaaaaaaaaa.png' })).status, 400);
  assert.equal((await app.post(`/api/trucks/${id}/profile`, { token, items: [{ name: 'x', price: -1 }] })).status, 400);
  assert.equal((await app.post(`/api/trucks/${id}/profile`, { token, items: [{ name: '', price: 1 }] })).status, 400);

  // Removing the photos deletes the files.
  await app.post(`/api/trucks/${id}/profile`, { token, photo: null, items: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(app.base + up.url)).status, 404);
});

test('locatedAt tracks the last GPS report', async (t) => {
  let clock = 5_000_000;
  const app = await start({ now: () => clock });
  t.after(app.stop);
  const { id, token } = (await app.post('/api/trucks', { name: 'F' })).body;
  await app.post(`/api/trucks/${id}/open`, { token, durationMin: 60, ...BKK });
  assert.equal((await app.get('/api/trucks')).body.trucks[0].locatedAt, 5_000_000);
  clock += 7 * 60 * 1000;
  await app.post(`/api/trucks/${id}/location`, { token, ...BKK });
  assert.equal((await app.get('/api/trucks')).body.trucks[0].locatedAt, clock);
});

test('feedback reaches the admin, with rate limit and key', async (t) => {
  const app = await start({ adminKey: 'secret-admin' });
  t.after(app.stop);
  const { id } = (await app.post('/api/trucks', { name: 'G' })).body;

  assert.equal((await app.post('/api/feedback', { message: '  ' })).status, 400);
  const sent = await app.post('/api/feedback', { message: 'อยากให้มีโหมดสว่าง', kind: 'idea', contact: 'line: abc', from: 'owner', truckId: id });
  assert.equal(sent.status, 201);

  assert.equal((await app.post('/api/admin/feedback', { key: 'wrong' })).status, 403);
  const list = (await app.post('/api/admin/feedback', { key: 'secret-admin' })).body.feedback;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].kind, list[0].from, list[0].truckName, list[0].contact, list[0].done], ['idea', 'owner', 'G', 'line: abc', false]);

  assert.equal((await app.post(`/api/admin/feedback/${list[0].id}/done`, { key: 'secret-admin' })).status, 200);
  assert.equal((await app.post('/api/admin/feedback', { key: 'secret-admin' })).body.feedback[0].done, true);
  assert.equal((await app.post(`/api/admin/feedback/${list[0].id}/delete`, { key: 'secret-admin' })).status, 200);
  assert.equal((await app.post('/api/admin/feedback', { key: 'secret-admin' })).body.feedback.length, 0);

  for (let i = 0; i < 4; i++) assert.equal((await app.post('/api/feedback', { message: `m${i}` })).status, 201);
  assert.equal((await app.post('/api/feedback', { message: 'one too many' })).status, 429);
});

test('admin is disabled without ADMIN_KEY', async (t) => {
  const app = await start({ adminKey: undefined });
  t.after(app.stop);
  assert.equal((await app.post('/api/admin/feedback', { key: '' })).status, 503);
});

test('private chat between a customer and a truck', async (t) => {
  const app = await start();
  t.after(app.stop);
  const owner = (await app.post('/api/trucks', { name: 'H' })).body;
  const other = (await app.post('/api/trucks', { name: 'I' })).body;

  assert.equal((await app.post('/api/chats', { truckId: 'nope' })).status, 404);
  const c = (await app.post('/api/chats', { truckId: owner.id, guestName: 'Nok' })).body;
  assert.equal(c.truckName, 'H');

  // Empty chats stay hidden from the owner until the customer writes.
  assert.equal((await app.post(`/api/trucks/${owner.id}/chats`, { token: owner.token })).body.chats.length, 0);
  assert.equal((await app.post(`/api/chats/${c.id}/send`, { token: c.token, text: 'มีข้าวมันไก่ไหม' })).status, 201);
  assert.equal((await app.post(`/api/chats/${c.id}/send`, { token: c.token, text: '  ' })).status, 400);

  let list = (await app.post(`/api/trucks/${owner.id}/chats`, { token: owner.token })).body.chats;
  assert.deepEqual([list.length, list[0].guestName, list[0].unread, list[0].last.text], [1, 'Nok', 1, 'มีข้าวมันไก่ไหม']);

  // Other people can't read or write it.
  assert.equal((await app.post(`/api/chats/${c.id}`, { token: other.token })).status, 403);
  assert.equal((await app.post(`/api/chats/${c.id}/send`, { token: 'x', text: 'hi' })).status, 403);

  // Owner reads (clears unread) and replies; customer sees one unread reply.
  const read = (await app.post(`/api/chats/${c.id}`, { token: owner.token })).body;
  assert.equal(read.role, 'owner');
  assert.equal(read.messages.length, 1);
  assert.equal((await app.post(`/api/trucks/${owner.id}/chats`, { token: owner.token })).body.chats[0].unread, 0);
  await app.post(`/api/chats/${c.id}/send`, { token: owner.token, text: 'มีครับ' });
  const sum = (await app.post('/api/chats-summary', { chats: [{ id: c.id, token: c.token }, { id: 'gone', token: 'x' }] })).body.chats;
  assert.deepEqual([sum[0].unread, sum[0].last.from, sum[1].gone], [1, 'owner', true]);

  // `since` returns only newer messages.
  const newer = (await app.post(`/api/chats/${c.id}`, { token: c.token, since: 1 })).body.messages;
  assert.deepEqual(newer.map((m) => [m.n, m.from, m.text]), [[2, 'owner', 'มีครับ']]);

  // Only the owner can delete.
  assert.equal((await app.post(`/api/chats/${c.id}/delete`, { token: c.token })).status, 403);
  assert.equal((await app.post(`/api/chats/${c.id}/delete`, { token: owner.token })).status, 200);
  assert.equal((await app.post(`/api/chats/${c.id}`, { token: c.token })).status, 404);
});

test('chat spam limits', async (t) => {
  const app = await start();
  t.after(app.stop);
  const truck = (await app.post('/api/trucks', { name: 'J' })).body;
  const c = (await app.post('/api/chats', { truckId: truck.id })).body;
  for (let i = 0; i < 10; i++) assert.equal((await app.post(`/api/chats/${c.id}/send`, { token: c.token, text: `m${i}` })).status, 201);
  assert.equal((await app.post(`/api/chats/${c.id}/send`, { token: c.token, text: 'too fast' })).status, 429);
  assert.equal((await app.post(`/api/chats/${c.id}/send`, { token: truck.token, text: 'owner is not limited' })).status, 201);
  for (let i = 0; i < 9; i++) assert.equal((await app.post('/api/chats', { truckId: truck.id })).status, 201);
  assert.equal((await app.post('/api/chats', { truckId: truck.id })).status, 429);
});
