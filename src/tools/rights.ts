import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest, type ApiRawResponse } from '../api/client.js';
import { logDebug } from '../logger.js';
import { formatRawResponse, formatToolError } from './format.js';

// ERP/member endpoints from the web API; not part of the desktop-app catalog.
const QRCODE_PATH = '/api/editor/erp/ecad/qrcode';
const DESIGNER_RIGHTS_PATH = '/api/editor/erp/ecad/member/rights/designer';
const MEMBER_RIGHTS_PATH = '/api/editor/erp/ecad/member/rights';

const emptySchema = z.looseObject({});

export const GET_OFFICIAL_ACCOUNT_QRCODE_TOOL = {
  name: 'jlc_ecad_get_official_account_qrcode',
  title: 'Get official account QR code',
  description:
    'Read the JLC EDA official-account follow QR code with GET /api/editor/erp/ecad/qrcode. ' +
    'Returns an image when the backend serves one, otherwise the raw JSON response.',
  inputSchema: emptySchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const GET_DESIGNER_RIGHTS_TOOL = {
  name: 'jlc_ecad_get_designer_rights',
  title: 'Get designer rights',
  description:
    'Read the customer designer rights with GET /api/editor/erp/ecad/member/rights/designer. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: emptySchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const GET_MEMBER_RIGHTS_TOOL = {
  name: 'jlc_ecad_get_member_rights',
  title: 'Get current member rights',
  description:
    'Read the rights the customer currently claimed with GET /api/editor/erp/ecad/member/rights. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: emptySchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleGetOfficialAccountQrcode(): Promise<CallToolResult> {
  return requestTool(GET_OFFICIAL_ACCOUNT_QRCODE_TOOL.name, QRCODE_PATH);
}

export async function handleGetDesignerRights(): Promise<CallToolResult> {
  return requestTool(GET_DESIGNER_RIGHTS_TOOL.name, DESIGNER_RIGHTS_PATH);
}

export async function handleGetMemberRights(): Promise<CallToolResult> {
  return requestTool(GET_MEMBER_RIGHTS_TOOL.name, MEMBER_RIGHTS_PATH);
}

async function requestTool(toolName: string, path: string): Promise<CallToolResult> {
  try {
    const response = await apiRequest({ method: 'GET', path, retryTool: toolName });
    return { content: [toContentBlock(response)] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`${toolName} failed: ${message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: formatToolError(error, message) }],
    };
  }
}

/** The QR code endpoint may answer with an image instead of JSON. */
function toContentBlock(response: ApiRawResponse) {
  const mimeType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) {
    return { type: 'image' as const, data: response.buffer.toString('base64'), mimeType };
  }
  return { type: 'text' as const, text: formatRawResponse(response) };
}
