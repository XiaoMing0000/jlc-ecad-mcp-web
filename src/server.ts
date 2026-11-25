import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_TITLE } from './config.js';
import { registerAuthTools } from './tools/auth.js';
import { registerUserTools } from './tools/user.js';

export function createServer(version: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    title: SERVER_TITLE,
    version,
  });

  registerUserTools(server);
  registerAuthTools(server);

  return server;
}
