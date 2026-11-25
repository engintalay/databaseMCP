#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, resolveConnection } from '../config.mjs';

const server = new Server(
  {
    name: 'databaseMCP',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      'databaseMCP: yapılandırılmış veritabanlarında SQL çalıştırır. ' +
      'Kullanıcı "databaseMCP help" yazar veya yardım isterse `help` tool\'unu çağır. ' +
      'ÖNEMLİ: tool çıktısı kullanıcıya görünmez; bu yüzden dönen dokümanı ÖZETLEMEDEN, ' +
      'eksiksiz ve kelimesi kelimesine markdown olarak yanıtına yaz. ' +
      'Akış: list_connections -> select_connection -> execute_query. ' +
      'execute_query connection verilmezse aktif VT üzerinde çalışır.',
  }
);

// Aktif VT durumu (oturum bazında)
let activeConnectionId = null;

const tools = [
  {
    name: 'list_connections',
    description: 'Yapılandırılmış veritabanı bağlantılarını listeler.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'select_connection',
    description: 'Aktif veritabanı bağlantısını seçer. execute_query için varsayılan VT olur.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { 
          type: 'string', 
          description: 'Connection ID (list_connections ile görülebilir)' 
        },
      },
      required: ['connection'],
    },
  },
  {
    name: 'execute_query',
    description: 'Veritabanında SQL sorgusu çalıştırır. Sadece SELECT sorguları için önerilir. connection parametresi verilmezse aktif VT kullanılır.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { 
          type: 'string', 
          description: 'Connection ID (opsiyonel, verilmezse aktif VT kullanılır)' 
        },
        query: { type: 'string', description: 'SQL query to execute' },
      },
      required: ['query'],
    },
  },
  {
    name: 'help',
    description: 'databaseMCP kullanım dokümanını döndürür: tool listesi, kullanım akışı, örnekler ve mevcut bağlantılar.',
    inputSchema: { type: 'object', properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// MCP tool sonucu: düz nesneyi content formatına çevirir
function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

// Kullanım dokümanı (canlı bağlantı bilgileriyle)
function buildHelp() {
  const { connections } = loadConfig();
  const entries = Object.entries(connections);
  const activeEntry = entries.find(([, c]) => c.id === activeConnectionId);

  const connLines = entries.length
    ? entries
        .map(([name, c]) => {
          const mark = c.id === activeConnectionId ? '  <-- AKTİF' : '';
          const db = c.database || c.dbname || '-';
          return `  - ${name}  [${c.type}]  ${c.host}:${c.port}/${db}  (env: ${c.environment || '-'})${mark}`;
        })
        .join('\n')
    : '  (tanımlı bağlantı yok)';

  return `# databaseMCP — Kullanım Dokümanı

databaseMCP, yapılandırılmış veritabanlarına (Sybase, PostgreSQL) SQL sorgusu
çalıştırmak için bir MCP sunucusudur. Oturum bazında "aktif VT" (veritabanı)
kavramı vardır: bir kez seçersiniz, sonraki sorgular o VT üzerinde çalışır.

## Tool'lar

1. list_connections
   Yapılandırılmış tüm bağlantıları listeler. Aktif olan "isActive: true" ile
   işaretlenir. Parametre almaz.

2. select_connection
   Aktif VT'yi seçer. Bundan sonra connection parametresi verilmeyen
   execute_query çağrıları bu VT üzerinde çalışır.
   Parametre: { "connection": "<bağlantı adı>" }

3. execute_query
   SQL sorgusu çalıştırır. Sadece SELECT önerilir (yazma/DDL risklidir).
   Parametre: { "query": "<SQL>", "connection": "<opsiyonel>" }
   - connection verilmezse aktif VT kullanılır.
   - Aktif VT yoksa ve connection verilmezse hata döner.

4. help
   Bu dokümanı döndürür.

## Önerilen akış

  1) list_connections            -> mevcut bağlantıları gör
  2) select_connection           -> birini aktif yap
  3) execute_query               -> sorguyu çalıştır (connection gerekmez)

## Örnekler

  # Bağlantıları listele
  list_connections

  # evdb_test'i aktif yap
  select_connection { "connection": "evdb_test" }

  # Aktif VT üzerinde sorgu
  execute_query { "query": "SELECT TOP 10 * FROM dbo.SOME_TABLE" }

  # Belirli bir bağlantı üzerinde (aktif VT'yi değiştirmeden)
  execute_query { "connection": "RAPOR", "query": "SELECT 1 AS test" }

## Mevcut bağlantılar
${connLines}

## Aktif VT
  ${activeEntry ? `${activeEntry[0]} (${activeConnectionId})` : 'seçilmedi — önce select_connection kullanın'}

## Notlar
- Aktif VT seçimi oturum (sunucu süreci) bazındadır; sunucu yeniden
  başlarsa sıfırlanır.
- Sorgu sonuçları JSON olarak döner.
- Yazma/DDL sorguları çalıştırmadan önce etkiyi (WHERE, satır sayısı)
  doğrulayın.
- Bağlantı tanımları config.json içinde, şifreler dbpassword.json içinde
  (şifreli) tutulur.
`;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'help') {
    return { content: [{ type: 'text', text: buildHelp() }] };
  }

  if (name === 'list_connections') {
    const { connections } = loadConfig();
    const list = Object.entries(connections).map(([connName, conn]) => ({
      name: connName,
      id: conn.id,
      type: conn.type,
      environment: conn.environment,
      host: conn.host,
      port: conn.port,
      database: conn.database || conn.dbname,
      isActive: conn.id === activeConnectionId,
    }));
    return ok({ connections: list });
  }

  if (name === 'select_connection') {
    const { connection: connName } = request.params.arguments;
    const { connections } = loadConfig();

    if (!connections[connName]) {
      throw new Error(`Connection not found: ${connName}`);
    }

    activeConnectionId = connections[connName].id;
    return ok({
      success: true,
      message: `Aktif VT seçildi: ${connName} (${activeConnectionId})`,
      activeConnectionId,
    });
  }

  if (name === 'execute_query') {
    const { connection: connName, query } = request.params.arguments;
    const { connections } = loadConfig();

    // VT belirtilmediyse aktif VT kullan
    let selectedConnName = connName;
    if (!selectedConnName) {
      if (!activeConnectionId) {
        throw new Error('VT seçilmedi. Önce select_connection ile VT seçin veya execute_query\'e connection parametresi verin.');
      }
      // Aktif VT'nin ismini bul
      const entry = Object.entries(connections).find(([_, conn]) => conn.id === activeConnectionId);
      if (!entry) {
        throw new Error(`Aktif VT bulunamadı: ${activeConnectionId}`);
      }
      selectedConnName = entry[0];
    }

    if (!connections[selectedConnName]) {
      throw new Error(`Connection not found: ${selectedConnName}`);
    }

    const conn = resolveConnection(connections[selectedConnName]);

    if (conn.type === 'sybase') {
      const { SybaseManager } = await import('./db/sybase.mjs');
      const db = new SybaseManager([conn]);
      const result = await db.execute(conn.id, query);
      return ok({ result });
    }

    if (conn.type === 'pg') {
      const { PgManager } = await import('./db/pg.mjs');
      const db = new PgManager(conn);
      await db.connect();
      const result = await db.execute(query);
      await db.disconnect();
      return ok({ result });
    }

    throw new Error(`Unsupported database type: ${conn.type}`);
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
