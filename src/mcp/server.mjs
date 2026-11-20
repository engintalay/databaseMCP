#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequest, ListToolsRequest } from '@modelcontextprotocol/sdk/types.js';
import { SybaseManager } from '../db/sybase.js';
import { loadConfig, resolveConnection } from '../config.js';

// MCP sunucusu
const server = new Server(
  {
    name: 'databaseMCP',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Bağlantı yöneticisi (lazy init)
let sybaseManager = null;

function getSybaseManager() {
  if (!sybaseManager) {
    const { connections } = loadConfig();
    const resolvedConns = Object.entries(connections).map(([name, conn]) => ({
      name,
      ...resolveConnection(conn),
    }));
    sybaseManager = new SybaseManager(resolvedConns);
  }
  return sybaseManager;
}

// Tool: list_connections — Mevcut bağlantıları listele
const LIST_CONNECTIONS_TOOL = {
  name: 'list_connections',
  description: 'Yapılandırılmış veritabanı bağlantılarını listeler.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

async function listConnections() {
  const mgr = getSybaseManager();
  return { connections: mgr.listConnections() };
}

// Tool: query — Okuma sorgusu çalıştır
const QUERY_TOOL = {
  name: 'query',
  description: 'Bir veritabanı bağlantısında okuma sorgusu çalıştırır. Sonuç {rows, columns} formatında döner.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Bağlantı adı (örn. "RAPOR")' },
      sql: { type: 'string', description: 'Çalıştırılacak SQL sorgusu' },
      limit: { type: 'number', description: 'Maksimum satır sayısı (varsayılan: 100)', default: 100 },
    },
    required: ['connection', 'sql'],
  },
};

async function runQuery(args) {
  const { connection, sql, limit = 100 } = args;
  const mgr = getSybaseManager();
  const result = await mgr.query(connection, sql, limit);
  return result;
}

// Tool: execute — Yazma/DDL çalıştır
const EXECUTE_TOOL = {
  name: 'execute',
  description: 'Bir veritabanı bağlantısında yazma/DDL sorgusu çalıştırır. Etkilenen satır sayısı döner (Sybase için bilinmeyebilir).',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Bağlantı adı (örn. "RAPOR")' },
      sql: { type: 'string', description: 'Çalıştırılacak SQL sorgusu' },
    },
    required: ['connection', 'sql'],
  },
};

async function runExecute(args) {
  const { connection, sql } = args;
  const mgr = getSybaseManager();
  return await mgr.execute(connection, sql);
}

// Tool: list_tables — Tablo listesi
const LIST_TABLES_TOOL = {
  name: 'list_tables',
  description: 'Bir veritabanındaki kullanıcı tablolarını listeler.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Bağlantı adı' },
    },
    required: ['connection'],
  },
};

async function listTables(args) {
  const { connection } = args;
  const mgr = getSybaseManager();
  const result = await mgr.listTables(connection);
  return result;
}

// Tool: describe_table — Tablo tanımı
const DESCRIBE_TABLE_TOOL = {
  name: 'describe_table',
  description: 'Bir tablonun sütun bilgilerini (sp_columns) döner.',
  inputSchema: {
    type: 'object',
    properties: {
      connection: { type: 'string', description: 'Bağlantı adı' },
      table: { type: 'string', description: 'Tablo adı' },
    },
    required: ['connection', 'table'],
  },
};

async function describeTable(args) {
  const { connection, table } = args;
  const mgr = getSybaseManager();
  const result = await mgr.describeTable(connection, table);
  return result;
}

// Tool: find_takip_tables — EVDO_* veritabanlarında TAKIP tablolarını bul
const FIND_TAKIP_TOOL = {
  name: 'find_takip_tables',
  description: 'RAPOR bağlantısındaki EVDO_* veritabanlarında adında "TAKIP" geçen kullanıcı tablolarını bulur.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

async function findTakipTables() {
  const mgr = getSybaseManager();
  const dbs = (await mgr.query('RAPOR', "SELECT name FROM master..sysdatabases WHERE name LIKE 'EVDO_%' ORDER BY name")).rows.map((r) => r.name);

  const ok = [];
  for (const db of dbs) {
    try {
      const r = await mgr.query('RAPOR', `SELECT name FROM ${db}.dbo.sysobjects WHERE type='U' AND name LIKE '%TAKIP%' ORDER BY name`);
      if (r.rows.length > 0) {
        ok.push({ db, tables: r.rows.map((x) => x.name) });
      }
    } catch (e) {
      // Erişilemeyen DB'leri atla
    }
  }

  const totalTables = ok.reduce((acc, o) => acc + o.tables.length, 0);
  const distinctNames = new Set();
  for (const o of ok) for (const t of o.tables) distinctNames.add(t);

  return {
    erişilen_db_sayısı: ok.length,
    toplam_takip_tablosu: totalTables,
    distinct_tablo_adedi: distinctNames.size,
    by_db: ok.map((o) => ({ db: o.db, tablo_sayısı: o.tables.length, örnek_tablolar: o.tables.slice(0, 5) })),
  };
}

// Tool: takip_table_sizes — TAKIP tablolarının boyutlarını bul
const TAKIP_SIZES_TOOL = {
  name: 'takip_table_sizes',
  description: 'TAKIP tablolarının boyutlarını sp_spaceused ile toplar. Sonuç CSV formatında döner.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

async function takipTableSizes() {
  const mgr = getSybaseManager();
  const dbs = (await mgr.query('RAPOR', "SELECT name FROM master..sysdatabases WHERE name LIKE 'EVDO_%' ORDER BY name")).rows.map((r) => r.name);

  const ok = [];
  for (const db of dbs) {
    try {
      const r = await mgr.query('RAPOR', `SELECT name FROM ${db}.dbo.sysobjects WHERE type='U' AND name LIKE '%TAKIP%' ORDER BY name`);
      if (r.rows.length > 0) {
        ok.push({ db, tables: r.rows.map((x) => x.name) });
      }
    } catch (e) {}
  }

  const results = [];
  for (const o of ok) {
    for (const tbl of o.tables) {
      try {
        const r = await mgr.execRaw('RAPOR', `USE ${o.db}\nEXEC sp_spaceused ${tbl}`);
        const row = Array.isArray(r) && r.length ? r[0] : null;
        if (row) {
          results.push({
            db: o.db,
            table: tbl,
            rows: row.rowtotal ? parseInt(row.rowtotal, 10) : null,
            reserved_kb: row.reserved ? parseInt(row.reserved, 10) : null,
            data_kb: row.data ? parseInt(row.data, 10) : null,
            index_size_kb: row.index_size ? parseInt(row.index_size, 10) : null,
            unused_kb: row.unused ? parseInt(row.unused, 10) : null,
          });
        }
      } catch (e) {
        // Hataları atla
      }
    }
  }

  // Özet
  let totalReserved = 0, totalData = 0, totalIndex = 0, totalUnused = 0, totalRows = 0;
  for (const r of results) {
    if (r.reserved_kb) totalReserved += r.reserved_kb;
    if (r.data_kb) totalData += r.data_kb;
    if (r.index_size_kb) totalIndex += r.index_size_kb;
    if (r.unused_kb) totalUnused += r.unused_kb;
    if (r.rows) totalRows += r.rows;
  }

  // DB bazlı özet
  const byDb = {};
  for (const r of results) {
    if (!byDb[r.db]) byDb[r.db] = { tables: 0, reserved_kb: 0, data_kb: 0, rows: 0 };
    byDb[r.db].tables++;
    if (r.reserved_kb) byDb[r.db].reserved_kb += r.reserved_kb;
    if (r.data_kb) byDb[r.db].data_kb += r.data_kb;
    if (r.rows) byDb[r.db].rows += r.rows;
  }

  return {
    özet: {
      toplam_tablo: results.length,
      reserved_mb: (totalReserved / 1024).toFixed(2),
      data_mb: (totalData / 1024).toFixed(2),
      index_mb: (totalIndex / 1024).toFixed(2),
      unused_mb: (totalUnused / 1024).toFixed(2),
      toplam_satır: totalRows.toLocaleString(),
    },
    by_db: byDb,
    results: results.slice(0, 100), // İlk 100 satır (çok büyükse)
  };
}

// Tool listesi
server.setRequestHandler(ListToolsRequest.method, async () => {
  return {
    tools: [
      LIST_CONNECTIONS_TOOL,
      QUERY_TOOL,
      EXECUTE_TOOL,
      LIST_TABLES_TOOL,
      DESCRIBE_TABLE_TOOL,
      FIND_TAKIP_TOOL,
      TAKIP_SIZES_TOOL,
    ],
  };
});

// Tool çağrısı
server.setRequestHandler(CallToolRequest.method, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'list_connections':
        result = await listConnections();
        break;
      case 'query':
        result = await runQuery(args);
        break;
      case 'execute':
        result = await runExecute(args);
        break;
      case 'list_tables':
        result = await listTables(args);
        break;
      case 'describe_table':
        result = await describeTable(args);
        break;
      case 'find_takip_tables':
        result = await findTakipTables();
        break;
      case 'takip_table_sizes':
        result = await takipTableSizes();
        break;
      default:
        throw new Error(`Bilinmeyen tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `HATA: ${e.message}` }],
      isError: true,
    };
  }
});

// Sunucuyu başlat
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('databaseMCP MCP sunucusu çalışıyor...');
}

main().catch((err) => {
  console.error('Sunucu hatası:', err);
  process.exit(1);
});
