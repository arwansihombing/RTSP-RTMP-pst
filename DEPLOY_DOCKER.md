# Panduan Manual Deploy StreamBridge ke Server (GitHub → Docker Image)

Panduan lengkap langkah demi langkah untuk mem-push proyek ke GitHub, lalu melakukan clone dan build **Docker Image** produksi di server Linux (Ubuntu 22.04/24.04 atau Debian 12).

---

## Bagian 1: Push Proyek ke GitHub (Dari Komputer / Folder Proyek)

> Catatan: File sensitif runtime (`data.db*`, `node_modules/`, `dist/`, `.env*`) sudah otomatis di-ignore di `.gitignore` dan `.dockerignore`.

1. Buat repository baru di GitHub (misalnya `streambridge`), lalu jalankan perintah berikut di folder proyek:

```bash
git init
git branch -M main
git add .
git commit -m "chore: production ready StreamBridge with Docker setup"
git remote add origin https://github.com/<USERNAME>/<REPO>.git
git push -u origin main
```

---

## Bagian 2: Persiapan Server VPS Linux

Masuk ke server VPS lewat SSH:

```bash
ssh root@<IP_SERVER>
```

### 1. Install Docker Engine & Docker Compose Plugin
Jika Docker belum terpasang di server:

```bash
sudo apt update && sudo apt install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
```

Verifikasi Docker sudah aktif:

```bash
docker --version
docker compose version
```

---

## Bagian 3: Clone & Build Docker Image di Server

### 1. Clone Repository dari GitHub
```bash
sudo mkdir -p /opt/streambridge
sudo chown -R $USER:$USER /opt/streambridge
git clone https://github.com/<USERNAME>/<REPO>.git /opt/streambridge
cd /opt/streambridge
```

### 2. Build Docker Image Produksi
Build image bernama `streambridge:latest` menggunakan `Dockerfile` multi-stage:

```bash
docker build -t streambridge:latest .
```

Pastikan image berhasil terbentuk:

```bash
docker images | grep streambridge
```

*(Image ini sudah berisi Node.js 22 Slim, FFmpeg & FFprobe, `procps`, `tini` init reaper untuk mencegah zombie process, aset produksi `dist/`, serta backend `dist-server/server.mjs` dengan user non-root `node`.)*

---

## Bagian 4: Jalankan Container Produksi

### Opsi A: Menggunakan Docker Compose (Direkomendasikan)

1. Jika port `3000` sudah dipakai aplikasi lain di VPS, edit `docker-compose.yml` pada bagian `ports`:
   ```yaml
   ports:
     - "3005:3000"   # akses luar lewat port 3005, container tetap listen di 3000
   ```
2. Jalankan di background:
   ```bash
   docker compose up -d
   ```

### Opsi B: Menggunakan `docker run` Langsung
```bash
docker run -d \
  --name streambridge \
  --restart unless-stopped \
  --stop-timeout 15 \
  -p 3000:3000 \
  -v streambridge_data:/app/data \
  streambridge:latest
```
*(Ganti `-p 3000:3000` menjadi `-p 3005:3000` jika port `3000` bentrok.)*

---

## Bagian 5: Verifikasi Container & Healthcheck

1. Cek status container (tunggu ~10 detik sampai status menjadi `healthy`):
   ```bash
   docker ps
   ```
2. Uji endpoint healthcheck:
   ```bash
   curl http://127.0.0.1:3000/healthz
   # Output: {"ok":true}
   ```
3. Cek log startup container:
   ```bash
   docker compose logs -f
   # Terlihat: StreamBridge (production) listening on http://0.0.0.0:3000
   ```
4. Buka di browser: `http://<IP_SERVER>:3000` dan login dengan `admin` / `smkbisa!!*&`.

---

## Bagian 6: Reverse Proxy Nginx + SSL (Opsional untuk Domain HTTPS)

Jika memakai domain (misal di Nginx host atau aaPanel Website Reverse Proxy), arahkan ke `http://127.0.0.1:3000` (atau `3005` sesuai port host):

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

Pasang SSL Certbot:
```bash
sudo certbot --nginx -d stream.domainanda.com
```

---

## Bagian 7: Update Aplikasi, Restart & Backup Data

### Update ke Kode Terbaru dari GitHub
Volume `streambridge_data` menyimpan `/app/data/data.db` terpisah dari container, sehingga rebuild tidak menghapus daftar kamera:

```bash
cd /opt/streambridge
git pull origin main
docker compose up -d --build
```

### Restart / Stop Container
```bash
docker compose restart
docker compose down
```

### Backup Database SQLite dari Volume Docker
```bash
docker cp streambridge:/app/data/data.db ./backup-data-$(date +%F).db
```
