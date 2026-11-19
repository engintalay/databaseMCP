'use strict';

/**
 * Şifreleme katmanı.
 *
 * Master anahtar UYGULAMA KODUNA GÖMÜLÜDÜR (aşağıdaki MASTER_KEY_HEX).
 * Bu anahtarla VT şifreleri AES-256-GCM (kimlik doğrulamalı) ile şifrelenir.
 *
 * Config dosyasında şifreli değerler şu formatta saklanır:
 *   enc:<base64 iv>:<base64 ciphertext+tag>
 *
 * NOT: Master anahtar kodd olduğu için, uygulama kaynağına erişen herkes
 * VT şifrelerini çözebilir. Bu bireysel/single-tool kullanım için kabul
 * edilebilir bir takasadır. Kodu kimseyle paylaşmayın.
 */

const crypto = require('node:crypto');

// ---- GÖMÜLU MASTER ANAHTAR (32 byte = AES-256) ---------------------------
// Bu değeri değiştirmek için aşağıdaki hex'i değiştirin ve config'i yeniden
// şifreleyin (esken şifreli değerler bu anahtarla çözülemez).
const MASTER_KEY_HEX = 'c66483aa37123950bb155fe98404d07483f0933297e5998a24716f48b65f1707';
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');

if (MASTER_KEY.length !== 32) {
  throw new Error('MASTER_KEY 32 byte (AES-256) olmalıdır.');
}

const ENC_PREFIX = 'enc:';
const IV_BYTES = 12; // AES-GCM önerilen iv boyutu

/**
 * Düz metin şifreyi şifreli formata çevirir.
 * @param {string} plain
 * @returns {string}
 */
function encrypt(plain) {
  if (plain === undefined || plain === null) return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plain), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}:${ciphertext.toString('base64url')}:${tag.toString('base64url')}`;
}

/**
 * Şifreli değeri (enc:...) düz metne çevirir.
 * Yanlış anahtar / bozulmuş veri açık hata verir.
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
  const iv = Buffer.from(parts[0], 'base64url');
  const ciphertext = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');

  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error('Şifre çözülemedi: yanlış master anahtar veya bozulmuş veri.');
  }
  return plaintext.toString('utf8');
}

/**
 * Bir değerin şifreli olup olmadığını döndürür.
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted, MASTER_KEY_HEX };
