#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Basit MCP sunucusu
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

// Basit bir tool
const TEST_TOOL = {
  name: 'test',
  description: 'Test tool',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
  },
};

server.setRequestHandler('tools/list', async () => {
  return {
    tools: [TEST_TOOL],
  };
});

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'test') {
    return {
      content: [{ type: 'text', text: `Merhaba, ${args.name || 'Dünya'}!` }],
    };
  }
  throw new Error(`Bilinmeyen tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP sunucusu hazır');
}

main().catch((err) => {
  console.error('Hata:', err);
  process.exit(1);
});
