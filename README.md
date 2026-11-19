# databaseMCP

PostgreSQL ve Sybase (FreeTDS) veritabanları için **MCP (Model Context Protocol)** stdio sunucusu.
Araçlara sorgu kurarken bağlam ekler: ortam bazlı bağlantı grupları, şifreli kimlik bilgileri ve
insan/makinaların okuyabileceği global şema tanımı.

> Detaylı kullanım kılavuzu için bakın: [HELP.md](./HELP.md)

## Özellikler

- **İki veritabanı**: PostgreSQL (`pg`) ve Sybase (FreeTDS `tsql` üzerinden `node-sybase`).
- **Araçlar**:
  - `list_tables` — bir bağlantıdaki kullanıcı tablolarını listeler
  - `describe_table` — tablo tanımı (sütunlar)
  - `describe_schema` — global şema (`schema.yaml`) tanımı, sorgu bağlamı
  - `run_query` — okuma (SELECT)
  - `execute` — yazma / DDL (test ortamında; prod bağlantısında reddedilir)
  - `export_query` — SELECT → `.xlsx`/`.csv` (`output/` klasörüne)
  - `import_file_to_table` — `.csv`/`.xlsx` → tabloya toplu ekleme (prod reddedilir)
- **Ortam grupları**: bağlantılar `test` / `prod` anahtarları altında tanımlanır; her bağlantının
  `environment` bilgisini ayrı tekrar yazmaya gerek yoktur.
- **Çift katman konfigürasyon**:
  - **Global** (`~/.config/databaseMCP/config.json`) — paylaşım bağlantıları + şifreler. Git'e düşmez.
  - **Proje** (`./config.json` veya `DATABASEMCP_CONFIG`) — projeye özel bağlantılar.
  - Proje bağlantısı, aynı adlı global bağlantının üzerine yazar.
- **Şifre koruması**: düz metin şifreler master anahtarla AES-256-GCM (kimlik doğrulamalı) ile
  şifrlenir ve `enc:...` formatında saklanır.

## Kurulum

```bash
./install.sh            # bağımlılıkları kurar, master anahtar üretir
# veya
npm run install:deps
```

`install.sh` şunları yapar:

1. `node` / `npm` var mı kontrol eder.
2. `npm ci` (veya `package-lock.json` yoksa `npm install`) ile node_modules kurar.
3. FreeTDS (`tsql`) var mı kontrol eder — Sybase için gerekli.
4. Master anahtar üretir: `~/.config/databaseMCP/master.key` (izin `0600`).
   Zaten varsa `--force-key` verilmedikçe dokunmaz.
5. Mevcut şifreli değerleri (global + proje config) yeni anahtarla yeniden şifreler.

```bash
./install.sh --force-key   # master anahtarını yenile (rotasyon)
./install.sh --help
```

## Çalıştırma

```bash
./run.sh            # sunucuyu başlat (stdio)
./status.sh         # durum: node, anahtar, config, bağlantılar
./stop.sh           # çalışan sunucuyu durdur
# veya
npm run start       # (= ./run.sh)
npm run status
npm run stop
```

## Master anahtar

Şifreli değerleri çözen aktif anahtar şu sırayla bulunur (yüksek → düşük öncelik):

1. Ortam değişkeni `DATABASEMCP_MASTER_KEY` (hex, 32 byte / 64 hex karakter)
2. Global dosya `~/.config/databaseMCP/master.key` (hex, 32 byte)
3. (legacy) Kod içinde gömülü eski anahtar — **SADECE** geriye uyum için çözmek kullanılır

Aktif anahtar bulunamazsa sunucu **başlatmaz** (fail-closed).

### Anahtar rotasyonu (`--force-key`)

Anahtar yenilediğinizde eski şifreli değerler kaybolmaz: `install.sh` önceki anahtarı yakalar,
göç scripti (`scripts/migrate-keys.js`) onu `DATABASEMCP_OLD_KEY` ile kullanarak değerleri çözer ve
yeni anahtarla yeniden şifreler. Göç **başarılıysan** yeni anahtar `master.key`'e yazılır.

- Göç sırasında çözülemeyen bir değer varsa, script **yazmadan durur** (çıkış kodu `1`) — böylece
  kısmi/bozuk config veya anahtar kayması veri kaybına yol açmaz.
- Göç başarısızsa `master.key` **değiştirilmez**; eski anahtarla veriler hâlâ çözülebilir.

## Konfigürasyon

Gerçek konfigürasyon dosyası (`config.json`) şifreli kimlik bilgileri içerdiği için **Git'e düşmez**
(bkz. `.gitignore`). Örnek yapı için [config.example.json](./config.example.json) bakın.

```jsonc
{
  "test":  { "connections": { "bağlantı_adi": { "type": "pg", "host": "...", "port": 5432, "database": "...", "user": "...", "password": "duz_metin" } } },
  "prod":  { "connections": { "bağlantı_adi": { "type": "sybase", "host": "...", "port": 5000, "dbname": "...", "username": "...", "password": "duz_metin" } } }
}
```

Şifreler düz metin yazılır; uygulama başladığında otomatik olarak şifrlenir.

## Güvenlik

- Anahtara (veya `DATABASEMCP_MASTER_KEY`) erişen herkes VT şifrelerini çözebilir. Anahtarı
  paylaşmayın. `master.key` dosyası `0600` izinle saklanır.
- `execute` ve `import_file_to_table` araçları **prod** bağlantısında reddedilir.

## Proje yapısı

```
install.sh            # bağımlılık + master anahtar + göç
run.sh / stop.sh      # sunucu başlat/dur
status.sh             # durum raporu
scripts/migrate-keys.js   # şifreli değerleri yeni anahtarla yenile (fail-closed)
src/crypto.js         # AES-256-GCM şifreleme + anahtar yönetimi
src/config.js         # global + proje konfigürasyonu
src/server.js         # MCP sunucusu ve araçlar
src/db/{pg,sybase}.js # veritabanı sürücüleri
HELP.md               # detaylı kullanım kılavuzu
```

## Lisans

ISC
