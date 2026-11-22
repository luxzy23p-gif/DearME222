'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, loadConfig, validateTts, wavFromPcm } = require('../server/server.js');

const cfg = (over = {}) => ({ ...loadConfig({ GEMINI_API_KEY: 'k' }), quiet: true, ...over });
const pcm = Buffer.alloc(4800, 1);
const audioFetch = (data) => async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: data.toString('base64') } }] } }] }) });
async function boot(c, f) {
  const s = createServer(c, { fetch: f });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections(); s.close(); } };
}
const post = (url, body) => fetch(url + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const good = { persona: 'nara', style: 'lembut', text: 'Aku di sini ya 🙂' };

test('wavFromPcm: header RIFF 24 kHz mono 16-bit', () => {
  const w = wavFromPcm(pcm);
  assert.equal(w.slice(0, 4).toString(), 'RIFF'); assert.equal(w.slice(8, 12).toString(), 'WAVE');
  assert.equal(w.readUInt32LE(24), 24000); assert.equal(w.readUInt16LE(22), 1); assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.length, 44 + pcm.length);
});

test('validateTts: persona/gaya palsu, teks kosong, emoji dibuang, dipotong', () => {
  assert.ok(validateTts({ ...good, persona: 'constructor' }).error);
  assert.ok(validateTts({ ...good, text: '🙂🙂' }).error);
  assert.ok(validateTts(null).error);
  assert.equal(validateTts(good).text, 'Aku di sini ya');
  assert.equal(validateTts({ ...good, style: '__proto__' }).style, 'lembut');
  assert.equal(validateTts({ ...good, text: 'a'.repeat(5000) }).text.length, 600);
  assert.equal(validateTts({ persona: 'raka', text: 'hai' }).gender, 'male');
});

test('/api/tts: PCM dibungkus WAV, WAV asli diteruskan, suara sesuai gaya', async () => {
  let sent;
  const f = async (u, o) => { sent = { u, body: JSON.parse(o.body) }; return audioFetch(pcm)(); };
  const b = await boot(cfg(), f);
  const r = await post(b.url, good);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/wav');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString(), 'RIFF');
  assert.match(sent.u, /gemini-3\.8-flash-lite-tts/);
  assert.equal(sent.body.generationConfig.speechConfig.voiceConfig.voice, 'Achernar');
  b.close();
  const wav = wavFromPcm(pcm);
  const b2 = await boot(cfg(), audioFetch(wav));
  const buf2 = Buffer.from(await (await post(b2.url, good)).arrayBuffer());
  assert.equal(buf2.length, wav.length); b2.close();
});

test('/api/tts: model pertama gagal -> model 2.5 dengan bentuk permintaan lama', async () => {
  const calls = [];
  const f = async (u, o) => {
    calls.push({ u, body: JSON.parse(o.body) });
    return calls.length < 3 ? { ok: false, status: 400, json: async () => ({}) } : audioFetch(pcm)();
  };
  const b = await boot(cfg(), f);
  const r = await post(b.url, { persona: 'raka', style: 'softspoken', text: 'Pelan-pelan aja.' });
  assert.equal(r.status, 200);
  assert.match(calls[2].u, /2\.5-flash-preview-tts/);
  assert.equal(calls[2].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Umbriel');
  assert.match(calls[2].body.contents[0].parts[0].text, /Pelan-pelan aja\./);
  b.close();
});

test('/api/tts: semua gagal -> 502 tanpa detail; kunci salah tidak dicoba ulang; tanpa kunci 503', async () => {
  let n = 0;
  const b = await boot(cfg(), async () => { n++; return { ok: false, status: 500, json: async () => ({}) }; });
  const r = await post(b.url, good); const j = await r.json();
  assert.equal(r.status, 502); assert.equal(JSON.stringify(j).includes('500'), false); assert.equal(n, 3); b.close();
  n = 0;
  const b2 = await boot(cfg(), async () => { n++; return { ok: false, status: 403, json: async () => ({}) }; });
  assert.equal((await post(b2.url, good)).status, 502); assert.equal(n, 1); b2.close();
  const b3 = await boot(cfg({ geminiKey: '' }), audioFetch(pcm));
  assert.equal((await post(b3.url, good)).status, 503); b3.close();
});

test('/api/tts: validasi, metode, tipe, rate limit, CORS', async () => {
  const b = await boot(cfg({ ttsRateMax: 3 }), audioFetch(pcm));
  assert.equal((await post(b.url, { ...good, persona: 'x' })).status, 400);
  assert.equal((await fetch(b.url + '/api/tts')).status, 405);
  assert.equal((await fetch(b.url + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await post(b.url, good)).status, 200);
  assert.equal((await post(b.url, good)).status, 200);
  assert.equal((await post(b.url, good)).status, 429); // permintaan ke-4 yang sampai ke pembatas
  b.close();
  const b2 = await boot(cfg(), audioFetch(pcm));
  const bad = await fetch(b2.url + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(good) });
  assert.equal(bad.status, 403);
  const ok = await fetch(b2.url + '/api/tts', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost' } });
  assert.equal(ok.status, 204); b2.close();
});

test('health?tts=1 melaporkan tiap model tanpa membocorkan kunci', async () => {
  const b = await boot(cfg(), audioFetch(pcm));
  const j = await (await fetch(b.url + '/health?tts=1')).json();
  assert.equal(j.tts, 'ok'); assert.equal(j.models.length, 3); assert.equal(JSON.stringify(j).includes('"k"'), false);
  b.close();
});

test('tone: kelembutan, kecepatan, dan pilihan suara masuk ke permintaan; nilai palsu diabaikan', async () => {
  const bodies = [];
  const f = async (u, o) => { bodies.push(JSON.parse(o.body)); return audioFetch(pcm)(); };
  const b = await boot(cfg(), f);
  let r = await post(b.url, { ...good, tone: { soft: 3, pace: 0, voice: 'Sulafat' } });
  assert.equal(r.status, 200);
  let g = bodies[0].generationConfig.speechConfig.voiceConfig;
  assert.equal(g.voice, 'Sulafat');
  assert.match(bodies[0].contents[0].parts[0].speech_metadata.style, /whisper/);
  assert.match(bodies[0].contents[0].parts[0].speech_metadata.style, /slowly/);
  // suara cowok tidak boleh dipakai persona cewek, nilai di luar rentang diabaikan
  r = await post(b.url, { ...good, tone: { soft: 9, pace: 'x', voice: 'Charon' } });
  g = bodies[1].generationConfig.speechConfig.voiceConfig;
  assert.equal(g.voice, 'Achernar');
  assert.ok(!/Deliver it/.test(bodies[1].contents[0].parts[0].speech_metadata.style));
  // persona cowok bisa memilih suara cowok; netral boleh dua-duanya; tone bukan objek diabaikan
  await post(b.url, { persona: 'raka', style: 'softspoken', text: 'hai', tone: { voice: 'Algieba' } });
  assert.equal(bodies[2].generationConfig.speechConfig.voiceConfig.voice, 'Algieba');
  await post(b.url, { persona: 'sena', text: 'hai', tone: { voice: 'Umbriel' } });
  assert.equal(bodies[3].generationConfig.speechConfig.voiceConfig.voice, 'Umbriel');
  await post(b.url, { ...good, tone: 'rusak' });
  assert.equal(bodies[4].generationConfig.speechConfig.voiceConfig.voice, 'Achernar');
  b.close();
  assert.equal(validateTts({ ...good, tone: { soft: 2, pace: 2 } }).soft, 2);
});

test('suara perempuan "santai" bukan Achird (suara laki-laki)', () => {
  const v = validateTts({ persona: 'nara', style: 'santai', text: 'hai' });
  const body = [];
  const f = async (u, o) => { body.push(JSON.parse(o.body)); return audioFetch(pcm)(); };
  return boot(cfg(), f).then(async (b) => { await post(b.url, { persona: 'nara', style: 'santai', text: 'hai' }); assert.notEqual(body[0].generationConfig.speechConfig.voiceConfig.voice, 'Achird'); assert.equal(v.gender, 'female'); b.close(); });
});
