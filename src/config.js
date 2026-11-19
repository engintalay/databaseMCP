'use strict';

/**
 * Konfigürasyon yönetimi.
 *
 * - Manuel sunucu ekleme: kullanıcı config.json'a bağlantıları elle yazar,
 *   otomatik keşif yoktur.
 * - Şifre koruması: kullanıcı şifreleri DÜZ METIN olarak yazar. Uygulama
 *   başladığında düz metin şifreleri gömülü master anahtarla şifreler ve
 *   config.json'a geri yazar. Sonraki başlatmalarda değer "enc:..." ile
 *   başladığı için şifreleme atlanır, çözülüp kullanılır.
 * - environment (kategori): her bağlantıda ZORUNLU. "test" veya "prod".
 *   Belirtilmezse sunucu başlatmaz.
 */

const fs = require('node:fs');
const path = require('node:path');
const { encrypt, decrypt, isEncrypted } = require('./crypto');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Config dosyasını oku, düz metin şifreleri şifrele, gerekirse geri yaz.
 * @param {string} [configPath]
 * @returns {{ connections: object, configPath: string, encrypted: string[] }}
 */
function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    return { connections: {}, configPath, encrypted: [] };
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new Error(`config dosyası okunamadı: ${configPath} (${e.message})`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config JSON parse hatası: ${configPath} (${e.message})`);
  }

  const connections = data.connections || {};
  const encrypted = [];

  for (const [name, conn] of Object.entries(connections)) {
    // type zorunlu (pg | sybase) — backend'i belirler.
    if (!conn.type || (conn.type !== 'pg' && conn.type !== 'sybase')) {
      throw new Error(
        `"${name}" bağlantısında "type" alanı zorunlu (pg | sybase).`
      );
    }
    // environment zorunlu
    if (!conn.environment || (conn.environment !== 'test' && conn.environment !== 'prod')) {
      throw new Error(
        `"${name}" bağlantısında "environment" alanı zorunlu (test | prod).`
      );
    }
    // şifre: düz metinse şifrele, geri yaz
    if (typeof conn.password === 'string' && conn.password !== '' && !isEncrypted(conn.password)) {
      conn.password = encrypt(conn.password);
      encrypted.push(name);
    }
  }

  if (encrypted.length > 0) {
    try {
      fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
      // Şifreleme başarısız olsa da çalışmayı durdurmayalım; bağlantı anında
      // düz metin olarak kullanılmaya çalışılır (uyarı zaten verildi).
      console.warn(`[config] şifreli değerler yazamadı: ${configPath} (${e.message})`);
    }
    console.log(`[config] ${encrypted.length} bağlantının şifresi şifrelendi: ${encrypted.join(', ')}`);
  }

  return { connections, configPath, encrypted };
}

/**
 * Şifreli şifreyi çözerek bağlantı nesnesini döndürür.
 * @param {object} conn
 * @returns {object}
 */
function resolveConnection(conn) {
  const resolved = { ...conn };
  if (typeof resolved.password === 'string' && isEncrypted(resolved.password)) {
    resolved.password = decrypt(resolved.password);
  }
  return resolved;
}

module.exports = { loadConfig, resolveConnection, DEFAULT_CONFIG_PATH };
