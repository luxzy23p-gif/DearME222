// Memasang ikon aplikasi DearMe ke proyek Android hasil `npx cap add android`. Aman dijalankan berulang.
import { cpSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const res = 'android/app/src/main/res';
if (!existsSync(res)) { console.error(`::error::${res} tidak ditemukan. Jalankan "npx cap add android" dulu.`); process.exit(1); }

let n = 0;
for (const d of readdirSync('assets/icon').filter((x) => x.startsWith('mipmap-'))) {
  mkdirSync(`${res}/${d}`, { recursive: true });
  for (const [from, to] of [['ic_launcher.png', 'ic_launcher.png'], ['ic_launcher_round.png', 'ic_launcher_round.png'], ['dearme_fg.png', 'dearme_fg.png']]) {
    cpSync(`assets/icon/${d}/${from}`, `${res}/${d}/${to}`); n++;
  }
}
mkdirSync(`${res}/values`, { recursive: true });
writeFileSync(`${res}/values/dearme_icon.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="dearme_icon_bg">#08070C</color>\n</resources>\n');
const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/dearme_icon_bg"/>\n    <foreground android:drawable="@mipmap/dearme_fg"/>\n</adaptive-icon>\n';
mkdirSync(`${res}/mipmap-anydpi-v26`, { recursive: true });
writeFileSync(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
writeFileSync(`${res}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
console.log(`Ikon DearMe dipasang (${n} file gambar + ikon adaptif)`);
