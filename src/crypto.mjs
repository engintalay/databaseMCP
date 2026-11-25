/**
 * Şifreleme katmanı.
 *
 * Master anahtar şu sırayla bulunur (yüksek öncelik -> düşük):
 *   1. Ortam değişkeni  DATABASEMCP_MASTER_KEY  (hex, 32 byte)
 *   2. Global dosya      ~/.config/databaseMCP/master.key  (hex, 32 byte)
 *   3. (legacy) Kod içinde gömülü eski anahtar — SADECE geriye uyum çözmek için
 *
 * Aktif anahtar bulunamazsa hata verilir (fail-closed): şifreli kimlikleri
 * çözülemez, sunucu başlatmaz.
 *
 * Şifreli değerler config'de şu formatta saklanır:
 *   enc:<base64 iv>:<base64 ciphertext>:<base64 auth-tag>
 *
 * NOT: Anahtar artık koda gömülü değil. Anahtara (veya
 * DATABASEMCP_MASTER_KEY) erişen herkes VT şifrelerini çözebilir.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ---- LEGACY (geriye uyum) ANAHTAR ------------------------------------------
// Eski sürümde koda gömülüydü. Şimdi anahtar dosyadan/ortamdan okunuyor.
// Bu değer SADECE eski şifreli değerleri çözmek için kullanılır.
const LEGACY_MASTER_KEY_HEX =
  'c66483aa37123950bb155fe98404d07483f0933297e5998a24716f48b65f1707';
const LEGACY_MASTER_KEY = Buffer.from(LEGACY_MASTER_KEY_HEX, 'hex');

if (LEGACY_MASTER_KEY.length !== 32) {
  throw new Error('LEGACY_MASTER_KEY 32 byte (AES-256) olmalıdır.');
}

const ENC_PREFIX = 'enc:';
const IV_BYTES = 12; // AES-GCM önerilen iv boyutu

/** Global konfigürasyon dizini yolunu döndürür. */
function globalConfigDir() {
  const base = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'databaseMCP');
}

/**
 * Aktif master anahtarını (32 byte Buffer) döndürür.
 * Önce ortam değişkeni, sonra global master.key dosyası.
 * Bulamazsa hata verir (fail-closed).
 * @returns {Buffer}
 */
function loadMasterKey() {
  // 1. Ortam değişkeni
  const envKey = (process.env.DATABASEMCP_MASTER_KEY || '').trim();
  if (envKey !== '') {
    const key = Buffer.from(envKey, 'hex');
    if (key.length !== 32) {
      throw new Error('DATABASEMCP_MASTER_KEY 32 byte (64 hex) olmalıdır.');
    }
    return key;
  }

  // 2. Global dosya
  const keyPath = path.join(globalConfigDir(), 'master.key');
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) {
      throw new Error(`master.key 32 byte (64 hex) olmalıdır: ${keyPath}`);
    }
    return key;
  }

  throw new Error(
    'Master anahtar bulunamadı. DATABASEMCP_MASTER_KEY ortam değişkenini ayarlayın ' +
      'veya install.sh çalıştırın (~/.config/databaseMCP/master.key oluşturur).'
  );
}

let _masterKey = null;
/** Aktif anahtarını (cache'li) döndürür. */
function getMasterKey() {
  if (_masterKey === null) {
    _masterKey = loadMasterKey();
  }
  return _masterKey;
}

/**
 * Düz metin şifreyi şifreli formata çevirir. Aktif anahtarını kullanır.
 * @param {string} plain
 * @returns {string}
 */
function encrypt(plain) {
  if (plain === undefined || plain === null) return plain;
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plain), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;
}

/**
 * Şifreli değeri (enc:...) belirli bir anahtarla düz metne çevirir.
 * Belirli anahtar uymazsa hata verir (deneme/yanlış sırası çağrıdan yönetilir).
 * @param {string} enc
 * @param {Buffer} key
 * @returns {string}
 */
function decryptWithKey(enc, key) {
  if (typeof enc !== 'string' || !enc.startsWith(ENC_PREFIX)) {
    return enc;
  }
  const parts = enc.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Geçersiz şifreli değer formatı (enc:iv:ct:tag beklendi).');
  }
  const iv = Buffer.from(parts[0], 'base64url');
  const ciphertext = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Şifreli değeri (enc:...) düz metne çevirir.
 * Önce aktif anahtarını, olmazsa legacy anahtarını dener.
 * Her ikisi de başarısızsa açık hata verir.
 * @param {string} enc
 * @returns {string}
 */
function decrypt(enc) {
  if (typeof enc !== 'string' || !enc.startsWith(ENC_PREFIX)) {
    // Şifreli değilse olduğu gibi döndür (güvenlik için düz metin olarak kullanılır).
    return enc;
  }
  const parts = enc.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Geçersiz şifreli değer formatı (enc:iv:ct:tag beklendi).');
  }
  try {
    return decryptWithKey(enc, getMasterKey());
  } catch (e) {
    // Legacy anahtarla dene (eski şifreli değerler için)
    try {
      return decryptWithKey(enc, LEGACY_MASTER_KEY);
    } catch (e2) {
      throw new Error('Şifre çözülemedi: yanlış anahtar veya bozulmuş veri.');
    }
  }
}

/**
 * Bir değerin şifreli olup olmadığını döndürür.
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Yeni bir master anahtar üretir (32 byte -> 64 hex karakter).
 * install.sh tarafından kullanılır.
 * @returns {string}
 */
function generateMasterKeyHex() {
  return crypto.randomBytes(32).toString('hex');
}

export {
  encrypt,
  decrypt,
  decryptWithKey,
  isEncrypted,
  loadMasterKey,
  getMasterKey,
  generateMasterKeyHex,
  globalConfigDir,
  LEGACY_MASTER_KEY_HEX,
  LEGACY_MASTER_KEY,
};