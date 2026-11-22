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
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-latest',
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
  return { persona: body.persona, nick, messages: msgs };
}

function upstreamError(status, body) {
  const e = new Error('upstream ' + status);
  e.httpStatus = status;
  const er = body && body.error;
  e.reason = String((er && (er.status || er.code || er.type)) || '').slice(0, 60);
  return e;
}

async function callGemini(cfg, f, system, msgs, signal) {
  const r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, {
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
      if (new URL(req.url, 'http://x').searchParams.get('ai') !== '1') return send(200, { ok: true, configured: hasKey });
      // /health?ai=1: satu panggilan kecil ke penyedia AI untuk diagnosis. Hanya kode status, tidak ada isi kunci.
      if (!hasKey) return send(200, { ok: true, configured: false });
      if (limited(clientIp(req))) return send(429, { error: 'Terlalu banyak permintaan.' });
      const ctl0 = new AbortController();
      const to0 = setTimeout(() => ctl0.abort(), 15000);
      try {
        const call0 = cfg.provider === 'openai' ? callOpenAI : callGemini;
        const t0 = String(await call0(cfg, f, 'Jawab singkat.', [{ role: 'user', text: 'hai' }], ctl0.signal)).trim();
        return send(200, { ok: true, configured: true, ai: t0 ? 'ok' : 'kosong', provider: cfg.provider, model: cfg.provider === 'openai' ? cfg.openaiModel : cfg.geminiModel });
      } catch (e) {
        return send(200, { ok: true, configured: true, ai: 'gagal', provider: cfg.provider, model: cfg.provider === 'openai' ? cfg.openaiModel : cfg.geminiModel,
          status: e.httpStatus || 0, reason: e.reason || (e.name === 'AbortError' ? 'timeout' : 'jaringan') });
      } finally { clearTimeout(to0); }
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
      const system = TC.buildSystemPrompt(v.persona, { nick: v.nick, crisis });
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 20000);
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
module.exports = { createServer, loadConfig, validate };
