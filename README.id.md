<div align="center">

# cfmail

**Platform email milik sendiri di Cloudflare: API yang kompatibel dengan Resend,
dasbor, dan webmail tim — dalam satu Worker.**

[English](README.md) · [Bahasa Indonesia](README.id.md)

</div>

- **Terima** email untuk domain Anda lewat Cloudflare Email Routing, gratis dan
  tanpa batas jumlah. Email diurai, disimpan di D1 (lampiran di R2 atau D1),
  lalu diteruskan ke aplikasi sebagai webhook bertanda tangan.
- **Kirim** lewat Cloudflare Email Sending (atau diteruskan ke Resend) dengan
  bentuk request yang sama seperti Resend: `POST /emails`, batch, idempotency
  key, dan lampiran.
- **Tinggal ganti URL**: path, bentuk JSON, error, izin API key, dan webhook
  bertanda tangan Svix sama dengan Resend. Aplikasi yang sudah ada cukup
  mengganti base URL dan API key.
- **Dasbor**: email keluar dan masuk, domain, API key, webhook beserta riwayat
  pengirimannya, dan ringkasan.
- **Webmail tim**: kotak surat (`sales@` atau catch-all), percakapan, folder,
  bintang, pencarian, balas, teruskan, dan lampiran.
- **Pengguna dan peran (RBAC)**: undang orang, susun peran dari izin yang rinci,
  dan semua perubahan tercatat di log audit.

Semua berjalan di akun Cloudflare Anda sendiri. Email disimpan selama yang Anda
mau, di D1 dan R2 milik Anda.

## Satu Worker cukup?

Ya. Satu Worker cukup untuk API, dasbor, dan webmail sekaligus. Tampilan dasbor
berupa file statis (Workers Static Assets) yang tidak dihitung sebagai request
Worker. API memakai Bearer key, sedangkan dasbor memakai cookie tersendiri
(`Path=/app`). Kapan perlu dipisah dijelaskan di
[docs/architecture.md](docs/architecture.md#one-worker-or-two).

## Mulai cepat (lokal)

```bash
git clone https://github.com/eanp/cfmail && cd cfmail
npm install
cp .dev.vars.example .dev.vars            # SEND_MODE=log: tidak benar-benar mengirim
npm run db:migrate:local
node scripts/create-admin.mjs anda@example.com "Nama Anda" > admin.sql
npx wrangler d1 execute DB --local --file admin.sql && rm admin.sql
npm run dev                                # http://localhost:8787/app/
```

Langkah deploy ke akun sendiri ada di [docs/setup.md](docs/setup.md). Dokumen
lengkap dalam bahasa Inggris ada di folder [`docs/`](docs/).

## Biaya singkat

| Kebutuhan          | Cloudflare (cfmail)                                               |
| ------------------ | ----------------------------------------------------------------- |
| Terima email       | Gratis, tanpa batas jumlah (semua paket)                          |
| Kirim email        | Workers Paid $5/bulan: 3.000/bulan termasuk, lalu $0,35 per 1.000 |
| Tanpa Workers Paid | `SEND_MODE=resend`: tetap terima gratis, kirim lewat Resend       |

Email Sending Cloudflare masih **beta**. Baca
[docs/limits-and-costs.md](docs/limits-and-costs.md) sebelum memakainya untuk
klien.

## Lisensi

[MIT](LICENSE)
