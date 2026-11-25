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
 * Şifre koruması (şifreler ayrı dosyada): kullanıcı şifreleri config.json
 * içinde DÜZ METIN ya da "enc:..." olarak YAZILABİLİR; ancak sunucu başladığında
 * loader bunları config.json'dan OUTARIP aynı dizindeki `dbpassword.json`
 * dosyasına (id -> enc) taşır. config.json artık şifre içermez ve başkalarıyla
 * PAYLAŞILABİLİR; şifreler yalnızca (git'e düşmeyen) dbpassword.json'da durur.
 *
 * Şifre dosyası (dbpassword.json): { "<bağlantı id>": "<enc şifre>" } biçiminde
 * bir haritadır. Global config için ~/.config/databaseMCP/dbpassword.json, proje
 * config için proje kökündeki dbpassword.json (config.json ile aynı dizin)
 * kullanılır. Anahtar, bağlantının `id` alanıdır.
 *
 * Çözüm: her bağlantının şifresi `id`'siyle dbpassword.json'dan okunur; değer
 * "enc:..." ile başladığı için loader'da çözülmez (resolveConnection çözer),
 * düz metne düşürülüp bağlantıda kullanılır.
 *
 * Şema (ortam bazlı gruplandırma): bağlantılar ortam anahtarları altındadır.
 *   { "test": { "connections": { ... } }, "prod": { "connections": { ... } } }
 * Ortam ("test"/"prod") bağlantının environment bilgisini belirler; her
 * bağlantıda ayrı tekrar yazılmasına gerek yoktur.
 *
 * Her bağlantıya insan okuyabileceği uniq bir `id` atanır (isimden bağımsız;
 * örn. "test-x7k2m9"). `id` hem şifre eşlemesinde (dbpassword.json) anahtar
 * hem de config'e yazıldığı için stabil kalır. `id` tanımlı değilse otomatik
 * üretilip config'e yazılır.
 *
 * Geriye uyum: eski düz şema { "connections": { ... } } de kabul edilir; bu
 * durumda environment her bağlantının kendi alanından okunur ve yeni şemaya
 * geçilmesi için bir uyarı verilir.
 *
 * Sunum için loader, ortam gruplarını düz { name -> conn } haritasına çevirir
 * ve her bağlantının environment/id alanlarını ortamanından doldurur. Böylece
 * tüketiciler (server.js) ortam gruplandırmasından habersiz çalışır.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { encrypt, decrypt, isEncrypted } from './crypto.mjs';

/**
 * İnsan okuyabileceği, uniq bağlantı ID'si üretir. İsimden bağımsızdır;
 * ortama bir prefix ekler ve arkına rastgele okunabilir token koyar.
 * Örnek: "test-x7k2m9". Bir kez üretilip config'e yazıldığı için stabil kalır.
 * @param {string} env
 * @returns {string}
 */
function makeReadableId(env) {
  const token = crypto
    .randomBytes(4)
    .toString('base64url')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 6)
    .toLowerCase();
  return `${env}-${token}`;
}

/** Varsayılan proje kökündeki config yolu (eski davranış / geriye uyum). */
const DEFAULT_CONFIG_PATH = path.join(import.meta.dirname, '..', 'config.json');

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
 * Verilen config dosyasının yanındaki şifre dosyasının yolunu döndürür.
 * dbpassword.json: { "<connection id>": "<enc password>" }.
 * @param {string} configPath
 * @returns {string}
 */
function passwordFilePath(configPath) {
  return path.join(path.dirname(configPath), 'dbpassword.json');
}

/**
 * Şifre dosyasını okuyup { id -> enc } haritası olarak döndürür.
 * Dosya yoksa boş nesne döndürür.
 * @param {string} pwPath
 * @returns {Record<string,string>}
 */
function loadPasswordFile(pwPath) {
  if (!fs.existsSync(pwPath)) return {};

  let raw;
  try {
    raw = fs.readFileSync(pwPath, 'utf8');
  } catch (e) {
    throw new Error(`dbpassword dosyası okunamadı: ${pwPath} (${e.message})`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`dbpassword JSON parse hatası: ${pwPath} (${e.message})`);
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      `dbpassword dosyası geçersiz (nesne { id: enc } bekleniyor): ${pwPath}`
    );
  }
  return data;
}

/**
 * Belirtilen dosyadaki bağlantıları okur.
 *
 * Şifre akışı:
 *   - config.json'da hâlâ `password` alanı varsa (eski davranış) -> değer
 *     (düz metinse master anahtarla şifrelenir) dbpassword.json'a (id -> enc)
 *     taşınır ve config.json'dan OUTARILIR.
 *   - yoksa, bağlantının `id`'siyle dbpassword.json'dan şifre okunur.
 *
 * config.json artık şifre içermez; şifreler yalnızca dbpassword.json'da durur.
 *
 * @param {string} configPath
 * @returns {{ connections: object, encrypted: string[], passwordPath: string }}
 */
function loadFileConnections(configPath) {
  const pwPath = passwordFilePath(configPath);

  if (!fs.existsSync(configPath)) {
    return { connections: {}, encrypted: [], passwordPath: pwPath };
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

  const connections = {};
  const encrypted = [];
  // Şifreler { id -> enc } haritası. Mevcut dbpassword.json'dan başlar.
  const passwords = loadPasswordFile(pwPath);

  // Değişiklik takibi: hangi dosyalar yeniden yazılacak?
  let configDirty = false;
  let pwDirty = false;

  const writeConfig = () => {
    // config.json artık şifre içermez: yazarken her bağlantıdan password
    // alanını düşürüyoruz. Şifre değeri bellekteki connections nesnesinde ve
    // dbpassword.json'da (enc) durur; bu oturumda çözülüp kullanılabilir.
    const publicData = JSON.parse(JSON.stringify(data));
    const stripConnections = (conns) => {
      if (conns && typeof conns === 'object') {
        for (const c of Object.values(conns)) {
          if (c && typeof c === 'object') delete c.password;
        }
      }
    };
    for (const env of ['test', 'prod']) {
      const block = publicData[env];
      if (block && block.connections) stripConnections(block.connections);
    }
    if (publicData.connections) stripConnections(publicData.connections);
    try {
      fs.writeFileSync(configPath, JSON.stringify(publicData, null, 2) + '\n', 'utf8');
    } catch (e) {
      console.warn(`[config] config.json yazılamadı: ${configPath} (${e.message})`);
    }
  };
  const writePasswords = () => {
    try {
      fs.writeFileSync(pwPath, JSON.stringify(passwords, null, 2) + '\n', 'utf8');
    } catch (e) {
      console.warn(`[config] dbpassword.json yazılamadı: ${pwPath} (${e.message})`);
    }
  };

  /**
   * Bir bağlantıyı normalize et: type/env/id kontrolü + şifre yerleştirme.
   * @param {string} name bağlantı anahtarı (isim)
   * @param {object} conn bağlantı nesnesi (data içindena doğrudan referans)
   * @param {string} env ortam (test | prod)
   */
  const normalize = (name, conn, env) => {
    if (!conn.type || (conn.type !== 'pg' && conn.type !== 'sybase')) {
      throw new Error(`"${name}" bağlantısında "type" alanı zorunlu (pg | sybase).`);
    }
    // Ortam, bağlantının environment bilgisini belirler.
    conn.environment = env;
    // İnsan okuyabileceği uniq ID atanır (yoksa üret; şifre eşlemesi anahtarı).
    if (!conn.id) {
      conn.id = makeReadableId(env);
      configDirty = true;
    }
    // Şifre: config.json'daysa dbpassword.json'a taşı (ama bu oturumda
    // kullanabilmek için bellekte enc olarak bırak; config.json yazılırken
    // şifre alanı düşülecek). Yoksa id ile dbpassword.json'dan oku.
    if (typeof conn.password === 'string' && conn.password !== '') {
      const enc = isEncrypted(conn.password) ? conn.password : encrypt(conn.password);
      if (passwords[conn.id] !== enc) {
        passwords[conn.id] = enc;
        pwDirty = true;
      }
      conn.password = enc; // bellekte enc kalır; resolveConnection çözer
      encrypted.push(conn.id);
      configDirty = true; // config.json'dan şifre çıkarılacak (writeConfig düşürür)
    } else if (Object.prototype.hasOwnProperty.call(passwords, conn.id)) {
      // enc değeri; çözümü resolveConnection'da yapılır.
      conn.password = passwords[conn.id];
    } else {
      console.warn(
        `[config] "${name}" bağlantısı (${conn.id}) için dbpassword.json'da şifre bulunamadı.`
      );
    }
    connections[name] = conn;
  };

  // Yeni şema: ortam anahtarları (test / prod) altinda connections.
  for (const env of ['test', 'prod']) {
    const envBlock = data[env];
    if (!envBlock) continue;
    const conns = envBlock.connections || {};
    for (const [name, conn] of Object.entries(conns)) {
      normalize(name, conn, env);
    }
  }

  // Eski düz şema (geriye uyum): connections + her biri environment alanlı.
  if (data.connections) {
    console.warn(
      '[config] Eski düz "connections" şeması algılandı. Yeni ortam bazlı şemaya geçin: ' +
        '{ "test": { "connections": {...} }, "prod": { "connections": {...} } }.'
    );
    for (const [name, conn] of Object.entries(data.connections)) {
      if (!conn.environment || (conn.environment !== 'test' && conn.environment !== 'prod')) {
        throw new Error(`"${name}" bağlantısında "environment" alanı zorunlu (test | prod).`);
      }
      normalize(name, conn, conn.environment);
    }
  }

  // Değişiklikleri yaz (önce şifre dosyası, sonra config).
  if (pwDirty) writePasswords();
  if (configDirty) writeConfig();

  return { connections, encrypted, passwordPath: pwPath };
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

export {
  loadConfig,
  resolveConnection,
  globalConfigPath,
  projectConfigPath,
  DEFAULT_CONFIG_PATH,
};
