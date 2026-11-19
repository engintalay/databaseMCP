'use strict';

/**
 * Konfigürasyon yönetimi.
 *
 * İki katman desteklenir:
 *
 *   1. GLOBAL (kullanıcı seviyesi) — paylaşım bağlantıları + şifreler.
 *      Varsayılan: $XDG_CONFIG_HOME/databaseMCP/config.json
 *      (XDG_CONFIG_HOME yoksa ~/.config/databaseMCP/config.json).
 *      Git'e düşmez; birden fazla araç/proje tarafından paylaşılır.
 *
 *   2. PROJE (yerel) — o projeye özel bağlantılar.
 *      Varsayılan: proje kökündeki config.json
 *      (DATABASEMCP_CONFIG ortam değişkeniyle manuel yol verilebilir).
 *
 * Birleştirme: proje bağlantısı, aynı adlı global bağlantının üzerine yazar.
 * Böylece bir bağlantı globalde tanımlı olup projede host/port gibi alanlarla
 * ezilebilir (ör. projeye özel test sunucusu).
 *
 * Şifre koruması: kullanıcı şifreleri DÜZ METIN olarak yazar. Uygulama
 * başladığında düz metin şifreleri gömülü master anahtarla şifreler ve şifreyi
 * yazdığı dosyaya (global veya proje) geri yazar. Sonraki başlatmalarda değer
 * "enc:..." ile başladığı için şifreleme atlanır, çözülüp kullanılır.
 *
 * environment (kategori): her bağlantıda ZORUNLU. "test" veya "prod".
 * Belirtilmezse sunucu başlatmaz.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { encrypt, decrypt, isEncrypted } = require('./crypto');

/** Varsayılan proje kökündeki config yolu (eski davranış / geriye uyum). */
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

/**
 * Global (kullanıcı seviyesi) config dosyasının varsayılan yolunu döndürür.
 * @returns {string}
 */
function globalConfigPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'databaseMCP', 'config.json');
}

/**
 * Proje (yerel) config dosyasının varsayılan yolunu döndürür.
 * DATABASEMCP_CONFIG ortam değişkeni varsa onu, yoksa proje kökünü kullanır.
 * @returns {string}
 */
function projectConfigPath() {
  return process.env.DATABASEMCP_CONFIG || DEFAULT_CONFIG_PATH;
}

/**
 * Belirtilen dosyadaki bağlantıları oku, düz metin şifreleri şifrele,
 * gerekiyse o dosyaya geri yaz.
 * @param {string} configPath
 * @returns {{ connections: object, encrypted: string[] }}
 */
function loadFileConnections(configPath) {
  if (!fs.existsSync(configPath)) {
    return { connections: {}, encrypted: [] };
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
    // şifre: düz metinse şifrele, o dosyaya geri yaz
    if (typeof conn.password === 'string' && conn.password !== '' && !isEncrypted(conn.password)) {
      conn.password = encrypt(conn.password);
      encrypted.push(name);
      try {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      } catch (e) {
        // Şifreleme başarısız olsa da çalışmayı durdurmayalım; bağlantı anında
        // düz metin olarak kullanılmaya çalışılır (uyarı zaten verildi).
        console.warn(`[config] şifreli değerler yazamadı: ${configPath} (${e.message})`);
      }
    }
  }

  return { connections, encrypted };
}

/**
 * Global + proje bağlantılarını birleştirir.
 * Proje bağlantısı aynı isimdeyse global olanın üzerine yazar.
 * @returns {{
 *   connections: object,
 *   globalConfigPath: string,
 *   projectConfigPath: string,
 *   encrypted: string[],
 * }}
 */
function loadConfig() {
  const gPath = globalConfigPath();
  const pPath = projectConfigPath();

  const global = loadFileConnections(gPath);
  const project = loadFileConnections(pPath);

  // Proje, globalin üzerine yazar (aynı adlı bağlantılar projeye göre ezilir).
  const connections = { ...global.connections, ...project.connections };

  return {
    connections,
    globalConfigPath: gPath,
    projectConfigPath: pPath,
    configPath: pPath, // geriye uyum
    encrypted: [...global.encrypted, ...project.encrypted],
  };
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

module.exports = {
  loadConfig,
  resolveConnection,
  globalConfigPath,
  projectConfigPath,
  DEFAULT_CONFIG_PATH,
};
