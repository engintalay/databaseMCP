'use strict';

/**
 * Şifreli değerleri aktif (yeni) master anahtarıyla yeniden şifreler.
 * install.sh tarafından çağrılır.
 *
 * Global (~/.config/databaseMCP/config.json) ve proje
 * (DATABASEMCP_CONFIG veya ./config.json) config'lerini tarar;
 * rastgele derinlikteki her `password` alanındaki `enc:...` değeri
 * şu sırayla çözer -> aktif anahtarla yeniden şifreler:
 *   1. DATABASEMCP_OLD_KEY  (hex, 32 byte) — SADECE anahtar rotasyonunda
 *   2. Aktif anahtar (ortam/dosya)
 *   3. (legacy) Kod içinde gömülü eski anahtar
 *
 * GÜVENLİK (fail-closed + atomik):
 *   - Önce TÜM şifreli değerlerin çözülebilir olduğunu doğrular.
 *     Çözülemeyen BİR değer varsa TAMAMINI yazmadan DURUR (çıkış kodu 1).
 *     Böylece kısmi/bozuk config veya anahtar kayması veri kaybına yol açmaz.
 *   - Sadece aktif anahtarla zaten şifreli olan değerlere dokunmaz
 *     (göç idempotent).
 *
 * Anahtar rotasyonu (--force-key): DATABASEMCP_OLD_KEY'e önceki anahtar verilir,
 * aktif anahtar yeni anahtar olur. Değerler eski anahtarla çözülp yeni anahtarla
 * şifrlenir. install.sh, göç BAŞARILISAN master.key'i yeni anahtarla günceller.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  decryptWithKey,
  encrypt,
  isEncrypted,
  getMasterKey,
  LEGACY_MASTER_KEY,
  globalConfigDir,
} = require('../src/crypto');

// ---- Anahtarları topla ------------------------------------------------------
const activeKey = getMasterKey(); // yeni anahtar (rotasyonda ortam/dosya)

let oldKey = null;
const envOld = (process.env.DATABASEMCP_OLD_KEY || '').trim();
if (envOld !== '') {
  oldKey = Buffer.from(envOld, 'hex');
  if (oldKey.length !== 32) {
    console.error('[hata] DATABASEMCP_OLD_KEY 32 byte (64 hex) olmalıdır.');
    process.exit(1);
  }
}

/**
 * Bir enc: değeri hangi anahtarla çözülebilir?
 * Sıralama: active -> old -> legacy.
 * @returns {{plain: string|null, alreadyActive: boolean, decodable: boolean}}
 */
function tryDecrypt(enc) {
  // Zaten aktif anahtarla şifreliyse dokunmaya gerek yok.
  try {
    decryptWithKey(enc, activeKey);
    return { plain: null, alreadyActive: true, decodable: true };
  } catch {
    /* devam */
  }
  // Eski anahtar (rotasyon) ile dene.
  if (oldKey) {
    try {
      return { plain: decryptWithKey(enc, oldKey), alreadyActive: false, decodable: true };
    } catch {
      /* devam */
    }
  }
  // Legacy anahtarla dene (eski şifreli değerler için).
  try {
    return { plain: decryptWithKey(enc, LEGACY_MASTER_KEY), alreadyActive: false, decodable: true };
  } catch {
    return { plain: null, alreadyActive: false, decodable: false };
  }
}

// ---- Config hedefleri -------------------------------------------------------
const targets = [
  { label: 'global', path: path.join(globalConfigDir(), 'config.json') },
  { label: 'proje', path: process.env.DATABASEMCP_CONFIG || path.join(process.cwd(), 'config.json') },
];

// ---- 1. Doğrulama + toplama geçişi: her enc değeri çözülebilir mi? ----------
// Her dosyanın içeriği bir kez okunup bellekte tutulur (atomik yazma için).
// entries, şifreli `password` içeren nesneye DOĞRUDAN referans tutar.
const files = []; // { label, path, data }
const entries = []; // { file, setValue, key, plain, alreadyActive, decodable }
const errors = [];

function collect(obj, fileEntry, keyPath) {
  if (!obj || typeof obj !== 'object') return;
  if (typeof obj.password === 'string' && isEncrypted(obj.password)) {
    const { plain, alreadyActive, decodable } = tryDecrypt(obj.password);
    entries.push({ file: fileEntry, setValue: obj, key: 'password', plain, alreadyActive, decodable });
    if (!decodable) {
      errors.push(`${fileEntry.label}[${keyPath || '(root)'}].password`);
    }
  }
  for (const k of Object.keys(obj)) {
    collect(obj[k], fileEntry, keyPath ? `${keyPath}.${k}` : k);
  }
}

for (const fileEntry of targets) {
  if (!fileEntry.path || !fs.existsSync(fileEntry.path)) continue;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fileEntry.path, 'utf8'));
  } catch (e) {
    console.warn(`[uyarı] ${fileEntry.label} JSON okunamadı: ${e.message}`);
    continue;
  }
  files.push({ label: fileEntry.label, path: fileEntry.path, data });
  collect(data, fileEntry, '');
}

if (errors.length > 0) {
  console.error('[hata] ' + errors.length + ' şifreli değer hiçbir anahtarla çözülemedi:');
  for (const e of errors) console.error('   - ' + e);
  console.error(
    '\nBu değerler ya önceki (artık mevcut olmayan) bir anahtarla, ya da bozulmuş ' +
      'şekilde saklanıyor. Anahtar yenilenmeden DURULDU. Lütfen yedekten geri yükle.'
  );
  process.exit(1);
}

// ---- 2. Göç geçişi: aktif anahtarla yeniden şifrele (aynı nesne referansları)
let count = 0;
const changedFiles = new Set();
for (const e of entries) {
  if (e.alreadyActive || !e.decodable) continue;
  e.setValue[e.key] = encrypt(e.plain);
  count++;
  changedFiles.add(e.file.path);
}

for (const f of files) {
  if (changedFiles.has(f.path)) {
    fs.writeFileSync(f.path, JSON.stringify(f.data, null, 2) + '\n', 'utf8');
    console.log(`${f.label}: değerler aktif anahtarla şifrelendi -> ${f.path}`);
  }
}

if (count === 0) {
  console.log('Tüm şifreli değerler zaten aktif anahtarla şifreli. Yapılan değişiklik yok.');
} else {
  console.log(`Toplam yeni anahtarla şifrelenen/değiştirilen değer: ${count}`);
}
