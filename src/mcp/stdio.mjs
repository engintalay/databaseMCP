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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

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
