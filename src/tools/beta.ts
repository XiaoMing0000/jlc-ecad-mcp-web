import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isRecord } from '../utils.js';
import { requestTool } from './api-tool.js';

// Beta program endpoints from the web API; not part of the desktop-app catalog.
const BETA_VERSION_PATH = '/api/editor/beta/version';
const BETA_WHITELIST_PATH = '/api/editor/beta/whitelist';

const emptySchema = z.looseObject({});

export const GET_BETA_STATUS_TOOL = {
  name: 'jlc_ecad_get_beta_status',
  title: 'Get beta program status',
  description:
    'Read the beta program information and whether the signed-in user is on the beta whitelist with GET /api/editor/beta/version. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: emptySchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const JOIN_BETA_WHITELIST_TOOL = {
  name: 'jlc_ecad_join_beta_whitelist',
  title: 'Join the beta whitelist',
  description:
    'Add the signed-in user to the beta whitelist with POST /api/editor/beta/whitelist. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: emptySchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleGetBetaStatus(): Promise<CallToolResult> {
  return requestTool(GET_BETA_STATUS_TOOL.name, { method: 'GET', path: BETA_VERSION_PATH });
}

export async function handleJoinBetaWhitelist(args: unknown): Promise<CallToolResult> {
  return requestTool(JOIN_BETA_WHITELIST_TOOL.name, {
    method: 'POST',
    path: BETA_WHITELIST_PATH,
    // The endpoint takes no documented fields; forward any extra ones the caller supplied.
    body: isRecord(args) ? args : {},
  });
}
