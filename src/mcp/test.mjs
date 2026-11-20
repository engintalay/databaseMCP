#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'test-mcp',
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
    name: 'hello',
    description: 'Merhaba dunya',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'hello') {
    return {
      content: [{ type: 'text', text: `Merhaba, ${args.name || 'Dünya'}!` }],
    };
  }
  throw new Error(`Bilinmeyen tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Test MCP sunucusu hazır');
