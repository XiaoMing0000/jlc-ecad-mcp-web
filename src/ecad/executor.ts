import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiRequest, type ApiRawResponse, type ApiRequestOptions, type QueryParams } from '../api/client.js';
import { logDebug } from '../logger.js';
import { destructiveConfirmation, formatToolError } from '../tools/format.js';
import { isRecord } from '../utils.js';
import { getCurrentUserUuid } from './owner.js';
import type { EcadToolDefinition } from './types.js';

const PATH_PARAMETER = /:([A-Za-z_][\w-]*)/g;

type PreparedCall = { request: ApiRequestOptions } | { result: CallToolResult };

/**
 * Execute one imported desktop-app tool against JLC_ECAD_BASE_URL.
 *
 * Request mapping follows the local API's conventions:
 *   - path parameters are substituted from arguments and removed from the body;
 *   - GET sends the remaining arguments as query parameters;
 *   - POST/PUT/PATCH/DELETE send them as a JSON body;
 *   - destructive tools require "__confirm": true (never forwarded upstream);
 *   - "__query" adds query parameters for any method;
 *   - "__rawBodyBase64" + "__contentType" send a raw binary body.
 */
export async function executeEcadTool(tool: EcadToolDefinition, args: unknown): Promise<CallToolResult> {
  try {
    const prepared = await prepareCall(tool, args);
    if ('result' in prepared) {
      return prepared.result;
    }

    const response = await apiRequest({ ...prepared.request, retryTool: tool.name });
    return formatResponse(tool, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`ECAD tool ${tool.name} failed: ${message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: formatToolError(error, message) }],
    };
  }
}

async function prepareCall(tool: EcadToolDefinition, rawArgs: unknown): Promise<PreparedCall> {
  const args: Record<string, unknown> = isRecord(rawArgs) ? { ...rawArgs } : {};

  const confirmed = args.__confirm === true;
  delete args.__confirm;
  if (tool.danger && !confirmed) {
    return { result: destructiveConfirmation(tool.name) };
  }

  const queryOverride = isRecord(args.__query) ? (args.__query as QueryParams) : undefined;
  delete args.__query;

  const rawBodyBase64 = typeof args.__rawBodyBase64 === 'string' ? args.__rawBodyBase64 : undefined;
  delete args.__rawBodyBase64;
  const rawContentType = typeof args.__contentType === 'string' ? args.__contentType : undefined;
  delete args.__contentType;

  const ownerKey = optionalOwnerKey(tool, args);
  if (ownerKey !== undefined && args[ownerKey] === undefined) {
    const ownerUuid = await getCurrentUserUuid(tool.name);
    if (ownerUuid !== undefined) {
      args[ownerKey] = ownerUuid;
    }
  }

  let path = tool.path;
  for (const match of tool.path.matchAll(PATH_PARAMETER)) {
    const name = match[1];
    const value = args[name];
    if (value === undefined || value === null) {
      return {
        result: {
          isError: true,
          content: [{ type: 'text', text: `Missing required path parameter "${name}" for ${tool.name}.` }],
        },
      };
    }
    path = path.replace(new RegExp(`:${escapeRegExp(name)}(?=/|$)`, 'g'), encodeURIComponent(String(value)));
    delete args[name];
  }

  const query: QueryParams = queryOverride ? { ...queryOverride } : {};
  const method = tool.method;

  if (rawBodyBase64 !== undefined) {
    Object.assign(query, args);
    return {
      request: {
        method,
        path,
        query,
        rawBody: Buffer.from(rawBodyBase64, 'base64'),
        contentType: rawContentType ?? 'application/octet-stream',
      },
    };
  }

  if (method === 'GET') {
    Object.assign(query, args);
    return { request: { method, path, query } };
  }

  return {
    request: {
      method,
      path,
      query,
      body: args,
    },
  };
}

function optionalOwnerKey(tool: EcadToolDefinition, args: Record<string, unknown>): string | undefined {
  const params = tool.ownerParams;
  if (params === undefined) {
    return undefined;
  }

  const ownerKeys = [...params.required, ...params.optional];
  if (ownerKeys.some((key) => args[key] !== undefined)) {
    return undefined;
  }
  // Do not satisfy a required owner parameter implicitly; the caller has to
  // choose the correct owner explicitly.
  if (params.required.length > 0) {
    return undefined;
  }
  return params.optional[0];
}

function formatResponse(tool: EcadToolDefinition, response: ApiRawResponse): CallToolResult {
  const mimeType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (mimeType.startsWith('image/')) {
    return {
      content: [
        {
          type: 'image',
          data: response.buffer.toString('base64'),
          mimeType,
        },
      ],
    };
  }

  if (response.isJson) {
    let value = response.data;
    if (isRecord(value) && 'result' in value) {
      value = value.result;
    }
    const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
    return { content: [{ type: 'text', text }] };
  }

  if (mimeType.includes('application/octet-stream')) {
    return {
      content: [
        {
          type: 'resource',
          resource: {
            uri: `jlc-ecad://tools/${tool.name}/output`,
            mimeType: mimeType === '' ? 'application/octet-stream' : mimeType,
            blob: response.buffer.toString('base64'),
          },
        },
      ],
    };
  }

  return { content: [{ type: 'text', text: response.text }] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
