#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, resolveConnection } from '../config.js';

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

const tools = [
  {
    name: 'list_connections',
    description: 'Yapılandırılmış veritabanı bağlantılarını listeler.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'execute_query',
    description: 'Veritabanında SQL sorgusu çalıştırır. Sadece SELECT sorguları için önerilir.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection ID' },
        query: { type: 'string', description: 'SQL query to execute' },
      },
      required: ['connection', 'query'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'list_connections') {
    const { connections } = loadConfig();
    const list = Object.entries(connections).map(([name, conn]) => ({
      name,
      id: conn.id,
      type: conn.type,
      environment: conn.environment,
      host: conn.host,
      port: conn.port,
      database: conn.database,
    }));
    return { connections: list };
  }

  if (name === 'execute_query') {
    const { connection: connName, query } = request.params.arguments;
    const { connections } = loadConfig();

    if (!connections[connName]) {
      throw new Error(`Connection not found: ${connName}`);
    }

    const conn = resolveConnection(connections[connName]);

    if (conn.type === 'sybase') {
      const { SybaseManager } = await import('./db/sybase.js');
      const db = new SybaseManager(conn);
      await db.connect();
      const result = await db.execute(query);
      await db.disconnect();
      return { result };
    }

    if (conn.type === 'pg') {
      const { PgManager } = await import('./db/pg.js');
      const db = new PgManager(conn);
      await db.connect();
      const result = await db.execute(query);
      await db.disconnect();
      return { result };
    }

    throw new Error(`Unsupported database type: ${conn.type}`);
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
