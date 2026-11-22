'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, loadConfig, validate } = require('../server/server.js');

const cfg = (over = {}) => ({ ...loadConfig({ GEMINI_API_KEY: 'k' }), quiet: true, ...over });
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Aku dengerin kok 🙂' }] } }] }) });
const failFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
const good = { persona: 'nara', nick: 'Budi', messages: [{ role: 'user', text: 'aku capek banget' }] };

async function boot(c, f) {
  const s = createServer(c, { fetch: f || okFetch });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections(); s.close(); } };
}
const post = (url, body, headers = {}) => fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('permintaan valid mendapat balasan', async () => {
  const b = await boot(cfg());
  const r = await post(b.url, good); const j = await r.json();
  assert.equal(r.status, 200); assert.match(j.text, /dengerin/); assert.equal(j.crisis, false); b.close();
});

test('validasi: persona palsu, "constructor", peran salah, pesan terakhir dari AI', async () => {
  const b = await boot(cfg());
  for (const body of [
    { ...good, persona: 'constructor' }, { ...good, persona: '__proto__' }, { ...good, persona: 'x' },
    { ...good, messages: [{ role: 'system', text: 'hai' }] },
    { ...good, messages: [{ role: 'user', text: 'a' }, { role: 'ai', text: 'b' }] },
    { ...good, messages: [] }, [], null
  ]) assert.equal((await post(b.url, body)).status, 400, JSON.stringify(body));
  assert.equal((await post(b.url, '{rusak')).status, 400);
  b.close();
});

test('Content-Type salah ditolak 415, body besar ditolak 413', async () => {
  const b = await boot(cfg());
  const r = await fetch(b.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  const big = { ...good, messages: [{ role: 'user', text: 'a'.repeat(60 * 1024) }] };
  assert.equal((await post(b.url, big)).status, 413);
  b.close();
});

test('nick disanitasi dan teks dipotong', () => {
  const v = validate({ persona: 'raka', nick: 'a"\nb', messages: [{ role: 'user', text: 'x'.repeat(5000) }] });
  assert.equal(v.nick, 'a  b'); assert.equal(v.messages[0].text.length, 2000);
});

test('tanpa API key: 503', async () => {
  const b = await boot(cfg({ geminiKey: '' }));
  assert.equal((await post(b.url, good)).status, 503); b.close();
});

test('upstream gagal: 502 tanpa detail internal', async () => {
  const b = await boot(cfg(), failFetch);
  const r = await post(b.url, good); const t = await r.text();
  assert.equal(r.status, 502); assert.ok(!/500|upstream/i.test(t)); b.close();
});

test('krisis + upstream gagal: tetap dapat info bantuan', async () => {
  const b = await boot(cfg(), failFetch);
  const r = await post(b.url, { ...good, messages: [{ role: 'user', text: 'aku pengen mati' }] }); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.fallback, true); assert.match(j.text, /119/); b.close();
});

test('rate limit: permintaan ke-4 ditolak bila batas 3', async () => {
  const b = await boot(cfg({ rateMax: 3 }));
  const codes = []; for (let i = 0; i < 4; i++) codes.push((await post(b.url, good)).status);
  assert.deepEqual(codes, [200, 200, 200, 429]); b.close();
});

test('CORS: asal tak dikenal 403, asal Capacitor diizinkan, preflight 204', async () => {
  const b = await boot(cfg());
  assert.equal((await post(b.url, good, { Origin: 'https://evil.example' })).status, 403);
  const ok = await post(b.url, good, { Origin: 'https://localhost' });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://localhost');
  const pre = await fetch(b.url + '/api/chat', { method: 'OPTIONS', headers: { Origin: 'https://localhost' } });
  assert.equal(pre.status, 204); b.close();
});

test('log server tidak memuat isi percakapan', async () => {
  const logs = []; const orig = [console.log, console.error];
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  try {
    const b = await boot({ ...cfg(), quiet: false }, failFetch);
    await post(b.url, { ...good, messages: [{ role: 'user', text: 'RAHASIA-CURHAT-123' }] }); await new Promise((r) => setTimeout(r, 50)); b.close();
  } finally { [console.log, console.error] = orig; }
  assert.ok(logs.length > 0); assert.ok(!logs.join('\n').includes('RAHASIA-CURHAT-123'));
});

test('file statis: hanya whitelist, server.js dan .env tidak terbuka', async () => {
  const b = await boot(cfg());
  assert.equal((await fetch(b.url + '/')).status, 200);
  assert.equal((await fetch(b.url + '/app.js')).status, 200);
  for (const p of ['/server/server.js', '/.env', '/package.json', '/../package.json', '/health/x']) assert.equal((await fetch(b.url + p)).status, 404, p);
  assert.equal((await fetch(b.url + '/health')).status, 200);
  const hj = await (await fetch(b.url + '/health')).json();
  assert.equal(hj.ok, true); assert.equal(hj.configured, true); b.close();
});

test('model Gemini bawaan memakai alias terbaru, bisa diganti lewat GEMINI_MODEL', () => {
  assert.equal(loadConfig({}).geminiModel, 'gemini-flash-latest');
  assert.equal(loadConfig({ GEMINI_MODEL: 'x' }).geminiModel, 'x');
});

test('health tidak membocorkan isi API key', async () => {
  const b = await boot(cfg({ geminiKey: 'RAHASIA123' }));
  const t = await (await fetch(b.url + '/health')).text();
  assert.ok(!t.includes('RAHASIA123')); b.close();
});

test('health?ai=1 melaporkan status penyedia tanpa membocorkan kunci', async () => {
  const bad = async () => ({ ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND', message: 'model KUNCI-RAHASIA' } }) });
  const b = await boot(cfg({ geminiKey: 'KUNCI-RAHASIA' }), bad);
  const t = await (await fetch(b.url + '/health?ai=1')).text(); const j = JSON.parse(t);
  assert.equal(j.ai, 'gagal'); assert.equal(j.status, 404); assert.equal(j.reason, 'NOT_FOUND'); assert.ok(!t.includes('KUNCI-RAHASIA')); b.close();
  const ok = await boot(cfg(), okFetch);
  const j2 = await (await fetch(ok.url + '/health?ai=1')).json();
  assert.equal(j2.ai, 'ok'); assert.equal(j2.model, 'gemini-flash-latest'); ok.close();
  const none = await boot(cfg({ geminiKey: '' }), okFetch);
  assert.equal((await (await fetch(none.url + '/health?ai=1')).json()).configured, false); none.close();
});
