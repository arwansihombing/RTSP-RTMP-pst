# StreamBridge — Multi-Stream RTSP → RTMP Passthrough

**StreamBridge** adalah aplikasi web untuk meneruskan banyak stream kamera CCTV/DVR (**RTSP H.264 tanpa audio**) ke **YouTube Live (RTMP)** secara **passthrough murni (`-c:v copy`)** tanpa encoding/decoding ulang video, sehingga pemakaian CPU tetap sangat ringan dan stabil menangani 10+ kamera secara bersamaan.

Repositori ini menyediakan dua implementasi yang sepadan:
1. **Aplikasi Live Node.js / Express + React (root proyek)** — siap dijalankan langsung di produksi maupun development (`node:sqlite` + FFmpeg/FFprobe child process + Vite React UI).
2. **Proyek Native Rust (`rtsp-rtmp-bridge/`)** — implementasi Axum 0.7 + Tokio + SQLx SQLite + Vanilla HTML/JS single-binary dengan perilaku, endpoint API, dan spesifikasi FFmpeg yang identik.

---

## Daftar Isi
1. [Cara Kerja & Arsitektur Sistem](#1-cara-kerja--arsitektur-sistem)
2. [Konfigurasi Zero-Config & Autentikasi](#2-konfigurasi-zero-config--autentikasi)
3. [Spesifikasi Pipeline FFprobe & FFmpeg](#3-spesifikasi-pipeline-ffprobe--ffmpeg)
4. [Auto-Reconnect Supervisor & Lifecycle Proses](#4-auto-reconnect-supervisor--lifecycle-proses)
5. [Live Bandwidth Monitoring](#5-live-bandwidth-monitoring)
6. [Model Data SQLite & State Memory](#6-model-data-sqlite--state-memory)
7. [Daftar Lengkap REST API](#7-daftar-lengkap-rest-api)
8. [Struktur Folder & Bentuk Antarmuka (UI)](#8-struktur-folder--bentuk-antarmuka-ui)
9. [Setup Manual Lengkap di VPS Linux (Tanpa Panel / systemd)](#9-setup-manual-lengkap-di-vps-linux-tanpa-panel--systemd)
10. [Setup di aaPanel (Node.js Project + Reverse Proxy)](#10-setup-di-aapanel-nodejs-project--reverse-proxy)
11. [Setup Versi Native Rust (`rtsp-rtmp-bridge`)](#11-setup-versi-native-rust-rtsp-rtmp-bridge)
12. [Pengujian & Troubleshooting](#12-pengujian--troubleshooting)

---

## 1. Cara Kerja & Arsitektur Sistem

Secara garis besar, aplikasi berjalan sebagai satu server HTTP pada port `3000` yang melayani antarmuka web sekaligus mengatur proses latar belakang (`ffmpeg` dan `ffprobe`) untuk setiap kamera:

```text
+-------------------+       HTTPS / HTTP        +----------------------------------+
|   Browser Admin   | <-----------------------> | Reverse Proxy / Nginx (Opsional) |
+-------------------+                           +----------------+-----------------+
                                                                 |
                                                        http://127.0.0.1:3000
                                                                 v
+----------------------------------------------------------------------------------+
|                        StreamBridge Server (:3000)                               |
|                                                                                  |
|  1. Auth Middleware (Cookie HttpOnly `sb_session`, in-memory UUID Map, TTL 24j)  |
|  2. SQLite WAL (`./data.db`) -> simpan daftar kamera (id, name, rtsp, rtmp)      |
|  3. StreamManager (in-memory runtime state, logs 200 baris, bitrate, bytes_sent) |
|  4. BandwidthMonitor (sampling 1 detik: `/proc/net/dev` NIC + stdout FFmpeg)     |
|                                                                                  |
|     +-------------------------+       +-------------------------+                |
|     | Supervisor Kamera #1    |       | Supervisor Kamera #N    |                |
|     | (Backoff 3..60s)        |       | (Backoff 3..60s)        |                |
|     +------------+------------+       +------------+------------+                |
+------------------|---------------------------------|-----------------------------+
                   | spawn                           | spawn
                   v                                 v
        +---------------------+           +---------------------+
        | Child: ffmpeg #1    |           | Child: ffmpeg #N    |
        | -c:v copy -an       |           | -c:v copy -an       |
        +----+-----------+----+           +----+-----------+----+
             ^           |                     ^           |
   RTSP TCP  |           | RTMP FLV  RTSP TCP  |           | RTMP FLV
   (Inbound) |           v (Outbound)(Inbound) |           v (Outbound)
       [DVR CCTV #1]  [YouTube Live]     [DVR CCTV #N]  [YouTube Live]
```

### Alur Kerja Saat Stream Ditambahkan & Dijalankan
1. **User login** di halaman awal dengan kredensial admin. Server menerbitkan cookie session `HttpOnly`.
2. **User menambah stream** (Nama Kamera, URL RTSP DVR, URL RTMP + Stream Key YouTube).
3. Secara default sistem menjalankan **FFprobe pre-check** ke URL RTSP untuk memastikan track video ber-codec **H.264** (`Skip FFprobe pre-check` bisa dicentang jika kamera sedang offline saat input data).
4. Saat user menekan **Start** (atau opsi langsung start saat save), **StreamManager** memvalidasi ulang codec video (kecuali skip probe) lalu menjalankan **Supervisor Task** khusus untuk kamera tersebut.
5. Supervisor men-spawn proses **`ffmpeg`** terpisah tanpa shell (`shell: false`), membaca progress bitrate/size dari `stdout`, serta membaca error/warning dari `stderr` ke buffer log in-memory.
6. Dashboard melakukan polling:
   - `GET /api/streams` setiap **2 detik** (status, uptime, bitrate per stream, total data, pesan error).
   - `GET /api/bandwidth` setiap **1 detik** (egress total FFmpeg, RX/TX host NIC, riwayat 60 detik).
   - Polling otomatis berhenti sementara ketika tab browser disembunyikan (`document.hidden`) untuk menghemat resource.

---

## 2. Konfigurasi Zero-Config & Autentikasi

### Konstanta Tetap (Tanpa `.env`)
Aplikasi dirancang **zero-config** dan **tidak membaca environment variable** ataupun file `.env` untuk konfigurasi runtime. Seluruh nilai dikunci langsung di `server/config.ts` (Node.js) dan `rtsp-rtmp-bridge/src/config.rs` (Rust):

| Parameter | Nilai Tetap | Keterangan |
| :--- | :--- | :--- |
| **Port Server** | `3000` | Server listen di `0.0.0.0:3000` |
| **Database SQLite** | `./data.db` | Otomatis dibuat + migrasi tabel saat startup |
| **Binary FFmpeg** | `ffmpeg` | Menggunakan `ffmpeg` yang tersedia di `PATH` sistem |
| **Binary FFprobe** | `ffprobe` | Menggunakan `ffprobe` yang tersedia di `PATH` sistem |
| **Level Log** | `info` | Log operasional standar |

### Kredensial & Keamanan Sesi Login
- **Username:** `admin`
- **Password:** `smk bisa`
- **Mekanisme Session:**
  - `POST /api/login` memverifikasi username & password menggunakan perbandingan constant-time (`timingSafeEqual`), lalu menyimpan token UUID acak di `SessionStore` (in-memory `Map`) dengan masa berlaku **24 jam**.
  - Cookie `sb_session` diset sebagai `HttpOnly` (`SameSite=Lax` di HTTP lokal, atau `SameSite=None; Secure; Partitioned` saat diakses lewat reverse proxy HTTPS).
  - Semua route `/api/*` selain `POST /api/login` wajib membawa cookie session yang valid (jika tidak, dikembalikan `401 Unauthorized`).
  - Route `POST`, `PATCH`, `DELETE` pada `/api/*` memvalidasi origin/header permintaan untuk mencegah CSRF lintas situs.
  - Jika server di-restart, seluruh session di memory terhapus dan admin cukup login ulang.

---

## 3. Spesifikasi Pipeline FFprobe & FFmpeg

### A. Pre-Check FFprobe (Wajib H.264)
Sebelum menjalankan stream, `server/stream/probe.ts` menjalankan:
```bash
ffprobe -v quiet -print_format json -show_streams -rtsp_transport tcp "{RTSP_URL}"
```
- Jika tidak ditemukan stream video → ditolak (`No video stream found in RTSP source`).
- Jika `codec_name` bukan `h264` (misalnya `hevc`/`h265`) → ditolak dengan pesan jelas:
  `"Codec bukan H.264 (<codec>), butuh transcoding — tidak didukung"`.
- Jika `h264` → valid, stream siap diteruskan.

### B. Perintah FFmpeg Passthrough (Khusus DVR Tanpa Audio)
Untuk setiap kamera, supervisor menjalankan argumen persis berikut (ditambah `-progress pipe:1` untuk pembacaan bandwidth live):

```bash
ffmpeg -hide_banner -loglevel warning \
  -rtsp_transport tcp \
  -fflags +genpts \
  -i "{RTSP_URL}" \
  -map 0:v:0 \
  -c:v copy \
  -an \
  -f flv \
  -flvflags no_duration_filesize \
  -progress pipe:1 \
  "{RTMP_URL}"
```

| Flag | Fungsi |
| :--- | :--- |
| `-rtsp_transport tcp` | Memaksa koneksi RTSP melalui TCP agar tidak mudah corrupt/putus di jaringan DVR. |
| `-fflags +genpts` | Membuat ulang timestamp PTS untuk mengatasi timestamp DVR CCTV yang sering kacau. |
| `-map 0:v:0` | Mengambil **hanya stream video pertama**. Mencegah crash jika DVR tidak mengirim track audio. |
| `-c:v copy` | Passthrough bitstream H.264 langsung tanpa decode/encode ulang (beban CPU sangat rendah). |
| `-an` | Menegaskan output tanpa audio (`no audio`) agar kompatibel dengan muxer FLV untuk DVR tanpa mikrofon. |
| `-f flv -flvflags no_duration_filesize` | Format FLV live streaming yang sesuai untuk ingest RTMP YouTube Live. |
| `-progress pipe:1` | Mengalirkan statistik telemetry (`bitrate`, `total_size`, `fps`) ke `stdout` untuk monitor bandwidth real-time. |

> **Aturan Keras:** Aplikasi tidak pernah menambahkan `-map 0:a` atau `-c:a` karena DVR CCTV tanpa audio akan membuat FFmpeg langsung crash jika dipaksa memetakan audio.

### C. Deteksi Pola Error `stderr` FFmpeg
Supervisor memindai setiap baris `stderr` FFmpeg secara real-time:
- `Non-monotonous DTS` → dicatat sebagai `warn` (sudah ditangani oleh `-fflags +genpts`).
- `Connection refused`, `timed out`, `Connection reset`, `Broken pipe`, `Server returned 4xx/5xx`, `Input/output error`, `Invalid data found` → dicatat sebagai `error` dan memicu auto-reconnect.
- `Stream map '0:a' matches no streams` → dicatat sebagai error kritis.

---

## 4. Auto-Reconnect Supervisor & Lifecycle Proses

Setiap stream yang aktif memiliki state machine supervisor di `server/stream/supervisor.ts`:

- **Status yang mungkin dimiliki stream:**
  - `stopped` — berhenti (default awal atau dihentikan manual oleh user).
  - `starting` — proses FFmpeg sedang dimulai.
  - `running` — proses FFmpeg aktif dan mengirim frame/progress.
  - `reconnecting` — proses exit dengan error; sedang menunggu jeda backoff sebelum spawn ulang.
  - `error` — melebihi batas maksimal retry (`10` kali berturut-turut gagal).
- **Skema Exponential Backoff:**
  - Percobaan 1: tunggu **3 detik**
  - Percobaan 2: tunggu **5 detik**
  - Percobaan 3: tunggu **10 detik**
  - Percobaan 4: tunggu **30 detik**
  - Percobaan 5 s/d 10: tunggu **60 detik**
- **Auto-Reset Counter:** Jika stream sempat berjalan stabil lebih dari **60 detik**, `retryCount` di-reset kembali ke `0` (jika nanti putus lagi, backoff mulai dari 3 detik).
- **Manual Stop & Shutdown Bersih:**
  - Ketika user klik **Stop**, `manualStop = true`, supervisor mengirim `SIGTERM` ke proses FFmpeg, menunggu maksimal **5 detik** agar keluar normal, lalu mengirim `SIGKILL` jika masih membandel.
  - Ketika server menerima `SIGINT` atau `SIGTERM`, `StreamManager.stopAll()` menunggu seluruh proses FFmpeg anak mati sebelum menutup database SQLite dan server HTTP (anti zombie process).

---

## 5. Live Bandwidth Monitoring

Modul `server/stream/bandwidth.ts` dan komponen `src/components/BandwidthPanel.tsx` memantau bandwidth secara nyata tanpa angka dummy:

1. **Stream Egress (Per Kamera & Total):**
   - Diambil dari output `-progress pipe:1` FFmpeg (`bitrate=...`, `total_size=...`, `fps=...`).
   - Total data terkirim (`bytes_sent`) tetap terakumulasi meskipun stream sempat reconnect.
   - Saat stream berhenti, bitrate live langsung turun menjadi `0 kbps`.
2. **Host Network Interface RX & TX:**
   - Dibaca setiap 1 detik dari `/proc/net/dev` di Linux, menjumlahkan seluruh interface jaringan non-loopback (mengabaikan `lo`).
   - Menghitung laju RX (ingress dari kamera RTSP + trafik masuk host) dan TX (egress ke YouTube RTMP + trafik keluar host) dalam `kbps`, serta total byte sejak sesi server berjalan.
3. **Grafik Riwayat 60 Detik:**
   - Menyimpan maksimal `60` sampel terakhir (1 sampel/detik) di memory (`Stream Egress`, `Host TX`, `Host RX`) dan merendernya dalam grafik SVG full-width pada dashboard.

---

## 6. Model Data SQLite & State Memory

Database disimpan di `./data.db` dalam mode `WAL` (`PRAGMA journal_mode = WAL`).

### Tabel `streams` (Persisten di SQLite)
| Kolom | Tipe | Keterangan |
| :--- | :--- | :--- |
| `id` | `TEXT PRIMARY KEY` | UUID v4 unik stream |
| `name` | `TEXT NOT NULL` | Nama kamera/lokasi |
| `rtsp_url` | `TEXT NOT NULL` | URL sumber RTSP DVR |
| `rtmp_url` | `TEXT NOT NULL` | URL tujuan RTMP YouTube Live + Stream Key |
| `enabled` | `INTEGER NOT NULL DEFAULT 1` | Flag aktif |
| `created_at` | `TEXT NOT NULL` | Timestamp ISO-8601 |
| `updated_at` | `TEXT NOT NULL` | Timestamp ISO-8601 |

### State Runtime (Hanya di Memory, Tidak Disimpan ke DB)
`status`, `pid`, `uptime_seconds`, `retry_count`, `bitrate_kbps`, `bytes_sent`, `fps`, `last_error`, dan `logs` (maksimal 200 baris per stream).

---

## 7. Daftar Lengkap REST API

### Public / Health Routes
| Method | Endpoint | Fungsi |
| :--- | :--- | :--- |
| `GET` | `/healthz` | Healthcheck server untuk load balancer / monitoring (`200 { ok: true }`) |
| `GET` | `/auth/session` | Cek status login browser (`200 { authenticated: boolean }`) |
| `POST` | `/api/login` | Login `{ username, password }` → set cookie `sb_session` |

### Protected API Routes (Wajib Cookie Session `sb_session`)
| Method | Endpoint | Fungsi |
| :--- | :--- | :--- |
| `POST` | `/api/logout` | Hapus session aktif dan bersihkan cookie |
| `GET` | `/api/health` | Status API terautentikasi |
| `GET` | `/api/streams` | Daftar seluruh kamera + status runtime, uptime, bitrate, `bytes_sent`, `fps` |
| `POST` | `/api/streams` | Tambah stream baru (FFprobe pre-check kecuali `skip_probe: true`) |
| `PATCH` | `/api/streams/:id` | Ubah nama / URL RTSP / URL RTMP |
| `DELETE` | `/api/streams/:id` | Stop proses FFmpeg (jika jalan) dan hapus kamera dari SQLite |
| `POST` | `/api/streams/:id/start` | Jalankan proses FFmpeg stream secara manual |
| `POST` | `/api/streams/:id/stop` | Hentikan proses FFmpeg stream secara manual |
| `POST` | `/api/streams/:id/probe` | Jalankan FFprobe H.264 test tanpa memulai streaming |
| `POST` | `/api/probe` | Uji URL RTSP baru sebelum disimpan (`{ rtsp_url }`) |
| `GET` | `/api/streams/:id/logs` | Ambil maksimal 200 baris log terakhir untuk stream tertentu |
| `GET` | `/api/bandwidth` | Snapshot & riwayat 60 detik bandwidth live (egress stream + host NIC RX/TX) |
| `GET` | `/api/rust-files` | Daftar isi kode sumber proyek Rust (`rtsp-rtmp-bridge/`) untuk tab Rust Project |

---

## 8. Struktur Folder & Bentuk Antarmuka (UI)

### Struktur Direktori
```text
.
├── package.json                  # Script dev, build, start (NODE_ENV=production), lint
├── server.ts                     # Entrypoint Express HTTP, Auth, API router, static dist / Vite
├── index.html                    # HTML shell + Google Fonts (Plus Jakarta Sans, DM Sans, JetBrains Mono)
├── public/
│   └── favicon.ico               # Ikon browser
├── server/
│   ├── config.ts                 # Konstanta hardcoded (PORT=3000, DB_PATH=./data.db, ffmpeg, ffprobe)
│   ├── auth.ts                   # Verifikasi login admin, SessionStore (UUID TTL 24j), middleware
│   ├── db.ts                     # Wrapper node:sqlite (WAL + CRUD tabel streams)
│   ├── routes/
│   │   └── streams.ts            # Router seluruh endpoint /api/*
│   └── stream/
│       ├── types.ts              # Tipe data Stream, Log, Probe, Bandwidth
│       ├── ffmpeg.ts             # Builder argumen FFmpeg, validator URL, parser stdout/stderr
│       ├── probe.ts              # Eksekutor FFprobe & pengecekan wajib H.264
│       ├── supervisor.ts         # Spawn proses, auto-reconnect backoff, log buffer 200 baris
│       ├── bandwidth.ts          # Pembaca /proc/net/dev & agregator 60s history
│       └── manager.ts            # Orkestrator multi-stream + DB + bandwidth
├── src/
│   ├── App.tsx                   # Shell dashboard, polling 1s/2s, filter, tabel 7 kolom
│   ├── types.ts                  # Tipe data frontend
│   ├── utils/streamFormat.ts     # Formatter bitrate, bytes, uptime, masking RTMP stream key
│   └── components/
│       ├── LoginView.tsx         # Halaman login sebelum masuk dashboard
│       ├── BandwidthPanel.tsx    # 4 kartu metrik live bandwidth + grafik SVG 60 detik
│       ├── StatusBadge.tsx       # Badge status (Running, Reconnecting, Starting, Error, Stopped)
│       ├── StreamModal.tsx       # Modal Add/Edit stream + Test FFprobe + Skip probe + Auto-start
│       ├── LogsModal.tsx         # Modal log live 200 baris dengan auto-scroll
│       ├── DeleteModal.tsx       # Konfirmasi hapus stream
│       ├── SpecView.tsx          # Dokumentasi flag FFmpeg & kebijakan backoff di UI
│       └── RustProjectView.tsx   # Viewer seluruh file source Rust di dalam UI
└── rtsp-rtmp-bridge/             # Proyek native Rust lengkap (Cargo.toml, src/, migrations/, frontend/)
```

### Bentuk & Tampilan Antarmuka (UI)
1. **Halaman Login (`LoginView`)**: Kartu login bersih di tengah layar sebelum dashboard dapat diakses.
2. **Header Navigasi**: Logo wordmark `StreamBridge`, 3 tab (`Streams`, `FFmpeg Spec`, `Rust Project`), tombol utama `+ Add Stream`, dan tombol `Logout`.
3. **Ringkasan Stream (4 Kolom)**: `Total Streams`, `Running`, `Reconnecting`, `Errors`.
4. **Panel Monitoring Bandwidth Live (`BandwidthPanel`)**:
   - 4 metrik real-time: `Live Stream Egress`, `Host NIC RX (Ingress)`, `Host NIC TX (Egress)`, `FFmpeg Data Sent`.
   - Grafik garis **Bandwidth Throughput (Last 60s)** yang membandingkan `Stream Egress` (hijau), `Host TX` (biru), dan `Host RX` (abu-abu).
5. **Toolbar Filter & Search**: Kolom pencarian berdasarkan nama/URL dan filter status (`All`, `Running`, `Reconnecting`, `Error`, `Stopped`).
6. **Tabel Stream (7 Kolom)**:
   - `Name` (beserta ringkasan error terakhir jika ada)
   - `RTSP Source` (dipendekkan di tengah, URL penuh tampil saat hover)
   - `RTMP Target` (**Stream Key otomatis disensor/dimasking** demi keamanan tampilan)
   - `Status` (dot warna + label teks + counter retry)
   - `Bandwidth` (kecepatan live `kbps`/`Mbps` + total byte terkirim)
   - `Uptime` (`HH:MM:SS`)
   - `Actions` (`Start`/`Stop`, `Probe`, `Edit`, `Logs`, `Delete`)

---

## 9. Setup Manual Lengkap di VPS Linux (Tanpa Panel / `systemd`)

Panduan ini untuk server **Ubuntu 22.04 / 24.04** atau **Debian 12** bersih.

### Langkah 1: Pasang FFmpeg & Build Tools Dasar
```bash
sudo apt update
sudo apt install -y ffmpeg curl ca-certificates
ffmpeg -version
ffprobe -version
```

### Langkah 2: Pasang Node.js v22 LTS atau v24 (Minimal v22.5 untuk `node:sqlite`)
Contoh menggunakan NodeSource (Node 22 LTS):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # pastikan >= v22.5.0
npm -v
```

### Langkah 3: Siapkan Direktori Proyek, Install Dependencies & Build Produksi
```bash
sudo mkdir -p /opt/streambridge
sudo chown -R $USER:$USER /opt/streambridge
# Upload / salin seluruh file proyek ke /opt/streambridge, lalu masuk ke folder tersebut:
cd /opt/streambridge

npm install
npm run build
```
Pastikan folder `dist/` terbentuk (`ls -la dist/`).

### Langkah 4: Uji Jalan Sekali di Terminal
```bash
npm start
```
Jika berhasil, output akan menampilkan:
```text
StreamBridge (production) listening on http://0.0.0.0:3000
```
Tekan `Ctrl+C` untuk menghentikan uji coba manual.

### Langkah 5: Jadikan Service Permanen dengan `systemd` (Auto-Start saat Reboot)
Buat file service `/etc/systemd/system/streambridge.service`:
```ini
[Unit]
Description=StreamBridge Multi-Stream RTSP to RTMP Passthrough
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/streambridge
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
Environment=NODE_ENV=production
# Opsional: naikkan limit file descriptor jika handle 20+ kamera
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```
Aktifkan dan jalankan service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now streambridge
sudo systemctl status streambridge
```
Cek healthcheck lokal:
```bash
curl http://127.0.0.1:3000/healthz
# Output: {"ok":true}
```
Cek log realtime kapan saja dengan:
```bash
journalctl -u streambridge -f
```

### Langkah 6: Reverse Proxy Nginx (Jika Memakai Domain + HTTPS)
Jika di depan port `3000` dipasang Nginx:
```nginx
server {
    listen 80;
    server_name stream.domainanda.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```
Lalu pasang SSL dengan Certbot: `sudo certbot --nginx -d stream.domainanda.com`.

---

## 10. Setup di aaPanel (Node.js Project + Reverse Proxy)

Cocok jika server Anda sudah memakai **aaPanel** dan Nginx Reverse Proxy sudah disiapkan secara terpisah.

### Langkah 1: Persiapan di Terminal VPS (Sekali Saja)
```bash
# 1. Pastikan FFmpeg & FFprobe tersedia
sudo apt update && sudo apt install -y ffmpeg
ffmpeg -version && ffprobe -version

# 2. Pastikan kepemilikan folder proyek adalah user www (agar ./data.db bisa dibuat otomatis)
chown -R www:www /www/wwwroot/streambridge
```

### Langkah 2: Build Awal (Opsional jika belum menjalankan build)
```bash
cd /www/wwwroot/streambridge
npm install
npm run build
chown -R www:www /www/wwwroot/streambridge
```

### Langkah 3: Isi Form **Website → Node project → Add Node project** di aaPanel
Isi kolom sesuai tabel berikut:

| Kolom aaPanel | Nilai yang Diisi |
| :--- | :--- |
| **Path** | `/www/wwwroot/streambridge` (arahkan ke folder proyek Anda) |
| **Project Name** | `streambridge` |
| **Run User** | `www` |
| **Node.js runtime** | `v22.x` atau `v24.x` (misal `v24.22.3` — wajib ≥ `v22.5` untuk `node:sqlite`) |
| **Pkg Manager** | `npm` atau `yarn` |
| **Install dependencies** | Centang jika `node_modules` belum di-install |
| **Start command** | Pilih **Custom command**: `npm run build && npm start` *(atau pilih **From package.json** → `start` jika sudah di-build)* |
| **Project Port** | `3000` |
| **Project Remark** | Kosongkan atau `StreamBridge RTSP-RTMP` |
| **Domain name** | **Kosongkan** jika Reverse Proxy sudah diatur terpisah di Website/Nginx aaPanel |

Setelah status **Running**, arahkan Reverse Proxy domain Anda di aaPanel ke `http://127.0.0.1:3000`.

---

## 11. Setup Versi Native Rust (`rtsp-rtmp-bridge`)

Jika Anda ingin menjalankan versi binary Rust murni (tanpa runtime Node.js):

### Langkah 1: Prasyarat
- Rust toolchain (`cargo`, `rustc` ≥ 1.78):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- FFmpeg & FFprobe (`apt install -y ffmpeg`) dan build dependencies C untuk SQLite (`apt install -y build-essential pkg-config libsqlite3-dev`).

### Langkah 2: Compile Release Binary
```bash
cd rtsp-rtmp-bridge
cargo build --release
```
Binary tunggal akan dihasilkan di `rtsp-rtmp-bridge/target/release/rtsp-rtmp-bridge`.

### Langkah 3: Jalankan Langsung (Zero-Config)
```bash
./target/release/rtsp-rtmp-bridge
```
Server langsung listen di `0.0.0.0:3000`, membuat `./data.db` secara otomatis, dan melayani UI HTML + JS bawaan (termasuk login `admin` / `smk bisa` dan monitoring bandwidth live). Di aaPanel, binary ini bisa dijalankan sebagai daemon lewat **App Store → Supervisor**.

---

## 12. Pengujian & Troubleshooting

### Menjalankan Unit Test & Lint (Node.js)
```bash
npm run lint
npx --yes tsx --test server/*.test.ts server/stream/*.test.ts src/utils/*.test.ts
```

### Masalah Umum & Solusinya

| Gejala | Penyebab Utama | Solusi |
| :--- | :--- | :--- |
| **`502 Bad Gateway` di Nginx / aaPanel** | Node project belum jalan atau port bukan `3000` | Pastikan status project **Running**, port diset `3000`, dan cek `curl http://127.0.0.1:3000/healthz`. |
| **`Production build not found in dist/`** | Server dijalankan dalam mode produksi sebelum `vite build` | Jalankan `npm run build` di folder proyek sebelum `npm start`. |
| **`SQLITE_CANTOPEN` / gagal menulis `data.db`** | User `www` tidak punya izin tulis ke folder proyek | Jalankan `chown -R www:www /path/proyek`. |
| **`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`** | Versi Node.js terlalu lama (`< 22.5`) | Ganti runtime Node di aaPanel/VPS ke **v22.x** atau **v24.x**. |
| **`Codec bukan H.264 (hevc), butuh transcoding`** | Kamera DVR diset ke H.265/HEVC | Ubah setelan encoding sub-stream/main-stream di DVR CCTV menjadi **H.264**. |
| **Stream langsung `reconnecting` / `Connection refused`** | IP RTSP lokal tidak terjangkau dari VPS atau port 554/1935 terblokir | Pastikan kamera dapat diakses dari VPS (VPN/port-forward) dan firewall mengizinkan keluar ke TCP port `554` (RTSP) & `1935` (RTMP). |
| **Refresh browser balik ke login (khusus HTTP vs HTTPS)** | Reverse proxy tidak meneruskan header `X-Forwarded-Proto` | Pastikan di konfigurasi Reverse Proxy Nginx terdapat `proxy_set_header X-Forwarded-Proto $scheme;`. |
