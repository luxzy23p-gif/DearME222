'use strict';
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* penyimpanan penuh atau dimatikan */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } }
};
const BASE = ((window.DEARME_CONFIG && window.DEARME_CONFIG.API_BASE) || '').replace(/\/+$/, '');
const API = BASE + '/api/chat';
const TTS_API = BASE + '/api/tts';
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const IDS = Object.keys(TC.PERSONAS);
const THEMES = [
  { id: 'sage', name: 'Sage', desc: 'Krem dan hijau lembut', bar: '#f6f1e1' },
  { id: 'dark', name: 'Dark UI', desc: 'Gelap, nyaman di malam hari', bar: '#1a1a2e' },
  { id: 'glass', name: 'Liquid Glass', desc: 'Kaca bening berwarna', bar: '#3a2f80' },
  { id: 'sunset', name: 'Sunset', desc: 'Peach dan merah muda hangat', bar: '#ffe9dc' },
  { id: 'ocean', name: 'Ocean', desc: 'Biru laut yang tenang', bar: '#0b1f2e' }
];
const WAIT_MS = 2200;      // jeda setelah pesan terkirim sebelum AI mulai membaca
const WAIT_MAX = 12000;    // paling lama AI menunggu kamu selesai mengetik
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const hm = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

/* ---------- data ---------- */
function freshChat(id) { return { msgs: [], style: TC.DEFAULT_STYLE[id], voice: false, fav: false, unread: 0 }; }
function fresh() {
  const chats = {}; IDS.forEach((id) => { chats[id] = freshChat(id); });
  return { v: 2, nick: '', gender: '', theme: 'sage', onboarded: false, chats };
}
function cleanMsgs(a) {
  return (Array.isArray(a) ? a : []).filter((m) => m && (m.role === 'notice' || ((m.role === 'user' || m.role === 'ai') && typeof m.text === 'string')))
    .map((m) => ({ role: m.role, text: typeof m.text === 'string' ? m.text.slice(0, 2000) : '', t: Number(m.t) || Date.now(), vn: !!m.vn })).slice(-500);
}
function load() {
  const out = fresh();
  const s = store.get('tc2', null);
  if (s && typeof s === 'object') {
    out.nick = typeof s.nick === 'string' ? s.nick.slice(0, 30) : '';
    out.gender = ['pria', 'wanita', 'lainnya'].includes(s.gender) ? s.gender : '';
    out.theme = THEMES.some((t) => t.id === s.theme) ? s.theme : 'sage';
    out.onboarded = !!s.onboarded;
    IDS.forEach((id) => {
      const c = s.chats && s.chats[id];
      if (c && typeof c === 'object') out.chats[id] = { msgs: cleanMsgs(c.msgs), style: has(TC.STYLES, c.style) ? c.style : TC.DEFAULT_STYLE[id], voice: !!c.voice, fav: !!c.fav, unread: Math.max(0, Number(c.unread) || 0) | 0 };
    });
  } else {
    const old = store.get('tc1', null); // versi lama: hanya satu chat
    if (old && typeof old === 'object' && has(TC.PERSONAS, old.persona)) {
      out.chats[old.persona].msgs = cleanMsgs(old.msgs); out.chats[old.persona].voice = !!old.voice;
      out.nick = typeof old.nick === 'string' ? old.nick.slice(0, 30) : ''; out.onboarded = true;
    }
  }
  return out;
}
let S = load();
S.cur = null;
let view = 'list';
const save = () => { IDS.forEach((id) => { S.chats[id].msgs = S.chats[id].msgs.slice(-500); }); const { cur, ...keep } = S; store.set('tc2', keep); };
const chat = (id) => S.chats[id];
const suggested = () => (S.gender ? TC.DEFAULT_FOR[S.gender] : '');

/* ---------- tema ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  const m = document.querySelector('meta[name="theme-color"]');
  const t = THEMES.find((x) => x.id === S.theme);
  if (m && t) m.setAttribute('content', t.bar);
}
function renderThemes() {
  const box = $('#themes'); box.innerHTML = '';
  THEMES.forEach((t) => {
    const b = el('button', 'th' + (S.theme === t.id ? ' on' : ''));
    const pv = el('div', 'pv pv-' + t.id); pv.append(el('i'), el('i'));
    b.append(pv, el('b', '', t.name), el('small', '', t.desc));
    b.onclick = () => { S.theme = t.id; save(); applyTheme(); renderThemes(); };
    box.append(b);
  });
}

/* ---------- tampilan umum ---------- */
function avatar(id, big) {
  const p = TC.PERSONAS[id];
  const a = el('div', 'av' + (big ? ' big' : ''), p.name[0]);
  a.style.background = 'linear-gradient(135deg,' + p.hue + ',#3b3a78)';
  return a;
}
function showView(v) {
  view = v;
  ['list', 'chat', 'theme', 'set'].forEach((x) => { $('#v-' + x).hidden = x !== v; });
  $('#nav').hidden = v === 'chat';
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'list') renderList();
  if (v === 'theme') renderThemes();
  if (v === 'set') renderSettings();
}
document.querySelectorAll('#nav button').forEach((b) => { b.onclick = () => { closePops(); showView(b.dataset.v); }; });
function closePops() { $('#menu').hidden = true; $('#emo').hidden = true; $('#sheet').hidden = true; }

/* ---------- daftar chat ---------- */
let tab = 'all', query = '';
function lastOf(id) { const m = chat(id).msgs.filter((x) => x.role === 'user' || x.role === 'ai').pop(); return m || null; }
function renderList() {
  const sg = suggested();
  const row = $('#avrow'); row.innerHTML = '';
  IDS.forEach((id) => {
    const b = el('button', 'avc'); const a = avatar(id, true); if (id === sg) a.classList.add('hl');
    b.append(a, el('span', '', TC.PERSONAS[id].name)); if (id === sg) b.append(el('span', 'badge', 'Disarankan'));
    b.onclick = () => openChat(id); row.append(b);
  });
  const tabs = $('#tabs'); tabs.innerHTML = '';
  [['all', 'Semua'], ['fav', 'Favorit'], ['new', 'Baru']].forEach(([k, l]) => {
    const b = el('button', tab === k ? 'on' : '', l); b.setAttribute('role', 'tab'); b.onclick = () => { tab = k; renderList(); }; tabs.append(b);
  });
  const list = $('#chats'); list.innerHTML = '';
  const q = query.trim().toLowerCase();
  const ids = IDS.filter((id) => {
    const c = chat(id), l = lastOf(id);
    if (tab === 'fav' && !c.fav) return false;
    if (tab === 'new' && !c.unread) return false;
    if (q && !(TC.PERSONAS[id].name.toLowerCase().includes(q) || c.msgs.some((m) => m.text && m.text.toLowerCase().includes(q)))) return false;
    return true;
  }).sort((a, b) => ((lastOf(b) || { t: 0 }).t) - ((lastOf(a) || { t: 0 }).t));
  if (!ids.length) list.append(el('div', 'empty', tab === 'fav' ? 'Belum ada favorit.' : tab === 'new' ? 'Tidak ada pesan baru.' : 'Tidak ada yang cocok.'));
  ids.forEach((id) => {
    const c = chat(id), l = lastOf(id), p = TC.PERSONAS[id];
    const r = el('button', 'crow'); r.append(avatar(id));
    const mid = el('div', 'mid'), top = el('div', 'top');
    top.append(el('b', '', p.name + (c.fav ? ' ★' : '')), el('span', 'tag', 'AI · ' + TC.styleOf(id, c.style).label), el('span', 'tm', l ? hm(l.t) : ''));
    mid.append(top, el('div', 'pv', l ? (l.role === 'user' ? 'Kamu: ' : '') + l.text : 'Ketuk untuk mulai ngobrol'));
    r.append(mid); if (c.unread) r.append(el('span', 'un', String(c.unread)));
    r.onclick = () => openChat(id); list.append(r);
  });
}
$('#srch').onclick = () => { const b = $('#sbox'); b.hidden = !b.hidden; if (!b.hidden) $('#q').focus(); else { query = ''; $('#q').value = ''; renderList(); } };
$('#q').addEventListener('input', () => { query = $('#q').value; renderList(); });

/* ---------- suara balasan (voice note) ---------- */
let playing = null;
let audioEl = null, ttsCtl = null, playToken = 0;
const ttsCache = new Map(); // kunci -> Blob suara; menyimpan beberapa suara terakhir supaya putar ulang cepat
function stopSpeak() {
  playToken++;
  if (ttsCtl) { try { ttsCtl.abort(); } catch (e) { /* abaikan */ } ttsCtl = null; }
  if (audioEl) { try { audioEl.pause(); } catch (e) { /* abaikan */ } audioEl = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (playing) { playing.classList.remove('playing', 'loading'); playing = null; }
}
function cleanForSpeech(text) { return text.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '').trim(); }

// Suara bawaan HP (cadangan kalau suara AI gagal atau tidak ada koneksi)
function speakDevice(text, id, onend) {
  if (!('speechSynthesis' in window)) { if (onend) onend(); return; }
  const clean = cleanForSpeech(text);
  if (!clean) { if (onend) onend(); return; }
  const tts = TC.styleOf(id, chat(id).style).tts;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'id-ID';
  const vs = speechSynthesis.getVoices().filter((v) => /^id/i.test(v.lang));
  const g = TC.PERSONAS[id].voice;
  const v = g === 'male' ? vs.find((x) => /male/i.test(x.name) && !/female/i.test(x.name)) : g === 'female' ? vs.find((x) => /female|gadis|damayanti/i.test(x.name)) : null;
  if (v || vs[0]) u.voice = v || vs[0];
  const adj = g === 'male' ? 0.9 : 1; // suara cowok sedikit lebih rendah
  u.pitch = Math.max(0, Math.min(2, tts.pitch * adj)); u.rate = tts.rate; u.volume = tts.volume;
  u.onend = u.onerror = () => { if (onend) onend(); };
  speechSynthesis.speak(u);
}

// Suara AI yang natural (dibuat di server). Kalau gagal, otomatis pakai suara bawaan HP.
// row (opsional) = baris voice note yang diberi tanda "memuat" selama suara dibuat.
async function speak(text, id, onend, row) {
  const clean = cleanForSpeech(text);
  if (!clean) { if (onend) onend(); return; }
  const style = chat(id).style || '';
  const key = id + '|' + style + '|' + clean;
  const token = ++playToken;
  let finished = false;
  const done = () => { if (finished) return; finished = true; if (onend) onend(); };
  const fallback = () => { if (token === playToken) speakDevice(clean, id, done); else done(); };
  try {
    let blob = ttsCache.get(key);
    if (!blob) {
      if (row) row.classList.add('loading');
      ttsCtl = new AbortController();
      const to = setTimeout(() => { if (ttsCtl) ttsCtl.abort(); }, 28000);
      let r;
      try {
        r = await fetch(TTS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: id, style, text: clean.slice(0, 600) }), signal: ttsCtl.signal });
      } finally { clearTimeout(to); }
      if (!r.ok) throw new Error('tts ' + r.status);
      blob = await r.blob();
      if (!blob.size) throw new Error('kosong');
      ttsCache.set(key, blob);
      if (ttsCache.size > 12) ttsCache.delete(ttsCache.keys().next().value);
    }
    if (row) row.classList.remove('loading');
    if (token !== playToken) { done(); return; } // dihentikan atau diganti saat memuat
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    audioEl = a;
    const end = () => { URL.revokeObjectURL(url); if (audioEl === a) audioEl = null; done(); };
    a.onended = end;
    a.onerror = () => { URL.revokeObjectURL(url); if (audioEl === a) audioEl = null; fallback(); };
    await a.play();
  } catch (e) {
    if (row) row.classList.remove('loading');
    if (token !== playToken) { done(); return; }
    fallback();
  }
}
function waveBars(text, n) {
  let h = 7; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  const bars = el('div', 'bars');
  for (let i = 0; i < n; i++) { h = (h * 1103515245 + 12345) >>> 0; const b = el('i'); b.style.height = (6 + ((h >>> 16) % 22)) + 'px'; bars.append(b); }
  return bars;
}
function vnBubble(m, id) {
  const d = el('div', 'b ai');
  const row = el('div', 'vn');
  const pl = el('button', 'pl'); pl.setAttribute('aria-label', 'Putar voice note'); pl.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const rate = TC.styleOf(id, chat(id).style).tts.rate;
  const dur = el('span', 'dur', Math.max(2, Math.round(m.text.length / (14 * rate))) + '″');
  const tg = el('button', 'tg', 'teks');
  row.append(pl, waveBars(m.text, 20), dur, tg);
  const tx = el('div', 'tx', m.text); tx.hidden = true;
  tg.onclick = () => { tx.hidden = !tx.hidden; };
  pl.onclick = () => {
    if (playing === row) { stopSpeak(); return; }
    stopSpeak(); playing = row; row.classList.add('playing');
    speak(m.text, id, () => { if (playing === row) { row.classList.remove('playing', 'loading'); playing = null; } }, row);
  };
  d.append(row, tx, tick(m, false)); d.vnRow = row;
  return d;
}

/* ---------- gelembung ---------- */
const log = $('#log');
const scrollDown = () => { log.scrollTop = log.scrollHeight; };
function tick(m, read) {
  const s = el('small'); s.append(el('span', '', hm(m.t)));
  if (m.role === 'user') { const t = el('span', 'tick', read ? '✓✓' : '✓'); s.append(t); }
  return s;
}
function dayLabel(t) {
  const d = new Date(t), n = new Date();
  const k = (x) => x.getFullYear() * 400 + x.getMonth() * 32 + x.getDate();
  const y = new Date(n); y.setDate(n.getDate() - 1);
  const base = k(d) === k(n) ? 'Hari ini' : k(d) === k(y) ? 'Kemarin' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  return base + ' ' + hm(t);
}
function addBubble(m, id, read) {
  let d;
  if (m.role === 'notice') {
    d = el('div', 'notice'); TC.CRISIS_NOTICE.forEach((t) => d.append(el('p', '', t)));
  } else if (m.role === 'ai' && chat(id).voice) {
    d = vnBubble(m, id);
  } else {
    d = el('div', 'b ' + (m.role === 'user' ? 'me' : 'ai'));
    if (m.vn) d.append(el('span', 'tagv', '🎤 pesan suara'));
    d.append(el('span', '', m.text), tick(m, read));
  }
  log.append(d); scrollDown();
  return d;
}
function showTyping() { const d = el('div', 'b ai'); d.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'; log.append(d); scrollDown(); return d; }
function markRead() { log.querySelectorAll('.tick').forEach((t) => { t.textContent = '✓✓'; }); }

/* ---------- layar chat ---------- */
function setStatus(kind) {
  const s = $('#st'); const live = kind && kind !== 'idle';
  s.textContent = !navigator.onLine ? 'Offline' : ({ wait: 'membaca pesanmu…', hold: 'menunggu kamu selesai mengetik…', think: 'menganalisa ceritamu…', type: 'mengetik…' }[kind] || 'Teman AI · bukan manusia');
  s.classList.toggle('live', !!live && navigator.onLine);
}
function renderChat() {
  const id = S.cur, c = chat(id), p = TC.PERSONAS[id];
  const av = $('#av'); av.textContent = p.name[0]; av.style.background = 'linear-gradient(135deg,' + p.hue + ',#3b3a78)';
  $('#nm').textContent = p.name;
  $('#vbtn').setAttribute('aria-pressed', c.voice); $('#vbtn').classList.toggle('on', c.voice);
  $('#m-fav').textContent = c.fav ? 'Hapus dari favorit' : 'Tandai favorit';
  log.innerHTML = '';
  let prevDay = '';
  const lastAi = c.msgs.map((m) => m.role).lastIndexOf('ai');
  c.msgs.forEach((m, i) => {
    const lab = dayLabel(m.t), dk = new Date(m.t).toDateString();
    if (dk !== prevDay) { prevDay = dk; log.append(el('div', 'day', lab)); }
    addBubble(m, id, i < lastAi);
  });
  setStatus(waitT || inflight ? 'wait' : 'idle');
  scrollDown();
}
function greeting(id) {
  const n = S.nick ? ' ' + S.nick : '';
  return ({
    nara: 'Hai' + n + '! Aku Nara, teman AI yang siap dengerin kamu 🤍 Mau cerita apa hari ini? Pelan-pelan aja ya.',
    raka: 'Hai' + n + '. Aku Raka, teman AI. Aku di sini kok, nggak buru-buru. Mau cerita apa?',
    sena: 'Halo' + n + '. Aku Sena, teman AI yang siap mendengarkan. Apa yang sedang kamu pikirkan hari ini?'
  })[id];
}
function openChat(id) {
  closePops();
  S.cur = id; const c = chat(id); c.unread = 0;
  if (!c.msgs.length) c.msgs.push({ role: 'ai', t: Date.now(), text: greeting(id) });
  save(); showView('chat'); renderChat();
  const last = c.msgs[c.msgs.length - 1];
  if (last && last.role === 'user' && !waitT && !inflight) showError({ message: 'pending' }, false, id);
}
$('#back').onclick = () => { closePops(); stopSpeak(); S.cur = null; showView('list'); };

/* ---------- AI: menunggu, menganalisa, membalas ---------- */
let waitT = null, waitStart = 0, lastKey = 0, token = 0, inflight = null, typEl = null, replyId = null;
const userTyping = () => Date.now() - lastKey < 1500 || (document.activeElement === $('#inp') && $('#inp').value.trim().length > 0);

function cancelReply() {
  token++; clearTimeout(waitT); waitT = null;
  if (inflight) { inflight.abort(); inflight = null; }
  if (typEl) { typEl.remove(); typEl = null; }
}
function scheduleReply() {
  cancelReply(); replyId = S.cur; waitStart = Date.now();
  setStatus('wait'); waitT = setTimeout(maybeReply, WAIT_MS);
}
function maybeReply() {
  waitT = null;
  if (userTyping() && Date.now() - waitStart < WAIT_MAX) { setStatus('hold'); waitT = setTimeout(maybeReply, 900); return; }
  doReply();
}
async function askAI(id, ctl) {
  const c = chat(id);
  const hist = c.msgs.filter((m) => m.role === 'user' || m.role === 'ai').slice(-20).map((m) => ({ role: m.role, text: m.text }));
  if (!navigator.onLine) throw new Error('offline');
  const to = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: id, style: c.style, nick: S.nick, messages: hist }), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error('rate');
    if (!r.ok || typeof j.text !== 'string') throw new Error('server');
    return j.text;
  } finally { clearTimeout(to); }
}
function showError(e, crisis, id) {
  if (S.cur !== id || view !== 'chat') return;
  const map = { offline: 'Tidak ada koneksi internet.', rate: 'Terlalu banyak pesan. Tunggu sebentar lalu coba lagi.', pending: 'Balasan terakhir belum selesai.' };
  const why = (e && map[e.message]) || (e && e.name === 'AbortError' ? 'AI terlalu lama menjawab.' : 'AI sedang tidak bisa dihubungi.');
  if (crisis) { const n = { role: 'notice', t: Date.now() }; addBubble(n, id); }
  const d = el('div', 'notice err'); d.append(el('p', '', why + ' Pesanmu tersimpan, kamu bisa kirim ulang.'));
  const b = el('button', 'retry', 'Kirim ulang');
  b.onclick = () => { d.remove(); cancelReply(); replyId = id; doReply(); };
  d.append(b); log.append(d); scrollDown();
}
async function doReply() {
  const id = replyId; if (!id) return;
  const my = token, c = chat(id);
  const lastUser = c.msgs.slice().reverse().find((m) => m.role === 'user');
  const crisis = lastUser ? TC.detectCrisis(lastUser.text) : false;
  const here = () => S.cur === id && view === 'chat';
  const ctl = new AbortController(); inflight = ctl;
  setStatus('think'); if (here()) typEl = showTyping();
  try {
    const raw = await askAI(id, ctl);
    if (my !== token) return;
    inflight = null; if (typEl) { typEl.remove(); typEl = null; }
    const parts = String(raw).split('|||').map((s) => s.trim()).filter(Boolean).slice(0, 3);
    if (!parts.length) throw new Error('server');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        setStatus('type'); if (here()) typEl = showTyping();
        await sleep(Math.min(1500, 500 + parts[i].length * 20));
        if (my !== token) return;
        if (typEl) { typEl.remove(); typEl = null; }
      }
      const am = { role: 'ai', text: parts[i], t: Date.now() };
      c.msgs.push(am);
      if (here()) { addBubble(am, id); markRead(); if (c.voice) { const row = log.lastChild && log.lastChild.vnRow; if (row) { stopSpeak(); playing = row; row.classList.add('playing'); speak(am.text, id, () => { if (playing === row) { row.classList.remove('playing', 'loading'); playing = null; } }, row); } } }
      else c.unread++;
      save();
    }
    if (crisis) { const n = { role: 'notice', t: Date.now() }; c.msgs.push(n); save(); if (here()) addBubble(n, id); }
  } catch (e) {
    if (my !== token) return;
    if (typEl) { typEl.remove(); typEl = null; }
    showError(e, crisis, id);
  } finally {
    if (my === token) { inflight = null; if (typEl) { typEl.remove(); typEl = null; } setStatus('idle'); }
  }
}

/* ---------- mengirim ---------- */
function send(text, vn) {
  text = (text || '').trim().slice(0, 2000);
  if (!text || !S.cur) return;
  const c = chat(S.cur);
  log.querySelectorAll('.notice.err').forEach((n) => n.remove());
  const um = { role: 'user', text, t: Date.now(), vn: !!vn };
  c.msgs.push(um); save(); addBubble(um, S.cur, false);
  $('#inp').value = ''; grow();
  scheduleReply(); // AI menunggu sebentar; mengetik lagi memperpanjang tunggu, pesan baru menggantikan balasan yang sedang disiapkan
}
function grow() { const i = $('#inp'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; }
$('#send').onclick = () => { send($('#inp').value); $('#inp').focus(); };
$('#inp').addEventListener('input', () => { lastKey = Date.now(); grow(); if (waitT) { setStatus('hold'); } });
$('#inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#inp').value); } });

/* ---------- menu chat dan pilihan gaya ---------- */
$('#vbtn').onclick = () => { const c = chat(S.cur); c.voice = !c.voice; if (!c.voice) stopSpeak(); save(); renderChat(); };
$('#mbtn').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
$('#m-fav').onclick = () => { const c = chat(S.cur); c.fav = !c.fav; save(); $('#menu').hidden = true; renderChat(); };
let armed = false;
$('#m-clear').onclick = () => {
  const b = $('#m-clear');
  if (!armed) { armed = true; b.textContent = 'Yakin? Tekan lagi'; setTimeout(() => { armed = false; b.textContent = 'Hapus chat ini'; }, 3500); return; }
  armed = false; b.textContent = 'Hapus chat ini'; cancelReply(); stopSpeak();
  const c = chat(S.cur); c.msgs = []; c.unread = 0; $('#menu').hidden = true;
  c.msgs.push({ role: 'ai', t: Date.now(), text: greeting(S.cur) }); save(); renderChat();
};
function styleChips(box, id, after) {
  box.innerHTML = '';
  Object.values(TC.STYLES).forEach((st) => {
    const b = el('button', 'chip' + (chat(id).style === st.id ? ' on' : ''), st.label);
    b.onclick = () => { chat(id).style = st.id; save(); after(); };
    box.append(b);
  });
}
function renderSheet() {
  const id = S.cur, st = TC.styleOf(id, chat(id).style);
  $('#sheet-for').textContent = 'Untuk chat dengan ' + TC.PERSONAS[id].name + '. Mengubah cara AI menulis dan suara voice note.';
  styleChips($('#sheet-chips'), id, renderSheet);
  $('#sheet-desc').textContent = st.label + ': ' + st.desc;
}
$('#m-style').onclick = () => { $('#menu').hidden = true; renderSheet(); $('#sheet').hidden = false; };
$('#sheet-close').onclick = $('#sheet-bg').onclick = () => { stopSpeak(); $('#sheet').hidden = true; };
$('#sheet-try').onclick = () => { stopSpeak(); speak(TC.styleOf(S.cur, chat(S.cur).style).sample, S.cur); };

/* ---------- emoji ---------- */
['🙂', '😊', '😢', '😭', '🥺', '😔', '😞', '😡', '😤', '😮‍💨', '😅', '😂', '🤗', '❤️', '🫶', '🙏', '👍', '💪', '🌧️', '☀️', '🌙', '✨', '☕', '🍀'].forEach((e) => {
  const b = el('button', '', e); b.onclick = () => { const i = $('#inp'); i.value += e; lastKey = Date.now(); i.focus(); grow(); }; $('#emo').append(b);
});
$('#ebtn').onclick = () => { $('#emo').hidden = !$('#emo').hidden; };

/* ---------- merekam suara (jika perangkat mendukung pengenalan suara) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { $('#mic').hidden = true; } else {
  let rec = null, timer = null, t0 = 0, cancelled = false, heard = '';
  const wave = $('#wave');
  const endRec = () => { clearInterval(timer); timer = null; $('#rec').hidden = true; $('#bar').hidden = false; $('#mic').classList.remove('on'); };
  $('#mic').onclick = () => {
    if (rec) return;
    rec = new SR(); rec.lang = 'id-ID'; rec.interimResults = true; heard = ''; cancelled = false;
    rec.onresult = (e) => { heard = Array.from(e.results).map((r) => r[0].transcript).join(' '); };
    rec.onerror = () => {};
    rec.onend = () => { const h = heard; rec = null; endRec(); if (!cancelled && h.trim()) send(h, true); };
    wave.innerHTML = ''; for (let i = 0; i < 48; i++) wave.append(el('i'));
    t0 = Date.now(); $('#bar').hidden = true; $('#rec').hidden = false; $('#mic').classList.add('on');
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000); $('#rec-t').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      const kids = wave.children; for (let i = 0; i < kids.length - 1; i++) kids[i].style.height = kids[i + 1].style.height;
      kids[kids.length - 1].style.height = (4 + Math.random() * 22) + 'px';
    }, 110);
    try { rec.start(); } catch (e) { rec = null; endRec(); }
  };
  $('#rec-send').onclick = () => { if (rec) rec.stop(); };
  $('#rec-del').onclick = () => { cancelled = true; if (rec) rec.stop(); else endRec(); };
}

/* ---------- pengaturan ---------- */
function renderSettings() {
  $('#nick').value = S.nick;
  const box = $('#setstyles'); box.innerHTML = '';
  IDS.forEach((id) => {
    const r = el('div', 'srow'); r.append(avatar(id), el('b', '', TC.PERSONAS[id].name));
    const chips = el('div', 'chips'); r.append(chips); box.append(r);
    styleChips(chips, id, renderSettings);
  });
}
$('#nick').addEventListener('change', () => { S.nick = $('#nick').value.trim().slice(0, 30); save(); });
let armedAll = false;
$('#clr').onclick = () => {
  const b = $('#clr');
  if (!armedAll) { armedAll = true; b.textContent = 'Yakin? Tekan lagi untuk menghapus semua'; setTimeout(() => { armedAll = false; b.textContent = 'Hapus semua riwayat'; }, 4000); return; }
  armedAll = false; b.textContent = 'Hapus semua riwayat'; cancelReply(); stopSpeak();
  IDS.forEach((id) => { chat(id).msgs = []; chat(id).unread = 0; }); save();
};

/* ---------- selamat datang ---------- */
let gSel = '';
function renderGender() {
  const g = $('#gen'); g.innerHTML = '';
  [['pria', 'Pria'], ['wanita', 'Wanita'], ['lainnya', 'Lainnya']].forEach(([k, l]) => {
    const b = el('button', 'chip' + (gSel === k ? ' on' : ''), l); b.onclick = () => { gSel = gSel === k ? '' : k; renderGender(); }; g.append(b);
  });
}
$('#go').onclick = () => {
  S.nick = $('#nick2').value.trim().slice(0, 30); S.gender = gSel; S.onboarded = true; save();
  $('#setup').hidden = true; showView('list');
};

/* ---------- mulai, jaringan, tombol kembali Android ---------- */
applyTheme();
if (!S.onboarded) { renderGender(); $('#setup').hidden = false; }
showView('list');
window.addEventListener('offline', () => { if (view === 'chat') setStatus('idle'); });
window.addEventListener('online', () => { if (view === 'chat') setStatus('idle'); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeak(); else scrollDown(); });
const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (capApp && capApp.addListener) {
  capApp.addListener('backButton', () => {
    if (!$('#sheet').hidden) $('#sheet').hidden = true;
    else if (!$('#menu').hidden) $('#menu').hidden = true;
    else if (!$('#emo').hidden) $('#emo').hidden = true;
    else if (view === 'chat') $('#back').click();
    else if (view !== 'list') showView('list');
    else if (capApp.minimizeApp) capApp.minimizeApp();
  });
}
