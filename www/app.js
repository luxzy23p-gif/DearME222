
const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const API = ((window.DEARME_CONFIG && window.DEARME_CONFIG.API_BASE) || '').replace(/\/+$/, '') + '/api/chat';
const hasPersona = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(TC.PERSONAS, id);
let S = store.get('tc1', null);
if (!S || typeof S !== 'object' || !Array.isArray(S.msgs) || (S.persona !== null && !hasPersona(S.persona))) S = { persona: null, nick: '', msgs: [], voice: false };
S.msgs = S.msgs.filter((m) => m && (m.role === 'notice' || ((m.role === 'user' || m.role === 'ai') && typeof m.text === 'string'))).slice(-500);
S.nick = typeof S.nick === 'string' ? S.nick.slice(0, 30) : '';
S.voice = !!S.voice;
const save = () => { S.msgs = S.msgs.slice(-500); store.set('tc1', S); };
const P = () => (hasPersona(S.persona) ? TC.PERSONAS[S.persona] : TC.PERSONAS.sena);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = $('#log');
let busy = false;

function hm(t) { return new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function scrollDown() { log.scrollTop = log.scrollHeight; }

/* ---------- suara (balasan) ---------- */
function speak(text, queue) {
  if (!('speechSynthesis' in window)) return;
  if (!queue) speechSynthesis.cancel();
  const clean = text.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '');
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'id-ID';
  const vs = speechSynthesis.getVoices().filter((v) => /^id/i.test(v.lang));
  const v = P().voice === 'male' ? vs.find((x) => /male/i.test(x.name) && !/female/i.test(x.name)) : P().voice === 'female' ? vs.find((x) => /female|gadis|damayanti/i.test(x.name)) : null;
  if (v || vs[0]) u.voice = v || vs[0];
  u.pitch = P().voice === 'male' ? 0.8 : P().voice === 'female' ? 1.15 : 1;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

/* ---------- gelembung ---------- */
function addBubble(m) {
  let d;
  if (m.role === 'notice' || m.role === 'error') {
    d = el('div', 'notice');
    (m.role === 'error' ? [m.text] : TC.CRISIS_NOTICE).forEach((t) => d.append(el('p', '', t)));
  } else if (m.role === 'ai' && S.voice) {
    d = el('div', 'b ai');
    const row = el('div', 'vn');
    const pl = el('button', 'pl', '▶'); pl.setAttribute('aria-label', 'Putar suara'); pl.onclick = () => speak(m.text);
    const bars = el('div', 'bars');
    for (let i = 0; i < 18; i++) { const b = el('i'); b.style.height = 6 + ((m.text.length * (i + 3)) % 20) + 'px'; bars.append(b); }
    const dur = el('span', '', Math.max(2, Math.round(m.text.length / 14)) + '″');
    const tg = el('button', 'tg', 'teks');
    row.append(pl, bars, dur, tg);
    const tx = el('div', 'tx', m.text); tx.hidden = true;
    tg.onclick = () => { tx.hidden = !tx.hidden; };
    d.append(row, tx, el('small', '', hm(m.t)));
  } else {
    d = el('div', 'b ' + (m.role === 'user' ? 'me' : 'ai'));
    if (m.vn) d.append(el('span', 'tag', '🎤 pesan suara'));
    d.append(el('span', '', m.text), el('small', '', hm(m.t)));
  }
  log.append(d); scrollDown();
  return d;
}
function showTyping() { const d = el('div', 'b ai'); d.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'; log.append(d); scrollDown(); return d; }

/* ---------- AI ---------- */
async function askAI() {
  const hist = S.msgs.filter((m) => m.role === 'user' || m.role === 'ai').slice(-20).map((m) => ({ role: m.role, text: m.text }));
  if (!navigator.onLine) throw new Error('offline');
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: S.persona, nick: S.nick, messages: hist }), signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error('rate');
    if (!r.ok || typeof j.text !== 'string') throw new Error('server');
    return j.text;
  } finally { clearTimeout(to); }
}

function showError(e, crisis) {
  const map = { offline: 'Tidak ada koneksi internet.', rate: 'Terlalu banyak pesan. Tunggu sebentar lalu coba lagi.', pending: 'Balasan terakhir belum selesai.' };
  const why = (e && map[e.message]) || (e && e.name === 'AbortError' ? 'AI terlalu lama menjawab.' : 'AI sedang tidak bisa dihubungi.');
  if (crisis) addBubble({ role: 'notice', t: Date.now() });
  const d = addBubble({ role: 'error', text: why + ' Pesanmu tersimpan, kamu bisa kirim ulang.' });
  const b = el('button', 'retry', 'Kirim ulang');
  b.onclick = () => { d.remove(); reply(); };
  d.append(b);
}

async function send(text, vn) {
  text = (text || '').trim().slice(0, 2000);
  if (!text || busy) return;
  const um = { role: 'user', text, t: Date.now(), vn: !!vn };
  S.msgs.push(um); save(); addBubble(um);
  $('#inp').value = ''; grow();
  await reply();
}

async function reply() {
  if (busy) return;
  busy = true; $('#send').disabled = true;
  const lastUser = S.msgs.slice().reverse().find((m) => m.role === 'user');
  const crisis = lastUser ? TC.detectCrisis(lastUser.text) : false;
  let typ = null;
  try {
    $('#st').textContent = 'mengetik…'; typ = showTyping();
    const raw = await askAI();
    typ.remove(); typ = null;
    const parts = String(raw).split('|||').map((s) => s.trim()).filter(Boolean).slice(0, 3);
    if (!parts.length) throw new Error('server');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) { typ = showTyping(); await sleep(Math.min(1500, 500 + parts[i].length * 20)); typ.remove(); typ = null; }
      const am = { role: 'ai', text: parts[i], t: Date.now() };
      S.msgs.push(am); save(); addBubble(am);
      if (S.voice) speak(parts[i], i > 0);
    }
    if (crisis) { const n = { role: 'notice', t: Date.now() }; S.msgs.push(n); save(); addBubble(n); }
  } catch (e) {
    if (typ) typ.remove();
    showError(e, crisis);
  } finally {
    busy = false; $('#send').disabled = false; $('#st').textContent = navigator.onLine ? 'Teman AI · bukan manusia' : 'Offline';
  }
}

/* ---------- tampilan ---------- */
function renderAll() {
  const p = P();
  $('#nm').textContent = S.persona ? p.name : 'DearMe';
  $('#av').textContent = S.persona ? p.name[0] : 'T';
  $('#av').style.background = S.persona ? p.hue : '#7a6bb0';
  $('#vbtn').textContent = S.voice ? '🔊' : '🔈';
  $('#vbtn').setAttribute('aria-pressed', S.voice);
  log.innerHTML = '';
  S.msgs.forEach(addBubble);
}
function grow() { const i = $('#inp'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; }

/* ---------- setup ---------- */
let tmp = { g: null, p: null };
function renderSetup() {
  const g = $('#gen'); g.innerHTML = '';
  [['pria', 'Pria'], ['wanita', 'Wanita'], ['lainnya', 'Lainnya']].forEach(([k, l]) => {
    const b = el('button', 'chip' + (tmp.g === k ? ' on' : ''), l);
    b.onclick = () => { tmp.g = k; tmp.p = TC.DEFAULT_FOR[k]; renderSetup(); };
    g.append(b);
  });
  const pr = $('#pers'); pr.innerHTML = '';
  Object.values(TC.PERSONAS).forEach((x) => {
    const b = el('button', 'card' + (tmp.p === x.id ? ' on' : ''), x.name + ' · ' + x.label);
    b.onclick = () => { tmp.p = x.id; renderSetup(); };
    pr.append(b);
  });
  $('#go').disabled = !tmp.p;
}
function openSetup() { tmp = { g: null, p: S.persona }; $('#nick').value = S.nick || ''; renderSetup(); $('#setup').hidden = false; }
$('#go').onclick = () => {
  const nick = $('#nick').value.trim().slice(0, 30);
  if (S.persona !== tmp.p) S.msgs = [];
  S.persona = tmp.p; S.nick = nick;
  if (!S.msgs.length) S.msgs.push({ role: 'ai', t: Date.now(), text: 'Hai' + (nick ? ' ' + nick : '') + '! Aku ' + P().name + ', teman AI yang siap mendengarkan. Mau cerita apa hari ini? Pelan-pelan saja ya 🙂' });
  save(); $('#setup').hidden = true; renderAll();
};

/* ---------- kontrol ---------- */
$('#send').onclick = () => send($('#inp').value);
$('#inp').addEventListener('input', grow);
$('#inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('#inp').value); } });
$('#vbtn').onclick = () => { S.voice = !S.voice; if (!S.voice && 'speechSynthesis' in window) speechSynthesis.cancel(); save(); renderAll(); };
$('#mbtn').onclick = () => { $('#menu').hidden = !$('#menu').hidden; $('#clr').textContent = 'Hapus semua riwayat'; };
$('#chg').onclick = () => { $('#menu').hidden = true; openSetup(); };
let armed = false;
$('#clr').onclick = () => {
  if (!armed) { armed = true; $('#clr').textContent = 'Yakin? Tekan lagi untuk menghapus'; setTimeout(() => { armed = false; }, 4000); return; }
  armed = false; store.del('tc1'); S = { persona: null, nick: '', msgs: [], voice: false };
  $('#menu').hidden = true; renderAll(); openSetup();
};
const emos = ['🙂', '😊', '😢', '😭', '🥺', '😔', '😞', '😡', '😤', '😮‍💨', '😅', '😂', '🤗', '❤️', '🫶', '🙏', '👍', '💪', '🌧️', '☀️', '🌙', '✨', '☕', '🍀'];
emos.forEach((e) => { const b = el('button', '', e); b.onclick = () => { const i = $('#inp'); i.value += e; i.focus(); grow(); }; $('#emo').append(b); });
$('#ebtn').onclick = () => { $('#emo').hidden = !$('#emo').hidden; };

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) { $('#mic').hidden = true; } else {
  let rec = null, on = false;
  $('#mic').onclick = () => {
    if (on) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'id-ID'; rec.interimResults = true;
    let heard = '';
    rec.onresult = (e) => { heard = Array.from(e.results).map((r) => r[0].transcript).join(' '); $('#inp').value = heard; grow(); };
    rec.onerror = () => {};
    rec.onend = () => { on = false; $('#mic').classList.remove('rec'); if (heard.trim()) send(heard, true); };
    on = true; $('#mic').classList.add('rec');
    try { rec.start(); } catch (e) { on = false; $('#mic').classList.remove('rec'); }
  };
}

renderAll();
if (!S.persona) openSetup();
else { const last = S.msgs[S.msgs.length - 1]; if (last && last.role === 'user') showError({ message: 'pending' }, false); }

/* ---------- jaringan, latar belakang, tombol kembali Android ---------- */
window.addEventListener('offline', () => { $('#st').textContent = 'Offline'; });
window.addEventListener('online', () => { $('#st').textContent = 'Teman AI · bukan manusia'; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if ('speechSynthesis' in window) speechSynthesis.cancel(); } else { scrollDown(); }
});
const capApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
if (capApp && capApp.addListener) {
  capApp.addListener('backButton', () => {
    if (!$('#menu').hidden) $('#menu').hidden = true;
    else if (!$('#emo').hidden) $('#emo').hidden = true;
    else if (!$('#setup').hidden && S.persona) $('#setup').hidden = true;
    else if (capApp.minimizeApp) capApp.minimizeApp();
  });
}
