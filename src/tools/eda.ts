import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../api/client.js';
import { logDebug } from '../logger.js';
import { formatRawResponse, formatToolError } from './format.js';

const COMPONENTS_SEARCH_PATH = '/api/editor/eda/components/searchByIds';
const DEVICES_SEARCH_PATH = '/api/editor/eda/devices/searchByIds';

export const SEARCH_COMPONENTS_TOOL = {
  name: 'jlc_ecad_search_components',
  title: 'Search JLC EDA components by ID',
  description:
    'Look up JLC EDA (jlc-ecad.com) components by UUID with POST /api/editor/eda/components/searchByIds. ' +
    'Returns the raw JSON response from the editor backend. ' +
    'Authentication uses the locally saved JLC EDA session; on a 401 ask the user whether they want to sign in ' +
    'and prefer `npx -y jlc-ecad-mcp login` (or jlc_ecad_login with {"confirm": true}).',
  inputSchema: z.looseObject({
    path: z.string().describe('Path parameter expected by the editor API; passed through unchanged.'),
    uuids: z.array(z.string()).describe('Component UUIDs to look up.'),
  }),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const SEARCH_DEVICES_TOOL = {
  name: 'jlc_ecad_search_devices',
  title: 'Search JLC EDA devices by ID',
  description:
    'Look up JLC EDA (jlc-ecad.com) devices by UUID with POST /api/editor/eda/devices/searchByIds. ' +
    'Returns the raw JSON response from the editor backend. ' +
    'Authentication uses the locally saved JLC EDA session; on a 401 ask the user whether they want to sign in ' +
    'and prefer `npx -y jlc-ecad-mcp login` (or jlc_ecad_login with {"confirm": true}).',
  inputSchema: z.looseObject({
    uuids: z.array(z.string()).describe('Device UUIDs to look up.'),
  }),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleSearchComponents(args: z.infer<typeof SEARCH_COMPONENTS_TOOL.inputSchema>): Promise<CallToolResult> {
  return searchByIds(SEARCH_COMPONENTS_TOOL.name, COMPONENTS_SEARCH_PATH, {
    path: args.path,
    uuids: args.uuids,
  });
}

export async function handleSearchDevices(args: z.infer<typeof SEARCH_DEVICES_TOOL.inputSchema>): Promise<CallToolResult> {
  return searchByIds(SEARCH_DEVICES_TOOL.name, DEVICES_SEARCH_PATH, { uuids: args.uuids });
}

async function searchByIds(toolName: string, path: string, body: unknown): Promise<CallToolResult> {
  try {
    const response = await apiRequest({ method: 'POST', path, body, retryTool: toolName });
    return { content: [{ type: 'text', text: formatRawResponse(response) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`${toolName} failed: ${message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: formatToolError(error, message) }],
    };
  }
}
