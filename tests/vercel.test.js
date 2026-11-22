'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.GEMINI_API_KEY = '';
const chat = require('../api/chat.js');
const health = require('../api/health.js');

async function boot(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections(); s.close(); } };
}

test('vercel: /api/health dijawab sebagai /health', async () => {
  const b = await boot(health);
  const r = await fetch(b.url + '/api/health?x=1');
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, configured: false }); b.close();
});

test('vercel: /api/chat tanpa API key membalas 503, bukan hang', async () => {
  const b = await boot(chat);
  const r = await fetch(b.url + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'nara', messages: [{ role: 'user', text: 'hai' }] })
  });
  assert.equal(r.status, 503); b.close();
});

test('vercel: asal tidak dikenal ditolak 403 dan GET ke /api/chat 405', async () => {
  const b = await boot(chat);
  const bad = await fetch(b.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(bad.status, 403);
  const g = await fetch(b.url + '/api/chat');
  assert.equal(g.status, 405); b.close();
});
