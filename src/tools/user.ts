import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JlcEcadApiError } from '../api/errors.js';
import { getEditorUser } from '../api/user.js';
import { getSessionFilePath } from '../config.js';
import { logDebug } from '../logger.js';

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    'jlc_ecad_get_user',
    {
      title: 'Get JLC EDA user profile',
      description:
        'Get the profile of the currently logged-in JLC EDA (jlc-ecad.com) user by calling GET /api/editor/user. ' +
        'Returns the raw JSON response from the JLC EDA editor backend. ' +
        `Authentication uses cookies stored locally via JLC_ECAD_COOKIE or ${getSessionFilePath()}. ` +
        'If no valid session is available, ask the user whether they want to sign in. Preferred: run ' +
        '`npx -y jlc-ecad-mcp login` (or `node dist/index.js login` from the repository) in a terminal, then call this tool again. ' +
        'If the client cannot run shell commands, call jlc_ecad_login with {"confirm": true}.',
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await getEditorUser();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDebug(`jlc_ecad_get_user failed: ${message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: formatToolError(error, message) }],
        };
      }
    },
  );
}

/**
 * Keep the guidance readable while still exposing the raw backend response body
 * (for example {"success":false,"code":401}); callers often need the exact body.
 */
function formatToolError(error: unknown, message: string): string {
  if (!(error instanceof JlcEcadApiError) || error.body === undefined) {
    return message;
  }

  const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body, null, 2);
  return `${message}\n\nResponse body:\n${body}`;
}
