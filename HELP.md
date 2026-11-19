# databaseMCP — Yardım Dokumanı

`databaseMCP`, Sybase ASE ve PostgreSQL veritabanlarına bağlanan bir **MCP (Model Context Protocol) stdio sunucusudur**. OpenCode gibi agent'ların veritabanını doğrudan kullanabilmesi için 6 araç sunar.

> Bu dosya gerçeklik kaynağıdır. `databaseMCP help` dendiğinde içeriği örneklerle açıklar.

---

## 1. Ne işe yarar?

- İki veritabanı türünü destekler: **PostgreSQL** (`pg`) ve **Sybase ASE** (`node-sybase` → Java/JDBC köprüsü).
- **Ortam bazlı izin:**
  - `test` ortamı → **tam CRUD** (okuma + yazma/DDL).
  - `prod` ortamı → **salt-okunur**. Yazma araçları açıkça hata ile reddedilir.
- **Manuel konfigürasyon:** otomatik keşif yoktur; bağlantılar sen `config.json`'a yazarsın.
- **Dışa/çe aktarım:** SELECT sonucunu `.xlsx`/`.csv` olarak yazma, dosyayı tabloya toplu ekleme.

---

## 2. Gereksinimler

| Bileşen | Açıklama |
|---|---|
| **Node.js** | `pg`, `exceljs`, `csv-parse`, `csv-stringify`, `node-sybase`, `@modelcontextprotocol/sdk` (npm) |
| **Java** | Sybase için gerekli (`node-sybase` Java/JDBC köprüsünü çalıştırır) |
| **FreeTDS** | `tsql` yeterli; `bcp` **yoksa** Sybase toplu ekleme `INSERT` yığınıyla yapılır |

`node-sybase`, her bağlantıda `java -jar JavaSybaseLink.jar ...` subprocess'ı açar ve JSON ile konuşur.

---

## 3. Başlatma

```bash
node src/server.js
```

Başlamada şunlar görünür:
- `[config] N bağlantının şifresi şifrelendi: ...` (düz metin şifreler varsa)
- `[server] databaseMCP başladı. N bağlantı kaydedildi.`

Sunucu **stdio** üzerinden JSON-RPC konuşur; OpenCode'a bağlanmak için MCP sunucu olarak kaydedilir.

---

## 4. Konfigürasyon

Dosya: **`config.json`** (proje kökü). `.gitignore`'da olduğu için git'e **gitmez** (şifreli kimlikler nedeniyle).
Şablon: `config.example.json` (commitlidir).

```json
{
  "connections": {
    "ornek_postgres_test": {
      "type": "pg",
      "environment": "test",
      "host": "127.0.0.1",
      "port": 5432,
      "database": "ornek_db",
      "user": "kullanici",
      "password": "duz_metin_sifre",
      "ssl": false
    },
    "ornek_sybase_test": {
      "type": "sybase",
      "environment": "test",
      "host": "127.0.0.1",
      "port": 5000,
      "dbname": "ornek_db",
      "username": "kullanici",
      "password": "duz_metin_sifre"
    }
  }
}
```

### Zorunlu alanlar
- **`type`** → arka ucu belirler: `pg` veya `sybase`. Yoksa sunucu başlatmaz.
- **`environment`** → kategori: `test` veya `prod`. Yoksa sunucu başlatmaz.

### Tür başına alanlar
- **PostgreSQL (`pg`):** `host`, `port`, `database`, `user`, `password`, `ssl` (opsiyonel).
- **Sybase (`sybase`):** `host`, `port`, `dbname`, `username`, `password`.

### Şifreler otomatik şifrlenir
Şifreyi **düz metin** yazarsın. Sunucu başladığında:
- Düz metin şifreyi **AES-256-GCM** ile şifreler,
- `config.json`'a `enc:<iv>:<ct>:<tag>` formatında geri yazar,
- Sonraki başlatmalarda `enc:` ile başlayan değer şifreleme **atlanır**, çözülüp kullanılır.

> **Güvenlik uyarısı:** Şifrelemeye kullanılan **master anahtar kodun içindedir** (`src/crypto.js` → `MASTER_KEY_HEX`). Uygulama kaynağına erişen herkes şifreleri çözebilir. Bu tekill/kişisel kullanım için kabul edilebilir bir takastır — **kodu kimseyle paylaşmayın.** İstersen `MASTER_KEY_HEX`'i değiştirip config'i yeniden şifreleyebilirsin.

---

## 5. Araçlar (örnekli)

Tüm araçlar `connection` (bağlantı adı) alır. Sonuçlar `{ content: [{type:'text', text}], isError }` formatındadır.

**Ortam (environment) gösterimi:** Her araç çıktısı, çalışılan bağlantının ortamını (`test` / `prod`) da içerir. `list_tables`, `describe_table` ve `run_query` sonuçlarında başlık satırı olarak `Ortam: test` görünür; `execute` ve `export_query`/`import_file_to_table` mesajları `[test]` / `[prod]` öneki alır. Bu bilgi salt sunumdur; `config.json`'daki `environment` alanından alınır.

### 5.1 `list_tables` — tablo listesi
```json
{
  "connection": "ornek_postgres_test",
  "schema": "public"
}
```
- PostgreSQL için `schema` **opsiyonel** (belirtilmezse tüm şemalar).
- Sybase için `sysobjects.type='U'` (kullanıcı tabloları).

### 5.2 `describe_table` — tablo tanımı (sütunlar)
```json
{
  "connection": "ornek_postgres_test",
  "table": "kullanicilar"
}
```
Sütun başına: ad, veri tipi, nullable, default.

### 5.3 `run_query` — okuma (SELECT)
```json
{
  "connection": "ornek_postgres_test",
  "query": "SELECT id, ad FROM kullanicilar WHERE aktif = true",
  "limit": 50
}
```
- `limit` **opsiyonel**.
- **PostgreSQL:** `LIMIT n` ekler.
- **Sybase:** `LIMIT` desteklenmez → otomatik `TOP n`'e çevirir; sonundaki `;`'yi temizler.

Çıktı: `satir_sayisi`, `sutunlar`, `veriler`.

### 5.4 `execute` — yazma / DDL (INSERT/UPDATE/DELETE/DDL)
```json
{
  "connection": "ornek_postgres_test",
  "query": "INSERT INTO kullanicilar (ad) VALUES ('Ayşe')"
}
```
- **Prod bağlantısında reddedilir** ( açık hata).
- **PostgreSQL:** etkilenen satır sayısı (`rowCount`) döndürülür.
- **Sybase:** sürücü yazma için satır sayısını döndürmez → `"Yürütüldü. Etkilenen satır sayısı sürücü tarafından döndürülmedi..."` döndürülür.

### 5.5 `export_query` — SELECT → dosya (`.xlsx`/`.csv`)
```json
{
  "connection": "ornek_postgres_test",
  "query": "SELECT id, ad, tarih FROM siparisler",
  "filename": "siparisler.csv",
  "format": "csv",
  "limit": 1000
}
```
- Çıktı **`output/`** klasörüne yazılır.
- `format` **opsiyonel** — verilmezse dosya uzantısından anlaşılr (`.xlsx`/`.xls`→xlsx, `.csv`→csv).
- **Güvenlik:** çıktı yolu `output/` dışına çıkamaz (path traversal engeli).

Çıktı: kaydedilen mutlak yol ve satır sayısı.

### 5.6 `import_file_to_table` — dosya → tabloya toplu ekleme
```json
{
  "connection": "ornek_postgres_test",
  "file": "kullanicilar.csv",
  "table": "kullanicilar",
  "format": "csv"
}
```
- `file` **opsiyonel** — `output/` altında aranır; mutlak yol da kabul edilir (`output/` dışı reddedilir).
- `table` **zorunlu**.
- **Prod bağlantusunda reddedilir.**
- `.csv`/`.xlsx` destekler; **başlık satırı** ve **veri satırları** gerekli.
- **PostgreSQL:** tek transaction içinde parametreli `INSERT`.
- **Sybase:** tüm `INSERT`ler `BEGIN TRANSACTION; ...; COMMIT;` ile atomik, tek sorguda gönderilir.

---

## 6. Ortam kuralları (özet)

| Araç | test | prod |
|---|---|---|
| `list_tables`, `describe_table`, `run_query`, `export_query` | ✅ | ✅ |
| `execute` | ✅ | ❌ reddedilir |
| `import_file_to_table` | ✅ | ❌ reddedilir |

Prod'da yazma denemesi şu hata verir:
> `"prod_baglanti" prod bağlantısıdır (salt-okunur). Yazma işlemi (execute) izin verilmiyor.`

---

## 7. Güvenlik & proxy

- **Şifreleme:** AES-256-GCM (kimlik doğrulamalı). Anahtar koddadır (bakın §4).
- **Proxy-dışı bağlantı:** VT bağlantıları her zaman doğrudan TCP ile kurulur. Bağlantı anında proxy ortam değişkenleri (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` vb.) geçici olarak kaldırılır, işlem bitince geri yüklenir (`src/proxy.js`).

---

## 8. Sınırlamalar

- **Sybase satır sayısı:** `node-sybase` yazma işlemleri için etkilenen satır sayısını döndürmez; `"yürütüldü"` olarak raporlanır.
- **Sybase stdio gürüzüsü:** sürücü her sorguda `stdout`'a `console.log` yazar, bu MCP'nin stdio JSON-RPC kanalını bozar. Bu yüzden her sorgu sırasında console çıktısı geçici olarak susturulur (`quietConsole`).
- **Sybase LIMIT:** `LIMIT n` desteklenmez; otomatik `TOP n`'e çevrilir.
- **Otomatik keşif yoktur:** bağlantılar manuel konfigürasyon gerektirir.

---

## 9. Hata ayıklama

| Belirti | Anlamı / Çözüm |
|---|---|
| `[server] config.json boş veya mevcut. ...` | `config.json` yok/boş. `config.example.json`'dan kopyala ve doldur. |
| `"X" bağlantısında "type" alanı zorunlu (pg \| sybase).` | Her bağlantıda `type` ekle. |
| `"X" bağlantısında "environment" alanı zorunlu (test \| prod).` | Her bağlantıda `environment` ekle. |
| `Bağlantı bulunamadı: "X". Mevcut bağlantılar: ...` | Adı yanlış yazmışsın; geçerli adları listele. |
| `Sybase köprü jar'ı bulunamadı: ...` | `node-sybase` kurulu değil / `JAR_PATH` çözülmedi. `npm install` yap. |
| `Şifre çözülemedi: yanlış master anahtar` | `MASTER_KEY_HEX` değişmiş veya config bozulmuş. |
| `Çıktı yolu output/ klasörünün dışına çıkamaz.` | `filename` dizin içermemeli, sadece dosya adı ver. |

---

## 10. Dosya yapısı

```
databaseMCP/
├── config.example.json   # şablon (commitlidir)
├── config.json           # gerçek bağlantılar (.gitignore'da)
├── output/               # export/import dosyaları
├── src/
│   ├── server.js         # MCP stdio sunucusu (6 araç)
│   ├── config.js         # konfig + otomatik şifreleme + type/environment zorunluluğu
│   ├── crypto.js         # AES-256-GCM + gömülü master anahtar
│   ├── proxy.js          # proxy env temizliği
│   ├── io.js             # güvenli dosya yolu (output/ sınırı)
│   ├── excel.js          # export/import (.xlsx)
│   ├── csv.js            # export/import (.csv)
│   └── db/
│       ├── pg.js         # PostgreSQL sarmalısı
│       └── sybase.js     # Sybase sarmalısı (Java köprüsü)
```
