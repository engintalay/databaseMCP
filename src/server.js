'use strict';

/**
 * databaseMCP — MCP stdio sunucusu.
 *
 * Araçlar:
 *   list_tables            - bir bağlantıdaki kullanıcı tablolarını listeler
 *   describe_table         - tablo tanımı (sütunlar)
 *   describe_schema        - global şema (schema.yaml) tanımı, sorgu bağlamı
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

const path = require('node:path');
const fs = require('node:fs');

const yaml = require('js-yaml');
const config = require('./config');
const { SybaseManager } = require('./db/sybase');
const pg = require('./db/pg');
const excel = require('./excel');
const csv = require('./csv');
const io = require('./io');

const SERVER_INFO = { name: 'databaseMCP', version: '1.0.0' };

// ---- Global şema tanımı (schema.yaml) --------------------------------------
//
// ~/.config/databaseMCP/schema.yaml — insanın okuyabileceği, makinenin
// sorgu kurarken bağlam olarak kullanabileceği global şema. Foreign key
// olmadığı için ilişkiler `confidence` (high/medium/low) ile işaretlidir.
// Dosya mevcut değilse sunucu yine de başlar (şema opsiyoneldir).

/**
 * Global şema dosyasını yükler. Yoksa null döndürür ve uyarır.
 * @returns {object|null}
 */
function loadSchema() {
  const schemaPath = path.join(config.globalConfigPath(), '..', 'schema.yaml');
  if (!fs.existsSync(schemaPath)) {
    console.warn(`[server] schema.yaml bulunamadı: ${schemaPath} (şemanın bağlamı kullanılmayacak)`);
    return null;
  }
  try {
    const doc = yaml.load(fs.readFileSync(schemaPath, 'utf8'));
    console.log(`[server] schema.yaml yüklendi: ${Object.keys((doc && doc.databases) || {}).join(', ') || '(veritabanı yok)'}`);
    return doc;
  } catch (e) {
    console.warn(`[server] schema.yaml okunamadı: ${e.message}`);
    return null;
  }
}

const schema = loadSchema();

/**
 * Belirli bir ortamın (test|prod) tablo tanımlarını döndürür.
 * @param {string} env
 */
function schemaTables(env) {
  if (!schema || !schema.databases) return {};
  return (schema.databases[env] && schema.databases[env].tables) || {};
}

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

/**
 * Global şemadan bir ortamın (test|prod) tablo tanımlarını okunabilir metne
 * çevirir. İlişkiler (confidence + source) dahil.
 * @param {string} env
 */
function schemaText(env) {
  if (!schema) {
    return 'Global şema (schema.yaml) yüklenmedi.';
  }
  const db = schema.databases[env];
  if (!db) {
    return `"${env}" ortamı şemada tanımlı değil. Mevcut ortamlar: ` +
      Object.keys(schema.databases).join(', ');
  }
  const tables = db.tables || {};
  const lines = [];
  lines.push(`Şema ortamı: ${env}  (bağlantı: ${db.connection || '?'})`);
  lines.push(`Açıklama: ${String(db.description || '').replace(/\s+/g, ' ').trim()}`);
  lines.push('');

  // _NOT gibi meta anahtarları atla
  const tableNames = Object.keys(tables).filter((k) => k !== '_NOT');
  for (const name of tableNames) {
    const t = tables[name];
    lines.push(`### ${name}`);
    if (t.description) lines.push(`  ${String(t.description).replace(/\s+/g, ' ').trim()}`);
    if (t.primary_key) lines.push(`  Anahtar: ${Array.isArray(t.primary_key) ? t.primary_key.join(', ') : t.primary_key}`);
    if (t.columns) {
      const cols = Object.entries(t.columns).map(([c, info]) => {
        const pk = info.pk ? ' [PK]' : '';
        return `  • ${c} (${info.type}${pk})`;
      });
      lines.push(cols.join('\n'));
    }
    if (t.relationships && t.relationships.length) {
      const rels = t.relationships.map((r) => {
        const note = r.note ? `  # ${r.note.replace(/\s+/g, ' ')}` : '';
        return `  → ${r.to}  (${r.via})  [confidence: ${r.confidence}, source: ${r.source}]${note}`;
      });
      lines.push(rels.join('\n'));
    }
    lines.push('');
  }

  // Meta: ortak tanımlalar
  if (schema.business_keys) {
    lines.push('--- Ortak İş Anahtarları ---');
    for (const [k, v] of Object.entries(schema.business_keys)) {
      lines.push(`• ${k} (${v.tip})  ->  ${v.birlestirdigi_tabolar.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
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

// 3) describe_schema — global şema tanımı (insan + makine için bağlam)
server.registerTool(
  'describe_schema',
  {
    title: 'Şema Tanımı',
    description: 'Global şema (schema.yaml) tanımı. Bir ortamın (test|prod) tablolarını, sütunlarını ve business-key/ilişki notlarını okunabilir metne çevirir. Sorgu kurarken bağlam olarak kullanın.',
    inputSchema: z.object({
      environment: z.enum(['test', 'prod']).optional().describe('Tanımlanacak ortam (verilen yoksa tüm ortam listesi)'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ environment }) => {
    if (!schema) {
      return ok('Global şema (schema.yaml) tanımlı değil.');
    }
    if (!environment) {
      const envs = Object.keys(schema.databases || {});
      return ok(`Global şema. Mevcut ortamlar: ${envs.join(', ') || '(yok)'}. ` +
        `Kullanım: environment = test | prod.`);
    }
    return ok(schemaText(environment));
  }
);

// 4) run_query
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

// 5) execute  (yazma / DDL — prod reddedilir)
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

// 6) export_query
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

// 7) import_file_to_table  (yazma — prod reddedilir)
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
  const listed = Object.entries(all)
    .map(([name, c]) => `${name} [${c.id || '?'}]`)
    .join(', ');
  console.error(
    `[server] databaseMCP başladı. ${Object.keys(all).length} bağlantı kaydedildi ` +
      `(ortam grupları: ${grouped}).\n  Bağlantılar: ${listed}`
  );
}

main().catch((err) => {
  console.error('[server] başlatma hatası:', err && err.message ? err.message : err);
  process.exit(1);
});
