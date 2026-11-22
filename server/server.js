'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const TC = require('../www/persona.js');

const WWW = path.join(__dirname, '..', 'www');
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/persona.js': 'persona.js', '/config.js': 'config.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const MAX_BODY = 50 * 1024;

function loadConfig(env = process.env) {
  return {
    provider: (env.PROVIDER || 'gemini').toLowerCase(),
    port: Number(env.PORT) || 3000,
    allowed: (env.ALLOWED_ORIGINS || 'https://localhost,capacitor://localhost').split(',').map((s) => s.trim()).filter(Boolean),
    rateMax: Number(env.RATE_LIMIT_PER_MIN) || 20,
    trustProxy: env.TRUST_PROXY === '1',
    serveWeb: env.SERVE_WEB !== '0',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    geminiFallback: env.GEMINI_FALLBACK_MODEL || 'gemini-flash-latest',
    ttsModels: (env.TTS_MODELS || 'gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts,gemini-2.5-flash-preview-tts').split(',').map((x) => x.trim()).filter(Boolean),
    ttsRateMax: Number(env.TTS_RATE_LIMIT_PER_MIN) || 8,
    openaiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    quiet: false
  };
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Permintaan tidak valid.' };
  if (typeof body.persona !== 'string' || !Object.prototype.hasOwnProperty.call(TC.PERSONAS, body.persona)) return { error: 'Persona tidak dikenal.' };
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 60) return { error: 'Daftar pesan tidak valid.' };
  const nick = typeof body.nick === 'string' ? body.nick.replace(/[\u0000-\u001f\u007f"]/g, ' ').trim().slice(0, 30) : '';
  let msgs = [];
  for (const m of body.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'ai') || typeof m.text !== 'string') return { error: 'Format pesan tidak valid.' };
    const text = m.text.trim().slice(0, 2000);
    if (text) msgs.push({ role: m.role, text });
  }
  msgs = msgs.slice(-20);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { error: 'Pesan terakhir harus dari pengguna.' };
  const style = typeof body.style === 'string' && Object.prototype.hasOwnProperty.call(TC.STYLES, body.style) ? body.style : '';
  return { persona: body.persona, nick, style, messages: msgs };
}

function upstreamError(status, body) {
  const e = new Error('upstream ' + status);
  e.httpStatus = status;
  const er = body && body.error;
  e.reason = String((er && (er.status || er.code || er.type)) || '').slice(0, 60);
  return e;
}

async function callGeminiModel(cfg, model, f, system, msgs, signal) {
  const r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: msgs.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
      generationConfig: { temperature: 0.9, maxOutputTokens: 400 }
    })
  });
  if (!r.ok) throw upstreamError(r.status, await r.json().catch(() => ({})));
  const j = await r.json();
  return ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((p) => p.text || '').join('');
}

// Gemini kadang membalas 503 (sibuk) atau 404 (model dihentikan). Coba model utama, lalu model cadangan,
// lalu model utama sekali lagi. Kesalahan lain (kunci salah, permintaan salah) langsung dilaporkan.
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);
async function callGemini(cfg, f, system, msgs, signal) {
  const order = [cfg.geminiModel, cfg.geminiFallback, cfg.geminiModel].filter(Boolean);
  let last;
  for (let i = 0; i < order.length; i++) {
    if (signal && signal.aborted) throw last || Object.assign(new Error('abort'), { name: 'AbortError' });
    // tiap percobaan punya batas waktu sendiri, supaya model yang lambat tidak menghabiskan waktu semuanya
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const to = setTimeout(() => ctl.abort(), cfg.attemptMs || 9000);
    try {
      const text = await callGeminiModel(cfg, order[i], f, system, msgs, ctl.signal);
      if (String(text).trim()) return text;
      last = new Error('kosong');
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (e.name !== 'AbortError' && !RETRYABLE.has(e.httpStatus)) throw e;
      last = e.name === 'AbortError' ? Object.assign(new Error('timeout'), { httpStatus: 0, reason: 'timeout' }) : e;
    } finally { clearTimeout(to); if (signal) signal.removeEventListener('abort', onAbort); }
    if (i < order.length - 1) await new Promise((r) => setTimeout(r, i === 1 ? 500 : 0));
  }
  throw last;
}

async function callOpenAI(cfg, f, system, msgs, signal) {
  const r = await f('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.openaiKey },
    body: JSON.stringify({
      model: cfg.openaiModel, temperature: 0.9, max_completion_tokens: 400,
      messages: [{ role: 'system', content: system }, ...msgs.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))]
    })
  });
  if (!r.ok) throw upstreamError(r.status, await r.json().catch(() => ({})));
  const j = await r.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

// ---------- suara (Gemini TTS) ----------
// Suara per jenis suara persona dan gaya chat. Nama suara bawaan Gemini; keterangan gaya dibaca model sebagai arahan nada.
const TTS_VOICES = {
  female: { lembut: 'Achernar', softspoken: 'Vindemiatrix', ceria: 'Zephyr', tenang: 'Sulafat', santai: 'Achird' },
  male: { lembut: 'Umbriel', softspoken: 'Umbriel', ceria: 'Puck', tenang: 'Charon', santai: 'Iapetus' }
};
const TTS_STYLE = {
  lembut: 'very soft, warm, gentle and caring voice, slow calm pace, like a kind friend speaking quietly',
  softspoken: 'soft-spoken, calm, low and gentle voice, slow warm pace, reassuring',
  ceria: 'friendly, warm and lightly cheerful, natural pace',
  tenang: 'calm, clear, soothing and unhurried',
  santai: 'relaxed, casual, friendly, natural conversational pace'
};
const TTS_MAX_CHARS = 600;

function wavFromPcm(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function validateTts(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Permintaan tidak valid.' };
  if (typeof body.persona !== 'string' || !Object.prototype.hasOwnProperty.call(TC.PERSONAS, body.persona)) return { error: 'Persona tidak dikenal.' };
  if (typeof body.text !== 'string') return { error: 'Teks tidak valid.' };
  const text = body.text.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, '').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
  if (!text) return { error: 'Teks kosong.' };
  const style = typeof body.style === 'string' && Object.prototype.hasOwnProperty.call(TC.STYLES, body.style) ? body.style : TC.DEFAULT_STYLE[body.persona] || 'tenang';
  const gender = TC.PERSONAS[body.persona].voice === 'male' ? 'male' : 'female';
  return { persona: body.persona, text, style, gender };
}

// Dua bentuk permintaan: model 3.x memakai voiceConfig.voice + speech_metadata.style,
// model 2.5 memakai prebuiltVoiceConfig.voiceName + arahan di awal teks.
function ttsRequest(model, v) {
  const voice = TTS_VOICES[v.gender][v.style];
  const style = TTS_STYLE[v.style];
  if (/^gemini-3/.test(model)) {
    return { contents: [{ role: 'user', parts: [{ text: v.text, speech_metadata: { style } }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice } } } };
  }
  return { contents: [{ role: 'user', parts: [{ text: `Say in a ${style}: ${v.text}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
}

async function callGeminiTts(cfg, model, f, v, signal) {
  const r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
    body: JSON.stringify(ttsRequest(model, v))
  });
  if (!r.ok) throw upstreamError(r.status, await r.json().catch(() => ({})));
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const part = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!part) throw Object.assign(new Error('kosong'), { httpStatus: 0, reason: 'tanpa audio' });
  const buf = Buffer.from(part.inlineData.data, 'base64');
  if (buf.length < 100) throw Object.assign(new Error('kosong'), { httpStatus: 0, reason: 'audio kosong' });
  return buf.slice(0, 4).toString('latin1') === 'RIFF' ? buf : wavFromPcm(buf);
}

// Coba tiap model berurutan; 400/404/429/5xx/timeout lanjut ke model berikutnya.
async function ttsWithFallback(cfg, f, v, signal) {
  let last;
  for (const model of cfg.ttsModels) {
    if (signal && signal.aborted) break;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const to = setTimeout(() => ctl.abort(), cfg.ttsAttemptMs || 12000);
    try { return await callGeminiTts(cfg, model, f, v, ctl.signal); }
    catch (e) {
      if (e.name === 'AbortError') last = Object.assign(new Error('timeout'), { httpStatus: 0, reason: 'timeout' });
      else if (e.httpStatus === 401 || e.httpStatus === 403) throw e; // kunci salah: percobaan lain sia-sia
      else last = e;
    } finally { clearTimeout(to); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  throw last || new Error('tts gagal');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0, done = false; const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > MAX_BODY) { done = true; chunks.length = 0; reject(Object.assign(new Error('big'), { code: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function createServer(cfg, deps = {}) {
  const f = deps.fetch || globalThis.fetch;
  const hits = new Map();
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 60000)) hits.delete(k); }, 60000);
  sweep.unref();
  const limited = (ip) => {
    const now = Date.now();
    const a = (hits.get(ip) || []).filter((t) => now - t < 60000);
    a.push(now); hits.set(ip, a);
    return a.length > cfg.rateMax;
  };
  const ttsHits = new Map();
  const ttsLimited = (ip) => {
    const now = Date.now();
    const a = (ttsHits.get(ip) || []).filter((t) => now - t < 60000);
    a.push(now); ttsHits.set(ip, a);
    return a.length > cfg.ttsRateMax;
  };
  const clientIp = (req) => {
    if (cfg.trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (x) return x; }
    return req.socket.remoteAddress || 'unknown';
  };

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* abaikan */ }
    // Log hanya metode, path, dan status. Isi percakapan tidak pernah dicatat.
    if (!cfg.quiet) res.on('finish', () => console.log(`${req.method} ${pathname} ${res.statusCode}`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };

    if (pathname === '/health') {
      // configured: apakah API key sudah terisi (hanya ya/tidak, isi kunci tidak pernah ditampilkan)
      const hasKey = Boolean(cfg.provider === 'openai' ? cfg.openaiKey : cfg.geminiKey);
      const hq = new URL(req.url, 'http://x').searchParams;
      if (hq.get('tts') === '1') {
        // /health?tts=1: uji tiap model suara dengan kalimat pendek. Hanya status, ukuran, dan waktu.
        if (!cfg.geminiKey) return send(200, { ok: true, configured: false });
        if (limited(clientIp(req))) return send(429, { error: 'Terlalu banyak permintaan.' });
        const v = validateTts({ persona: 'nara', style: 'lembut', text: 'Aku di sini ya.' });
        const out = await Promise.all(cfg.ttsModels.map(async (model) => {
          const t0 = Date.now(); const c0 = new AbortController(); const x0 = setTimeout(() => c0.abort(), 12000);
          try { const b = await callGeminiTts(cfg, model, f, v, c0.signal); return { model, tts: 'ok', bytes: b.length, ms: Date.now() - t0 }; }
          catch (e) { return { model, tts: 'gagal', status: e.httpStatus || 0, reason: e.reason || (e.name === 'AbortError' ? 'timeout' : 'jaringan'), ms: Date.now() - t0 }; }
          finally { clearTimeout(x0); }
        }));
        return send(200, { ok: true, tts: out.some((r) => r.tts === 'ok') ? 'ok' : 'gagal', models: out });
      }
      if (hq.get('ai') !== '1') return send(200, { ok: true, configured: hasKey });
      // /health?ai=1: satu panggilan kecil ke penyedia AI untuk diagnosis. Hanya kode status, tidak ada isi kunci.
      if (!hasKey) return send(200, { ok: true, configured: false });
      if (limited(clientIp(req))) return send(429, { error: 'Terlalu banyak permintaan.' });
      // satu uji per model, bersamaan, masing-masing maksimal 9 detik; hanya kode status dan alasan singkat
      const models = cfg.provider === 'openai' ? [cfg.openaiModel] : [...new Set([cfg.geminiModel, cfg.geminiFallback].filter(Boolean))];
      const probe = async (model) => {
        const t0 = Date.now(); const ctl0 = new AbortController(); const to0 = setTimeout(() => ctl0.abort(), 9000);
        try {
          const text = cfg.provider === 'openai'
            ? await callOpenAI(cfg, f, 'Jawab singkat.', [{ role: 'user', text: 'hai' }], ctl0.signal)
            : await callGeminiModel(cfg, model, f, 'Jawab singkat.', [{ role: 'user', text: 'hai' }], ctl0.signal);
          return { model, ai: String(text).trim() ? 'ok' : 'kosong', ms: Date.now() - t0 };
        } catch (e) {
          return { model, ai: 'gagal', status: e.httpStatus || 0, reason: e.reason || (e.name === 'AbortError' ? 'timeout' : 'jaringan'), ms: Date.now() - t0 };
        } finally { clearTimeout(to0); }
      };
      const results = await Promise.all(models.map(probe));
      return send(200, { ok: true, configured: true, provider: cfg.provider, ai: results.some((r) => r.ai === 'ok') ? 'ok' : 'gagal', models: results });
    }

    if (pathname === '/api/chat') {
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try { sameHost = new URL(origin).host === req.headers.host; } catch (e) { /* abaikan */ }
        if (!sameHost && !cfg.allowed.includes(origin)) return send(403, { error: 'Asal permintaan tidak diizinkan.' });
        if (!sameHost) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Max-Age', '600');
        }
      }
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      if (req.method !== 'POST') return send(405, { error: 'Metode tidak diizinkan.' });
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Content-Type harus application/json.' });
      if (limited(clientIp(req))) return send(429, { error: 'Terlalu banyak pesan, coba lagi sebentar.' });
      let raw;
      try { raw = await readBody(req); } catch (e) { return send(e.code === 413 ? 413 : 400, { error: 'Isi permintaan terlalu besar atau rusak.' }); }
      let body;
      try { body = JSON.parse(raw); } catch (e) { return send(400, { error: 'JSON tidak valid.' }); }
      const v = validate(body);
      if (v.error) return send(400, { error: v.error });
      const key = cfg.provider === 'openai' ? cfg.openaiKey : cfg.geminiKey;
      if (!key) return send(503, { error: 'Server belum dikonfigurasi.' });
      const crisis = TC.detectCrisis(v.messages[v.messages.length - 1].text);
      const system = TC.buildSystemPrompt(v.persona, { nick: v.nick, crisis, style: v.style });
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 26000);
      try {
        const call = cfg.provider === 'openai' ? callOpenAI : callGemini;
        const text = String(await call(cfg, f, system, v.messages, ctl.signal)).trim().slice(0, 1500);
        if (!text) throw new Error('kosong');
        return send(200, { text, crisis });
      } catch (e) {
        if (!cfg.quiet) console.error('upstream gagal:', e.name === 'AbortError' ? 'timeout' : e.message);
        // Pengguna dalam krisis tetap menerima informasi bantuan walau AI gagal.
        if (crisis) return send(200, { text: TC.CRISIS_NOTICE.join(' '), crisis: true, fallback: true });
        return send(502, { error: 'AI sedang tidak bisa dihubungi.' });
      } finally { clearTimeout(to); }
    }

    if (pathname === '/api/tts') {
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try { sameHost = new URL(origin).host === req.headers.host; } catch (e) { /* abaikan */ }
        if (!sameHost && !cfg.allowed.includes(origin)) return send(403, { error: 'Asal permintaan tidak diizinkan.' });
        if (!sameHost) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Max-Age', '600');
        }
      }
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      if (req.method !== 'POST') return send(405, { error: 'Metode tidak diizinkan.' });
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Content-Type harus application/json.' });
      if (ttsLimited(clientIp(req))) return send(429, { error: 'Terlalu banyak permintaan suara, coba lagi sebentar.' });
      let raw;
      try { raw = await readBody(req); } catch (e) { return send(e.code === 413 ? 413 : 400, { error: 'Isi permintaan terlalu besar atau rusak.' }); }
      let body;
      try { body = JSON.parse(raw); } catch (e) { return send(400, { error: 'JSON tidak valid.' }); }
      const v = validateTts(body);
      if (v.error) return send(400, { error: v.error });
      if (!cfg.geminiKey) return send(503, { error: 'Suara belum dikonfigurasi.' });
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 26000);
      try {
        const wav = await ttsWithFallback(cfg, f, v, ctl.signal);
        res.statusCode = 200; res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Length', wav.length);
        return res.end(wav);
      } catch (e) {
        if (!cfg.quiet) console.error('tts gagal:', e.name === 'AbortError' ? 'timeout' : e.message);
        return send(502, { error: 'Suara sedang tidak bisa dibuat.' });
      } finally { clearTimeout(to); }
    }

    if (cfg.serveWeb && req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC, pathname)) {
      const file = STATIC[pathname];
      return fs.readFile(path.join(WWW, file), (err, data) => {
        if (err) return send(404, { error: 'Tidak ditemukan.' });
        res.statusCode = 200; res.setHeader('Content-Type', TYPES[path.extname(file)]); res.setHeader('Cache-Control', 'no-cache'); res.end(data);
      });
    }
    return send(404, { error: 'Tidak ditemukan.' });
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return server;
}

if (require.main === module) {
  const cfg = loadConfig();
  const key = cfg.provider === 'openai' ? cfg.openaiKey : cfg.geminiKey;
  if (!key) console.warn(`PERINGATAN: API key untuk provider "${cfg.provider}" belum diisi. /api/chat akan membalas 503.`);
  createServer(cfg).listen(cfg.port, () => console.log(`DearMe backend di port ${cfg.port} (provider: ${cfg.provider})`));
}
module.exports = { createServer, loadConfig, validate, validateTts, wavFromPcm };
