'use strict';

/**
 * databaseMCP — MCP stdio sunucusu.
 *
 * Araçlar:
 *   list_tables            - bir bağlantıdaki kullanıcı tablolarını listeler
 *   describe_table         - tablo tanımı (sütunlar)
 *   run_query              - okuma (SELECT)
 *   execute                - yazma / DDL (test ortamında; prod bağlantısında reddedilir)
 *   export_query           - SELECT -> .xlsx/.csv (output/ klasörüne)
 *   import_file_to_table   - .csv/.xlsx -> tabloya toplu ekleme (test ortamında; prod reddedilir)
 *
 * Kategori kuralları:
 *   - test ortamı  -> tam CRUD (okuma + yazma) izinli.
 *   - prod ortamı  -> salt-okunur. Yazma araçları (execute, import_file_to_table)
 *                     açıkça hata ile reddedilir.
 *
 * Bağlantılar config.json içinde manuel tanımlıdır (otomatik keşif yoktur).
 * Her bağlantıda "type" (pg | sybase) ve "environment" (test | prod) zorunludur.
* Sunum: her araç çıktısı çalışılan ortamı (test | prod) içerir; başlatma mesajı
*   bağlantıları ortam gruplarına göre özetler. config.json düz kalır.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const config = require('./config');
const { SybaseManager } = require('./db/sybase');
const pg = require('./db/pg');
const excel = require('./excel');
const csv = require('./csv');
const io = require('./io');

const SERVER_INFO = { name: 'databaseMCP', version: '1.0.0' };

// ---- Bağlantı yönetimi -----------------------------------------------------

/**
 * Config'den çözülmüş (şifresi çözülmüş) bağlantıları tipine göre ayırır ve
 * Sybase yöneticisini kurar.
 * @returns {{ pg: object[], sybase: SybaseManager|null, all: object }}
 */
function buildConnections() {
  const { connections } = config.loadConfig();

  const pgConns = [];
  const sybaseConns = [];
  for (const [name, conn] of Object.entries(connections)) {
    const resolved = config.resolveConnection(conn);
    if (resolved.type === 'sybase') {
      sybaseConns.push({ name, ...resolved });
    } else {
      pgConns.push({ name, ...resolved });
    }
  }

  const sybase = sybaseConns.length > 0 ? new SybaseManager(sybaseConns) : null;
  return { pg: pgConns, sybase, all: connections };
}

const { pg: pgConns, sybase, all } = buildConnections();

if (Object.keys(all).length === 0) {
  console.warn(
    '[server] config.json boş veya mevcut. Bağlantı eklenene kadar araçlar çalışmaz. ' +
      'Örnek için config.example.json\'a bakın.'
  );
}

/**
 * Adı geçerli bir bağlantıyı (şifresi çözülmüş) döndürür.
 * @param {string} name
 * @returns {object}
 */
function getConnection(name) {
  const conn = all[name];
  if (!conn) {
    const listed = Object.keys(all).length ? Object.keys(all).join(', ') : '(boş)';
    throw new Error(`Bağlantı bulunamadı: "${name}". Mevcut bağlantılar: ${listed}`);
  }
  return config.resolveConnection(conn);
}

/**
 * Yazma aracı için: prod bağlantısıysa açıkça reddet (salt-okunur).
 * @param {string} name
 * @returns {object}
 */
function requireWrite(name) {
  const conn = getConnection(name);
  if (conn.environment === 'prod') {
    throw new Error(
      `"${name}" prod bağlantısıdır (salt-okunur). Yazma işlemi (execute) izin verilmiyor.`
    );
  }
  return conn;
}

/**
 * Bağlantı tipine göre arka uca ulaştırır.
 * @param {string} name
 * @param {Function} fn - (backend, conn) => Promise
 * @returns {Promise<*>}
 */
async function withConn(name, fn) {
  const conn = getConnection(name);
  if (conn.type === 'sybase') {
    if (!sybase || !sybase.has(name)) {
      throw new Error(`Sybase bağlantısı kullanılamaz: "${name}"`);
    }
    return fn('sybase', conn);
  }
  if (conn.type === 'pg') {
    return fn('pg', conn);
  }
  throw new Error(`"${name}" bağlantısının "type" alanı geçersiz: ${conn.type}`);
}

/** Okuma sonucu (rows, columns) -> sütun adlarını çıkar. */
function inferColumns(rows) {
  const cols = [];
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        if (!cols.includes(k)) cols.push(k);
      }
    }
  }
  return cols;
}

// ---- Sonuç biçimlendirme ---------------------------------------------------

function ok(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function tablesText(rows, environment) {
  const lines = rows.map((r) => {
    const name = r.table_name;
    return r.table_schema ? `${r.table_schema}.${name}` : name;
  });
  const envLine = environment ? `Ortam: ${environment}\n` : '';
  return `${envLine}Toplam ${rows.length} tablo:\n${lines.join('\n') || '(tablo yok)'}`;
}

function columnsText(rows, environment) {
  const lines = rows.map((r) => {
    const nullable = r.is_nullable === 'YES' ? ', nullable' : '';
    const def = r.column_default !== null && r.column_default !== undefined ? `  default: ${r.column_default}` : '';
    return `• ${r.column_name}  (${r.data_type}${nullable})${def}`;
  });
  const envLine = environment ? `Ortam: ${environment}\n` : '';
  return `${envLine}Tablo sütunları (${rows.length}):\n${lines.join('\n') || '(sütun yok)'}`;
}

function queryResultText(connection, environment, result) {
  const out = {
    connection,
    environment,
    satir_sayisi: result.rows.length,
    sutunlar: result.columns,
    veriler: result.rows,
  };
  return JSON.stringify(out, null, 2);
}

// ---- Sunucu ------------------------------------------------------------

const server = new McpServer(SERVER_INFO);

// 1) list_tables
server.registerTool(
  'list_tables',
  {
    title: 'Tablo Listesi',
    description: 'Bir bağlantıdaki kullanıcı tablolarını listeler. PostgreSQL için isteğe bağlı şema filtresi.',
    inputSchema: z.object({
      connection: z.string().describe('config.json içindeki bağlantı adı'),
      schema: z.string().optional().describe('PostgreSQL için şema ile filtrele (opsiyonel)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ connection, schema }) => {
    const conn = getConnection(connection);
    let rows;
    if (conn.type === 'sybase') {
      rows = await sybase.listTables(connection);
    } else {
      rows = await pg.listTables(conn, schema);
    }
    return ok(tablesText(rows, conn.environment));
  }
);

// 2) describe_table
server.registerTool(
  'describe_table',
  {
    title: 'Tablo Tanımı',
    description: 'Bir tablonun sütunlarını (ad, tip, nullable, default) listeler.',
    inputSchema: z.object({
      connection: z.string().describe('config.json içindeki bağlantı adı'),
      table: z.string().describe('Tanımı istenen tablo adı'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ connection, table }) => {
    const conn = getConnection(connection);
    let rows;
    if (conn.type === 'sybase') {
      rows = await sybase.describeTable(connection, table);
    } else {
      rows = await pg.describeTable(conn, table);
    }
    return ok(columnsText(rows, conn.environment));
  }
);

// 3) run_query
server.registerTool(
  'run_query',
  {
    title: 'Sorgu Çalıştır',
    description: 'Okuma (SELECT) sorgusu çalıştırır. Satır isteğe bağlı.',
    inputSchema: z.object({
      connection: z.string().describe('config.json içindeki bağlantı adı'),
      query: z.string().describe('Çalıştırılacak SQL sorgusu (SELECT)'),
      limit: z.number().int().positive().optional().describe('Döndürülecek maksimum satır sayısı (opsiyonel)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ connection, query, limit }) => {
    const conn = getConnection(connection);
    let result;
    if (conn.type === 'sybase') {
      result = await sybase.query(connection, query, limit);
    } else {
      result = await pg.runQuery(conn, query, limit);
      result.columns = result.columns || inferColumns(result.rows);
    }
    return ok(queryResultText(connection, conn.environment, result));
  }
);

// 4) execute  (yazma / DDL — prod reddedilir)
server.registerTool(
  'execute',
  {
    title: 'Yürüt',
    description: 'Yazma / DDL işlemi çalıştır (INSERT/UPDATE/DELETE/DDL). Prod bağlantısında reddedilir.',
    inputSchema: z.object({
      connection: z.string().describe('config.json içindeki bağlantı adı'),
      query: z.string().describe('Çalıştırılacak SQL (yazma/DDL)'),
    }),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ connection, query }) => {
    requireWrite(connection); // prod kontrolü
    const conn = getConnection(connection);
    if (conn.type === 'sybase') {
      const res = await sybase.execute(connection, query);
      const note = res.affectedUnknown
        ? ' Etkilenen satır sayısı sürücü tarafından döndürülmedi; sorgu yürütüldü.'
        : ` Etkilenen satır sayısı: ${res.rowCount}.`;
      return ok(`Yürütüldü.${note}`);
    }
    const res = await pg.execute(conn, query);
    return ok(`Başarılı. Etkilenen satır sayısı: ${res.rowCount}.`);
  }
);

// 5) export_query
server.registerTool(
  'export_query',
  {
    title: 'Sorguyu Dışa Aktar',
    description: 'Bir SELECT sorgusunun sonucunu .xlsx/.csv olarak output/ klasörüne yazar.',
    inputSchema: z.object({
      connection: z.string().describe('config.json içindeki bağlantı adı'),
      query: z.string().describe('Dışa aktarılacak SELECT sorgusu'),
      filename: z.string().describe('Çıktı dosya adı (örn. sonuc.xlsx)'),
      format: z.enum(['xlsx', 'csv']).optional().describe('Dosya formatı (opsiyonel; dosya uzantısından da anlaşılr)'),
      limit: z.number().int().positive().optional().describe('Döndürülecek maksimum satır sayısı (opsiyonel)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ connection, query, filename, format, limit }) => {
    if (!filename) throw new Error('filename zorunludur.');
    const conn = getConnection(connection);
    let result;
    if (conn.type === 'sybase') {
      result = await sybase.query(connection, query, limit);
    } else {
      result = await pg.runQuery(conn, query, limit);
      result.columns = result.columns || inferColumns(result.rows);
    }
    const columns = result.columns && result.columns.length ? result.columns : inferColumns(result.rows);
    const fmt = format || io.detectFormat(filename) || 'xlsx';
    let written;
    if (fmt === 'csv') {
      written = await csv.exportTo(result.rows, columns, filename);
    } else {
      written = await excel.exportTo(result.rows, columns, filename);
    }
    return ok(`[${conn.environment}] ${fmt.toUpperCase()} olarak kaydedildi: ${written.path} (${written.rowCount} satır)`);
  }
);

// 6) import_file_to_table  (yazma — prod reddedilir)
server.registerTool(
  'import_file_to_table',
  {
    title: 'Dosyayı Tabloya İçe Aktar',
    description: '.csv/.xlsx dosyasındaki satırları belirtilen tabloya toplu ekleme yapar. Prod bağlantusunda reddedilir.',
    inputSchema: z.object({
      connection: z.string().describe('config.json içindeki bağlantı adı'),
      file: z.string().describe('İçe aktarılacak dosya adı (output/ altında ya da mutlak yol)'),
      table: z.string().describe('Satırların ekleneceği tablo adı'),
      format: z.enum(['xlsx', 'csv']).optional().describe('Dosya formatı (opsiyonel; dosya uzantısından da anlaşılr)'),
    }),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ connection, file, table, format }) => {
    if (!file) throw new Error('file zorunludur.');
    if (!table) throw new Error('table zorunludur.');
    requireWrite(connection); // prod kontrolü
    const conn = getConnection(connection);

    const fmt = format || io.detectFormat(file) || 'csv';
    const filePath = io.resolveInputPath(file);
    const { headers, rows } =
      fmt === 'csv' ? await csv.importFrom(filePath) : await excel.importFrom(filePath);

    if (rows.length === 0) {
      throw new Error('Dosyada veri satırı bulunamadı.');
    }
    if (headers.length === 0) {
      throw new Error('Dosyada başlık (sütun) satırı bulunamadı.');
    }

    let result;
    if (conn.type === 'sybase') {
      result = await sybase.bulkInsert(connection, table, headers, rows);
    } else {
      result = await pg.bulkInsert(conn, table, headers, rows);
    }
    return ok(`[${conn.environment}] ${result.rowCount} satır "${table}" tablosuna eklendi (${fmt.toUpperCase()}).`);
  }
);

// ---- Başlatma --------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const byEnv = {};
  for (const conn of Object.values(all)) {
    const e = conn.environment || '?';
    byEnv[e] = (byEnv[e] || 0) + 1;
  }
  const grouped = Object.entries(byEnv).map(([e, n]) => `${e}: ${n}`).join(', ');
  console.error(`[server] databaseMCP başladı. ${Object.keys(all).length} bağlantı kaydedildi (ortam grupları: ${grouped}).`);
}

main().catch((err) => {
  console.error('[server] başlatma hatası:', err && err.message ? err.message : err);
  process.exit(1);
});
