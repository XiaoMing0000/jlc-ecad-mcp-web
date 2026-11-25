import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loginViaCdp, trySavedLogin } from '../auth/cdp-login.js';
import type { LoginResult } from '../auth/login.js';
import { findChromeBinary } from '../cdp/chrome.js';
import { DEFAULT_EDITOR_URL } from '../cdp/login-watch.js';
import { getLoginTimeoutMs } from '../config.js';
import { logDebug, logError, logInfo } from '../logger.js';
import { SessionLoadError } from '../session.js';

let activeLogin: Promise<unknown> | null = null;

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    'jlc_ecad_login',
    {
      title: 'Sign in to JLC EDA',
      description:
        'In-client fallback for signing in to JLC EDA (jlc-ecad.com). Prefer the CLI when the client can run shell commands: ' +
        '`npx -y jlc-ecad-mcp login` (or `node dist/index.js login` from the repository). ' +
        'This tool requires explicit user confirmation: call without confirm first to get a confirmation prompt, ' +
        'ask the user whether they want to sign in, then call again with {"confirm": true} only after the user agrees. ' +
        'It tries the current session, saved editor cookies, and saved passport cookies first; if none work, it opens ' +
        'https://www.jlc-ecad.com/editor in Chrome via CDP and waits for a successful /api/editor/user response. ' +
        'Call jlc_ecad_get_user again after signing in.',
      inputSchema: {
        confirm: z.boolean().optional().describe('Set to true only after the user explicitly confirms they want to sign in.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ confirm }) => {
      if (confirm !== true) {
        return { content: [{ type: 'text', text: confirmationText() }] };
      }

      try {
        const saved = await trySavedLogin();
        if (saved) {
          return successResponse(saved);
        }
      } catch (error) {
        if (error instanceof SessionLoadError) {
          logError(`Invalid session file: ${error.message}`);
        } else {
          logDebug(`Saved credential check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (activeLogin) {
        return { content: [{ type: 'text', text: inProgressText() }] };
      }

      // Fail fast with a real error instead of claiming a window will open.
      try {
        await findChromeBinary();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`Cannot start JLC EDA login: ${message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: `Cannot start JLC EDA login: ${message}` }],
        };
      }

      activeLogin = loginViaCdp({ timeoutMs: getLoginTimeoutMs(), skipFastPath: true })
        .then((result) => {
          logInfo(`JLC EDA login successful; session saved to ${result.sessionPath ?? 'the session file'}.`);
          return result;
        })
        .catch((error: unknown) => {
          logError(`JLC EDA login failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        })
        .finally(() => {
          activeLogin = null;
        });
      void activeLogin.catch(() => undefined);

      return { content: [{ type: 'text', text: startedText() }] };
    },
  );
}

function confirmationText(): string {
  return [
    'JLC EDA login requires explicit user confirmation.',
    '',
    'Ask the user whether they want to sign in. Do not open a browser or start any login flow before they agree.',
    '',
    'Preferred: run the CLI login in a terminal:',
    '  npx -y jlc-ecad-mcp login',
    '  (from this repository: node dist/index.js login)',
    'After it completes, call jlc_ecad_get_user again.',
    '',
    'If the client cannot run shell commands, call jlc_ecad_login again with:',
    '  {"confirm": true}',
  ].join('\n');
}

function successResponse(result: LoginResult): { content: [{ type: 'text'; text: string }] } {
  return {
    content: [
      {
        type: 'text',
        text: [
          'Already signed in to JLC EDA.',
          `Session saved to: ${result.sessionPath ?? 'the session file'}`,
          'Call jlc_ecad_get_user again to fetch the profile.',
          ...cookieEnvWarning(),
        ].join('\n'),
      },
    ],
  };
}

function startedText(): string {
  return [
    'JLC EDA login started via Chrome CDP.',
    '',
    'A Chrome window should open at:',
    DEFAULT_EDITOR_URL,
    '',
    'Sign in there. The login completes when the editor calls /api/editor/user successfully;',
    'the session is saved automatically. Then call jlc_ecad_get_user again.',
    ...cookieEnvWarning(),
  ].join('\n');
}

function inProgressText(): string {
  return [
    'A JLC EDA login is already in progress.',
    'Complete sign-in in the opened Chrome window, then call jlc_ecad_get_user again.',
    ...cookieEnvWarning(),
  ].join('\n');
}

function cookieEnvWarning(): string[] {
  return process.env.JLC_ECAD_COOKIE?.trim() ? ['', 'Note: JLC_ECAD_COOKIE is set and takes precedence over the saved session file.'] : [];
}
