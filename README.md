# DearMe

Teman AI pendengar untuk bercerita dan berkeluh kesah. Persona: **Nara**, **Raka**, **Sena**. AI selalu jujur bahwa ia AI, tidak berperan sebagai pasangan, dan menampilkan info bantuan saat pengguna menyinggung krisis.

Package ID Android: `com.finny4041.dearme`

## Arsitektur
```
www/        antarmuka (HTML/CSS/JS) yang dibungkus Capacitor menjadi APK, juga bisa dibuka sebagai web
server/     backend Node.js tanpa dependensi (satu-satunya tempat API key)
tests/      tes otomatis (node --test)
scripts/    skrip build: write-config.mjs, configure-android.mjs
signing/    kunci debug tetap agar APK baru bisa menimpa yang lama
.github/    workflow build APK dan pembuat lockfile
```
APK **tidak berisi API key**. APK hanya memanggil backend HTTPS Anda di `/api/chat`.

## 1. Backend
Butuh Node.js 20.6+ dan API key Gemini atau OpenAI.

```bash
cp .env.example .env     # isi GEMINI_API_KEY (atau OPENAI_API_KEY + PROVIDER=openai)
npm start                # http://localhost:3000, hanya untuk uji lokal
npm test                 # 17 tes
```
Variabel `.env`: `PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `ALLOWED_ORIGINS` (default `https://localhost,capacitor://localhost`), `RATE_LIMIT_PER_MIN`, `TRUST_PROXY`, `PORT`. Cek nama model terbaru di dokumentasi penyedia.

### Deploy (wajib HTTPS)
Aplikasi Android tidak bisa memakai `localhost` atau `http://`. Pakai layanan hosting yang memberi HTTPS otomatis (Render, Railway, Fly.io, atau VPS dengan Nginx dan sertifikat).
- Gunakan `server/Dockerfile` (build dari akar repo: `docker build -f server/Dockerfile .`).
- Isi environment variable di dashboard hosting (bukan di file yang di-commit), dan set `TRUST_PROXY=1`.
- Cek `https://ALAMAT-ANDA/health` harus membalas `{"ok":true}`.

### Alternatif tanpa kartu: Vercel
Folder `api/` + `vercel.json` menjalankan backend yang sama sebagai fungsi serverless Vercel (paket Hobby gratis, tanpa kartu).
1. vercel.com, daftar dengan GitHub, **Add New, Project**, impor repo ini.
2. Framework: **Other**. Biarkan Build/Install Command (sudah diatur `vercel.json`).
3. **Environment Variables**: `GEMINI_API_KEY` (kunci), `PROVIDER` = `gemini`.
4. Deploy. Alamatnya (contoh `https://nama.vercel.app`) dipakai sebagai `DEARME_API_BASE`. Cek `https://nama.vercel.app/health`.
Catatan: pembatas laju disimpan di memori per instance, jadi di Vercel hanya pelindung kasar.

## 2. Membangun APK lewat GitHub Actions
Satu kali di repo GitHub:
1. **Settings → Secrets and variables → Actions → Variables → New repository variable**: nama `DEARME_API_BASE`, isi alamat backend HTTPS Anda (contoh `https://dearme-api.onrender.com`).
2. Tab **Actions → Generate lockfile → Run workflow**. Ini membuat `package-lock.json` (dependensi terkunci) dan meng-commit-nya.
3. Tab **Actions → Build Android APK → Run workflow**. Build juga jalan otomatis setiap ada push ke `main`.

Build gagal dengan pesan jelas bila: lockfile belum ada, `DEARME_API_BASE` kosong/bukan HTTPS/berisi localhost, tes gagal, atau Gradle error (lihat log langkah terkait).

### Mengunduh dan memasang APK
Buka run yang berhasil → bagian **Artifacts** → unduh `DearMe-APK` → ekstrak zip → buka `DearMe.apk` di HP Android (izinkan "pasang dari sumber ini" bila diminta).

### Memperbarui aplikasi
Ubah kode lalu push ke `main`. Build baru menaikkan `versionCode` otomatis dan memakai kunci debug yang sama, jadi APK baru dapat dipasang langsung di atas yang lama. Mengubah `DEARME_API_BASE` cukup dengan menjalankan ulang build. Memperbarui backend tidak perlu membangun ulang APK.

## Catatan penting
- Ini APK **debug**, untuk uji dan pemakaian pribadi. Kunci debug di `signing/` bersifat publik. Untuk rilis ke Play Store, buat APK/AAB release dengan keystore rahasia Anda sendiri.
- Input suara (mikrofon) memakai Web Speech API yang umumnya tidak tersedia di Android WebView, jadi tombolnya otomatis tersembunyi di APK. Balasan suara memakai TTS bawaan perangkat.
- Riwayat chat tersimpan di penyimpanan lokal aplikasi (backup cloud Android dimatikan). Isi chat dikirim ke penyedia AI (Google/OpenAI) untuk diproses; cantumkan ini dalam kebijakan privasi sebelum rilis publik.
- Aplikasi ini bukan layanan kesehatan mental dan tidak boleh dipromosikan sebagai pengganti psikolog.

Lihat `AUDIT.md` untuk daftar bug yang diperbaiki dan hasil pengujian.

## Suara AI (voice note)

Balasan voice note dibuat server lewat Gemini TTS (kunci `GEMINI_API_KEY` yang sama) di `POST /api/tts`
(`{persona, style, text}` -> `audio/wav`). Suara dipilih menurut persona dan gaya chat. Kalau gagal, aplikasi
otomatis memakai suara bawaan HP. Diagnosis: buka `/health?tts=1` (hanya status model, tanpa kunci).
Daftar model bisa diganti lewat `TTS_MODELS`.
