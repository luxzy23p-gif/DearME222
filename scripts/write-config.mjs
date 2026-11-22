// Menulis www/config.js dengan alamat backend produksi. Dipakai saat build APK.
import { writeFileSync } from 'node:fs';

const base = (process.env.API_BASE || '').trim().replace(/\/+$/, '');
const fail = (m) => { console.error('::error::' + m); process.exit(1); };

if (!base) fail('Variabel repo DEARME_API_BASE belum diisi. Isi dengan alamat backend HTTPS, misalnya https://dearme-api.example.com (Settings > Secrets and variables > Actions > Variables).');
let u;
try { u = new URL(base); } catch { fail('DEARME_API_BASE bukan URL yang valid: ' + base); }
if (u.protocol !== 'https:') fail('DEARME_API_BASE harus memakai https://');
if (/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(u.hostname) || u.hostname.endsWith('.local')) fail('DEARME_API_BASE tidak boleh localhost atau alamat jaringan lokal.');

writeFileSync('www/config.js', `window.DEARME_CONFIG = ${JSON.stringify({ API_BASE: u.origin + u.pathname.replace(/\/+$/, '') })};\n`);
console.log('config.js ditulis untuk', u.origin);
