'use strict';

/**
 * Sybase ASE sarmalısı (node-sybase: Java/JDBC köprüsü + jconn3).
 *
 * Mimari: her sorgu bir `java -jar JavaSybaseLink.jar ...` subprocess'ı açar,
 * JSON satırlarıyla konuşur. Bu sürücünün iki sınırlaması vardır ve burada
 * yönetilir:
 *   1. Sürücü her sorguda process.stdout'a console.log yazar. Bu, MCP'nin
 *      stdio JSON-RPC kanalını bozar. Bu yüzden her sorgu console çıktısını
 *      geçici olarak sustururuz.
 *   2. Yazma (INSERT/UPDATE/DELETE) işlemleri etkilenen satır sayısını
 *      döndürmez (boş dizi). Bu yüzden "yürütüldü" olarak raporlanır.
 *
 * Alan adları: host, port, dbname, username, password.
 */

const path = require('node:path');
const fs = require('node:fs');
const SyBase = require('node-sybase');
const { withNoProxy } = require('../proxy');

// Köprü jar'ının mutlak yolu (manifest Class-Path 'lib/...' jar'ın kendi
// konumuna göre çözülür, bu yüzden CWD'den bağımsızdır).
const JAR_PATH = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-sybase',
  'dist',
  'sybase',
  'JavaSybaseLink',
  'dist',
  'JavaSybaseLink.jar',
);

const SYBASE_PORT = 5000;

/**
 * console çıktısını geçici olarak susturur (MCP stdio kanalını korumak için).
 */
function quietConsole(fn) {
  const orig = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  const silent = () => {};
  console.log = console.error = console.warn = console.info = console.debug = silent;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.assign(console, orig);
    });
}

/**
 * Sybase sarmalısı. Başlatmada bağlantı açmaz (min:0); ilk sorguda açar.
 * @param {Array<object>} connections - [{name, host, port, dbname, username, password, environment, poolMax}]
 */
class SybaseManager {
  constructor(connections) {
    if (!Array.isArray(connections) || connections.length === 0) {
      throw new Error('SybaseManager: en az bir bağlantı gerekli.');
    }

    const DBInfos = connections.map((c) => ({
      name: c.name,
      host: c.host,
      port: Number(c.port) || SYBASE_PORT,
      dbname: c.dbname,
      username: c.username,
      password: c.password,
      jarPath: JAR_PATH,
      max: c.poolMax || 5,
      min: 0, // başlatmada bağlantı açma (yavaş/hataya açık başlatmayı önler)
    }));

    if (!fs.existsSync(JAR_PATH)) {
      throw new Error(`Sybase köprü jar'ı bulunamadı: ${JAR_PATH}`);
    }

    this.jarPath = JAR_PATH;
    this.sybase = new SyBase(DBInfos);
  }

  /** Bağlantı adlarını döndürür. */
  listConnections() {
    return Object.keys(this.sybase.DBPools || {});
  }

  /** Adın geçerli bir bağlantı olup olmadığını döndürür. */
  has(name) {
    return Boolean(name) && Boolean(this.sybase.DBPools[name]);
  }

  /**
   * Raw exec (node-sybase). Promise -> (err, data).
   * @param {string} name
   * @param {string} sql
   */
  execRaw(name, sql) {
    return quietConsole(() => {
      if (!this.has(name)) {
        return Promise.reject(new Error(`Sybase bağlantısı bulunamadı: "${name}"`));
      }
      return this.sybase.exec(sql, name);
    });
  }

  /**
   * Kullanıcı tablolarını (sysobjects) döndürür.
   * @param {string} name
   */
  async listTables(name) {
    return withNoProxy(async () => {
      const data = await this.execRaw(name, `SELECT name FROM sysobjects WHERE type = 'U' ORDER BY name`);
      return normalizeResult(data);
    });
  }

  /**
   * Okuma sorgusunu normalize edilmiş {rows, columns} olarak döndürür.
   * @param {string} name
   * @param {string} sql
   * @param {number} [limit]
   */
  async query(name, sql, limit) {
    return withNoProxy(async () => {
      let rawSql = sql.trim();
      if (!rawSql.endsWith(';')) rawSql += ';';
      if (limit && limit > 0 && !/\blimit\b/i.test(rawSql)) {
        rawSql += ` LIMIT ${Number(limit)}`;
      }
      const data = await this.execRaw(name, rawSql);
      return normalizeResult(data);
    });
  }

  /**
   * Yazma / DDL. Etkilenen satır sayısı sürücü tarafından döndürülmez.
   * @param {string} name
   * @param {string} sql
   */
  async execute(name, sql) {
    return withNoProxy(async () => {
      const data = await this.execRaw(name, sql.trim());
      const normalized = normalizeResult(data);
      return {
        success: true,
        // Sürücü write için etkilenen satır sayısını döndürmez.
        rowCount: 0,
        affectedUnknown: true,
      };
    });
  }

  /**
   * Toplu ekleme. node-sybase pool her çağrıda bağlantıyı bıraktığı için tüm
   * INSERT'ler tek bir exec içinde (; ile) gönderilir ve BEGIN/COMMIT ile
   * atomik yapılır.
   * @param {string} name
   * @param {string} table
   * @param {Array<string>} headers
   * @param {Array<object>} rows
   */
  async bulkInsert(name, table, headers, rows) {
    return withNoProxy(async () => {
      const sql = buildBulkInsert(table, headers, rows);
      const data = await this.execRaw(name, sql);
      const normalized = normalizeResult(data);
      return {
        success: true,
        rowCount: normalized.rows.length,
        affectedUnknown: true,
      };
    });
  }

  /**
   * Tablo tanımı (sp_columns). İlk result set döndürülür.
   * @param {string} name
   * @param {string} tableName
   */
  async describeTable(name, tableName) {
    return withNoProxy(async () => {
      const data = await this.execRaw(name, `sp_columns '${tableName.replace(/'/g, "''")}'`);
      // sp_columns birden fazla result set döndürür; ilkini kullan.
      return normalizeResult(data);
    });
  }
}

/**
 * Sürücü çıktısını ({rows, columns}) normalizer.
 * null değerler sürücü tarafından atlandığı için sütunlar tüm satırdan birleştirilir.
 * @param {*} data
 * @returns {{rows: Array<object>, columns: Array<string>}}
 */
function normalizeResult(data) {
  const rows = [];
  const columnSet = new Set();

  const addRows = (resultSet) => {
    if (!Array.isArray(resultSet)) return;
    for (const row of resultSet) {
      if (row && typeof row === 'object') {
        rows.push(row);
        for (const k of Object.keys(row)) columnSet.add(k);
      }
    }
  };

  // Tek result set (düzeltme: array of rows) veya birden fazla (array of arrays).
  if (Array.isArray(data)) {
    if (data.length === 0) {
      // Boş (write veya sıfır satırlı select).
    } else if (Array.isArray(data[0])) {
      // Birden fazla result set. İlkini al.
      addRows(data[0]);
    } else {
      // Tek result set.
      addRows(data);
    }
  } else if (data && typeof data === 'object') {
    addRows([data]);
  }

  return { rows, columns: Array.from(columnSet) };
}

/**
 * Toplu INSERT cümlelerini (; ile ayrılmış tek bir SQL dizisi oluşturur.
 * @param {string} table
 * @param {Array<string>} headers
 * @param {Array<object>} rows
 * @returns {string}
 */
function buildBulkInsert(table, headers, rows) {
  const colList = headers.map((c) => `[${c}]`).join(', ');
  const statements = rows.map((row) => {
    const vals = headers.map((h) => quoteSybase(row[h])).join(', ');
    return `INSERT INTO [${table}] (${colList}) VALUES (${vals})`;
  });
  return `BEGIN TRANSACTION; ${statements.join('; ')}; COMMIT;`;
}

/**
 * Sybase ASE için değeri SQL literal'a çevirir.
 * @param {*} v
 * @returns {string}
 */
function quoteSybase(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

module.exports = { SybaseManager, normalizeResult, buildBulkInsert, quoteSybase, JAR_PATH };
