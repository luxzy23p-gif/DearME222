// Menyesuaikan proyek Android hasil `npx cap add android`. Aman dijalankan berulang (idempoten).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
const gradlePath = 'android/app/build.gradle';
for (const p of [manifestPath, gradlePath]) if (!existsSync(p)) { console.error(`::error::${p} tidak ditemukan. Jalankan "npx cap add android" dulu.`); process.exit(1); }

let m = readFileSync(manifestPath, 'utf8');
const app = m.match(/<application\b[^>]*>/);
if (!app) { console.error('::error::Tag <application> tidak ditemukan di AndroidManifest.xml'); process.exit(1); }
let tag = app[0];
const setAttr = (t, name, val) => (new RegExp(`android:${name}="[^"]*"`).test(t) ? t.replace(new RegExp(`android:${name}="[^"]*"`), `android:${name}="${val}"`) : t.replace('<application', `<application android:${name}="${val}"`));
tag = setAttr(tag, 'allowBackup', 'false');          // riwayat chat tidak ikut backup cloud
tag = setAttr(tag, 'usesCleartextTraffic', 'false'); // wajib HTTPS
m = m.replace(app[0], tag);
for (const perm of ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE']) {
  if (!m.includes(`android:name="${perm}"`)) m = m.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
writeFileSync(manifestPath, m);

let g = readFileSync(gradlePath, 'utf8');
const run = process.env.GITHUB_RUN_NUMBER || '1';
g = g.replace(/versionCode\s+\d+/, `versionCode ${run}`).replace(/versionName\s+"[^"]*"/, `versionName "1.0.${run}"`);
writeFileSync(gradlePath, g);
console.log('Android dikonfigurasi: allowBackup=false, cleartext=false, versionCode=' + run);
