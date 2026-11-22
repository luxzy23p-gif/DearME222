# Audit DearMe

## Temuan dan perbaikan
| # | Temuan pada kode sebelumnya | Perbaikan |
|---|---|---|
| 1 | Klien memanggil `/api/chat` relatif, tidak berfungsi di APK | Alamat backend lewat `www/config.js` (`DEARME_API_BASE`), build gagal bila bukan HTTPS atau localhost |
| 2 | Validasi persona memakai `!PERSONAS[x]`, sehingga `"constructor"`/`"__proto__"` lolos | Pakai `hasOwnProperty` di server dan klien |
| 3 | Tidak ada CORS terkontrol | Daftar asal yang diizinkan (`ALLOWED_ORIGINS`), asal lain ditolak 403, preflight ditangani |
| 4 | Pembatas laju tidak membersihkan memori, memakai `req.ip` apa adanya | Pembersihan berkala, IP dari proxy hanya dipercaya bila `TRUST_PROXY=1` |
| 5 | Tidak ada timeout ke AI (klien 30 dtk, server 20 dtk) | Ditambahkan, dengan pesan error yang jelas |
| 6 | Bila AI gagal, pesan pengguna menggantung tanpa jalan keluar | Tombol **Kirim ulang**, pesan tersimpan, pemulihan otomatis saat aplikasi dibuka kembali |
| 7 | Pengguna krisis tidak mendapat bantuan bila AI/jaringan gagal | Server membalas info bantuan sebagai cadangan, klien juga menampilkannya saat error |
| 8 | Data tersimpan tidak divalidasi (data rusak bisa membuat aplikasi macet) | Skema dibersihkan saat dimuat, riwayat dibatasi 500 pesan |
| 9 | `nick` bisa menyisipkan baris instruksi ke prompt | Karakter kontrol dan tanda kutip dibuang di server dan di prompt |
| 10 | Persona kurang berbeda, tidak ada pertahanan jailbreak/ketergantungan | Karakter tiap persona didefinisikan, aturan anti-ketergantungan dan anti-pengubahan aturan ditambah |
| 11 | Google Fonts dimuat dari internet (privasi, offline) | Dihapus, memakai font sistem |
| 12 | Skrip dan gaya inline menghalangi CSP ketat | Dipisah ke `app.js`/`style.css`, CSP ditambahkan |
| 13 | Server bisa menyajikan file selain yang dimaksud | Daftar putih path, tes memastikan `server.js` dan `.env` tidak terbuka |
| 14 | Log server | Hanya metode, path, status. Isi chat tidak pernah dicatat (dites) |
| 15 | Android: tombol kembali, backup cloud, cleartext | Tombol kembali ditangani, `allowBackup=false`, `usesCleartextTraffic=false`, izin jaringan dipastikan |
| 16 | Tidak ada build/CI | Workflow APK, workflow lockfile, kunci debug tetap, versionCode otomatis |

Rendering pesan sudah memakai `textContent` dan tidak ditemukan celah XSS; ini dipertahankan dan diperkuat dengan CSP.
Server diganti dari Express ke `node:http` tanpa dependensi agar dapat diuji penuh dan permukaan serangannya kecil. Semua endpoint dan fitur lama dipertahankan.

## Pengujian yang benar-benar dijalankan (di lingkungan ini)
- `node --test`: **17 tes lulus, 0 gagal** (validasi input, 400/413/415/503/502, rate limit, CORS, fallback krisis, log tanpa isi chat, whitelist file, persona, deteksi krisis) memakai Gemini tiruan.
- Server sungguhan dijalankan: `/health` 200, `/` 200, `/api/chat` tanpa key 503.
- `write-config.mjs`: menolak kosong, http, localhost, IP lokal, dan teks bukan URL; menerima HTTPS.
- `configure-android.mjs`: diuji pada manifest tiruan, hasilnya benar dan identik saat dijalankan dua kali.
- Sintaks `app.js`, `persona.js`, `server.js`, JSON, dan YAML workflow valid. Kunci debug valid.

## TIDAK dapat diuji di sini (jujur)
Lingkungan ini tidak punya internet, Android SDK, maupun emulator. Karena itu **belum terbukti**:
- `npm ci`, `npx cap add android`, dan `./gradlew assembleDebug` berhasil di GitHub Actions. Versi `^7.0.0` Capacitor belum saya verifikasi terhadap registry.
- APK terpasang, terbuka, dan terhubung ke backend; tampilan di Android 16 (tepi-ke-tepi, status bar, keyboard, splash).
- Panggilan nyata ke Gemini/OpenAI (nama model di `.env.example` perlu dicek).
- Perilaku `app.js` di browser/WebView (hanya dicek sintaksnya, tidak dijalankan), termasuk tombol kembali, kirim ulang, TTS.
- Workflow `Generate lockfile` mendorong ke `main`; bila repo membatasi izin Actions, aktifkan "Read and write permissions".
Jalankan build pertama, lalu kirim log error (bila ada) ke sini agar bisa diperbaiki.
