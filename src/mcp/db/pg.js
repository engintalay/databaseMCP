/**
 * PostgreSQL sarmalısı (pg driver). Proxy-dışı bağlantı.
 */

import pg from 'pg';
import { withNoProxy } from '../proxy.js';

/**
 * Tek istemci aç, bağlan, çalıştır, kapat. Pool kullanmaz (MCP statelessness).
 * @param {object} conn - {host, port, database, user, password, ssl, poolMax}
 * @param {Function} fn - (client) => Promise
 */
async function withClient(conn, fn) {
  const client = new pg.Client({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database ?? conn.dbname,
    user: conn.username ?? conn.user,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Tablo listesi. Opsiyonel şema filtresi. */
async function listTables(conn, schema) {
  return withNoProxy(async () => {
    return withClient(conn, async (client) => {
      let q = `
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'`;
      const params = [];
      if (schema) {
        q += ` AND table_schema = $${params.length + 1}`;
        params.push(schema);
      }
      q += ` AND table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name`;
      const { rows } = await client.query(q, params);
      return rows;
    });
  });
}

/** Tablo tanımı (sütunlar) */
async function describeTable(conn, tableName) {
  return withNoProxy(async () => {
    return withClient(conn, async (client) => {
      const q = `
        SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position`;
      const { rows } = await client.query(q, [tableName]);
      return rows;
    });
  });
}

/** Okuma sorgusu. Satır limiti isteğe bağlı. */
async function runQuery(conn, sql, limit) {
  return withNoProxy(async () => {
    return withClient(conn, async (client) => {
      let query = sql.trim();
      if (!query.endsWith(';')) query += ';';
      if (limit && limit > 0 && !/\blimit\b/i.test(query)) {
        query += ` LIMIT ${Number(limit)}`;
      }
      const { rows, rowCount } = await client.query(query);
      return { rows, rowCount: rowCount || 0 };
    });
  });
}

/** Yazma / DDL. rowCount etkilenen satır sayısıdır. */
async function execute(conn, sql) {
  return withNoProxy(async () => {
    return withClient(conn, async (client) => {
      const { rowCount } = await client.query(sql);
      return { success: true, rowCount: rowCount || 0 };
    });
  });
}

/**
 * Toplu ekleme (tek transaction içinde). Parametreli sorgu kullanır.
 * @param {object} conn
 * @param {string} table
 * @param {Array<string>} headers
 * @param {Array<object>} rows
 */
async function bulkInsert(conn, table, headers, rows) {
  return withNoProxy(async () => {
    return withClient(conn, async (client) => {
      const cols = headers.map((c) => client.escapeIdentifier(c)).join(', ');
      const placeholders = [];
      const values = [];
      let idx = 1;
      for (const row of rows) {
        const ph = headers.map(() => `$${idx++}`).join(', ');
        placeholders.push(`(${ph})`);
        for (const h of headers) {
          const v = row[h];
          values.push(v === null || v === undefined ? null : v);
        }
      }
      const sql = `INSERT INTO ${client.escapeIdentifier(table)} (${cols}) VALUES ${placeholders.join(', ')}`;
      const { rowCount } = await client.query(sql, values);
      return { success: true, rowCount: rowCount || 0 };
    });
  });
}

export { withClient, listTables, describeTable, runQuery, execute, bulkInsert };
