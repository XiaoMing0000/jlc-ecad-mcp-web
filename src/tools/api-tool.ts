import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiRequest, type ApiRequestOptions } from '../api/client.js';
import { logDebug } from '../logger.js';
import { formatRawResponse, formatToolError } from './format.js';

/**
 * Call the editor API on behalf of a hand-written tool.
 *
 * Returns the raw response (pretty-printed JSON, or the text body as-is) and
 * converts failures into tool errors that keep the backend response body.
 */
export async function requestTool(toolName: string, options: ApiRequestOptions): Promise<CallToolResult> {
  try {
    const response = await apiRequest({ ...options, retryTool: toolName });
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
