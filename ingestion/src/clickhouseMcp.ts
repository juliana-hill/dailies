import { createClient } from '@clickhouse/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';

export async function handleMcpRequest(req: Request, res: Response) {
  const server = new McpServer({ name: 'dailies-clickhouse-readonly', version: '0.1.0' });
  server.registerTool('run_query', { description: 'Run one read-only ClickHouse SELECT/WITH query for creator-retention evidence.', inputSchema: { query: z.string().min(1).max(20_000) } }, async ({ query }) => {
    assertReadOnly(query);
    const client = createClient(clickHouseConfig());
    try {
      const result = await client.query({ query, format: 'JSONEachRow' });
      const rows = await result.json();
      return { content: [{ type: 'text', text: JSON.stringify({ rows }) }] };
    } finally { await client.close(); }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('ClickHouse MCP request failed', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export function assertReadOnly(query: string) {
  const normalized = query.trim();
  if (!/^(SELECT|WITH)\b/i.test(normalized) || /\b(INSERT|ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|OPTIMIZE|GRANT|REVOKE|ATTACH|DETACH|RENAME|SYSTEM|KILL)\b/i.test(normalized) || /;\s*\S/.test(normalized)) throw new Error('Only one read-only SELECT/WITH query is allowed');
}

const clickHouseConfig = () => ({
  url: `${process.env.CLICKHOUSE_SECURE === 'false' ? 'http' : 'https'}://${required('CLICKHOUSE_HOST')}:${process.env.CLICKHOUSE_PORT || (process.env.CLICKHOUSE_SECURE === 'false' ? '8123' : '8443')}`,
  username: required('CLICKHOUSE_MCP_USER'),
  password: required('CLICKHOUSE_MCP_PASSWORD'),
  database: process.env.CLICKHOUSE_DATABASE || 'default',
  request_timeout: 120_000,
});
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
