import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ApiRawResponse } from '../api/client.js';
import { JlcEcadApiError } from '../api/errors.js';

/**
 * Keep the guidance readable while still exposing the raw backend response body
 * (for example {"success":false,"code":401}); callers often need the exact body.
 */
export function formatToolError(error: unknown, message: string): string {
  if (!(error instanceof JlcEcadApiError) || error.body === undefined) {
    return message;
  }

  const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body, null, 2);
  return `${message}\n\nResponse body:\n${body}`;
}

/** Return the raw backend response: pretty-printed JSON, or the text body as-is. */
export function formatRawResponse(response: ApiRawResponse): string {
  return response.isJson ? (JSON.stringify(response.data, null, 2) ?? '') : response.text;
}

/** Shared response for destructive tools called without `{"__confirm": true}`. */
export function destructiveConfirmation(toolName: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Tool "${toolName}" is destructive. Ask the user for confirmation, then retry with {"__confirm": true}.`,
      },
    ],
  };
}
