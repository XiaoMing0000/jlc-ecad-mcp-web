import { getEditorUser } from '../api/user.js';
import { getSessionFilePath } from '../config.js';
import { DEFAULT_EDITOR_URL, watchEditorLogin } from '../cdp/login-watch.js';
import { logDebug } from '../logger.js';
import { SessionLoadError } from '../session.js';
import { isRecord } from '../utils.js';
import { loginWithEditorCookies, loginWithPassportCookies, type LoginResult } from './login.js';

export interface CdpLoginOptions {
  timeoutMs?: number;
  profileDir?: string;
  chromePort?: number;
  chromeBinary?: string;
  /** Editor page URL (defaults to https://www.jlc-ecad.com/editor). */
  editorUrl?: string;
  /** Skip checking the current session (caller already checked). */
  skipFastPath?: boolean;
}

/** Return the current editor login if the saved session is valid. */
export async function getCurrentEditorLogin(): Promise<LoginResult | null> {
  try {
    const result = await getEditorUser();
    const user = isRecord(result.data) ? (result.data.result ?? result.data.data ?? result.data) : result.data;
    return { ok: true, user, sessionPath: getSessionFilePath() };
  } catch (error) {
    if (error instanceof SessionLoadError) {
      throw error;
    }
    return null;
  }
}

/**
 * Try every locally saved login before opening Chrome:
 *
 *   1. current session (env / <config-dir>/session.json)
 *   2. editor cookie snapshot (.jlc-ecad-mcp/editor-cookies.json)
 *   3. passport cookie snapshot (.jlc-ecad-mcp/passport-cookies.json)
 *      → check-login → code → /api/editor/login
 */
export async function trySavedLogin(): Promise<LoginResult | null> {
  const current = await getCurrentEditorLogin();
  if (current) {
    return current;
  }

  try {
    const editor = await loginWithEditorCookies();
    if (editor) {
      return editor;
    }
  } catch (error) {
    logDebug(`Saved editor cookies failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const passport = await loginWithPassportCookies();
    if (passport) {
      return passport;
    }
  } catch (error) {
    logDebug(`Saved passport cookies failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return null;
}

/**
 * Sign in using saved credentials first, then Chrome via CDP.
 */
export async function loginViaCdp(options: CdpLoginOptions = {}): Promise<LoginResult> {
  if (!options.skipFastPath) {
    const saved = await trySavedLogin();
    if (saved) {
      return saved;
    }
  }

  const watched = await watchEditorLogin({
    editorUrl: options.editorUrl ?? DEFAULT_EDITOR_URL,
    timeoutMs: options.timeoutMs,
    profileDir: options.profileDir,
    chromePort: options.chromePort,
    chromeBinary: options.chromeBinary,
  });

  return { ok: true, user: watched.user, sessionPath: watched.sessionPath };
}
