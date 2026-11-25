import type { PageTarget } from '../cdp/chrome.js';
import type { CdpCookie, ChromeInfo } from '../cdp/cookies.js';
import { loadCookieSnapshot, saveCookieSnapshot, selectCookiesForUrl } from '../cdp/cookies.js';
import {
  EDITOR_PATH,
  getAppId,
  getBaseUrl,
  getCasUrl,
  getEditorCookiesFilePath,
  getPassportCookiesFilePath,
  getTimeoutMs,
  USER_AGENT,
} from '../config.js';
import { logDebug } from '../logger.js';
import { formatCookieHeader, parseCookieHeader, saveSession } from '../session.js';
import { isRecord } from '../utils.js';

export interface LoginResult {
  ok: boolean;
  error?: string;
  user?: unknown;
  sessionPath?: string;
}

/**
 * Validate a manually supplied Cookie header and save it as the editor session.
 */
export async function loginWithCookie(cookie: string): Promise<LoginResult> {
  const cleaned = cookie.trim().replace(/^cookie\s*:\s*/i, '');
  const cookies = parseCookieHeader(cleaned);
  if (formatCookieHeader(cookies) === '') {
    throw new Error('The provided cookie is empty or invalid.');
  }

  const user = await fetchCurrentUser(cookies);
  const sessionPath = await saveSession(cookies, { user });

  return { ok: true, user, sessionPath };
}

/**
 * Try the editor cookie snapshot (.jlc-ecad-mcp/editor-cookies.json).
 * Returns null when the snapshot is missing or the cookies are no longer valid.
 */
export async function loginWithEditorCookies(): Promise<LoginResult | null> {
  const snapshot = loadCookieSnapshot(getEditorCookiesFilePath());
  if (!snapshot) {
    return null;
  }

  const userUrl = `${getBaseUrl()}/api/editor/user`;
  const selected = selectCookiesForUrl(snapshot.cookies, userUrl);
  if (selected.length === 0) {
    return null;
  }

  const cookies = new Map(selected.map((cookie) => [cookie.name, cookie.value] as const));

  try {
    const user = await fetchCurrentUser(cookies);
    const sessionPath = await saveSession(cookies, { user });
    return { ok: true, user, sessionPath };
  } catch (error) {
    logDebug(`Saved editor cookies are not usable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Try the passport cookie snapshot: check-login -> code -> /api/editor/login.
 * Returns null when there is no code or the resulting session is invalid.
 */
export async function loginWithPassportCookies(options: { snapshotPath?: string } = {}): Promise<LoginResult | null> {
  const snapshot = loadCookieSnapshot(options.snapshotPath ?? getPassportCookiesFilePath());
  if (!snapshot) {
    return null;
  }

  const baseUrl = getBaseUrl();
  const checkUrl = new URL(`${getCasUrl()}/api/cas/sso/check-login`);
  const checkCookies = selectCookiesForUrl(snapshot.cookies, checkUrl.toString());
  if (checkCookies.length === 0) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch(checkUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        Origin: baseUrl,
        Referer: `${baseUrl}${EDITOR_PATH}`,
        'User-Agent': USER_AGENT,
        Cookie: cookieHeader(checkCookies),
      },
      body: JSON.stringify({ appId: getAppId() }),
      signal: AbortSignal.timeout(getTimeoutMs()),
    });
  } catch (error) {
    logDebug(`CAS check-login failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const text = await response.text();
  const body = tryParseJson(text);
  if (!response.ok || !isRecord(body) || body.success === false) {
    return null;
  }

  const data = isRecord(body.data) ? body.data : {};
  const code = typeof data.code === 'string' ? data.code : typeof data.authCode === 'string' ? data.authCode : '';
  if (code.trim() === '') {
    return null;
  }

  const cookies = new Map<string, string>();
  const editorSnapshot = loadCookieSnapshot(getEditorCookiesFilePath());
  if (editorSnapshot) {
    for (const cookie of selectCookiesForUrl(editorSnapshot.cookies, `${baseUrl}/api/editor/user`)) {
      cookies.set(cookie.name, cookie.value);
    }
  }

  try {
    await exchangeLoginCode(code, cookies);
    const user = await fetchCurrentUser(cookies);
    const sessionPath = await saveSession(cookies, { user });
    await saveEditorCookies(cookies, baseUrl).catch((error: unknown) => {
      logDebug(`Could not save editor cookie snapshot: ${error instanceof Error ? error.message : String(error)}`);
    });
    return { ok: true, user, sessionPath };
  } catch (error) {
    logDebug(`Passport cookie login failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function exchangeLoginCode(code: string, cookies: Map<string, string>): Promise<void> {
  const baseUrl = getBaseUrl();
  const baseOrigin = new URL(baseUrl).origin;
  let current = new URL(`${baseUrl}/api/editor/login`);
  current.searchParams.set('code', code);

  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetchRequest(current, cookies);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        return;
      }
      const next = new URL(location, current);
      if (next.origin !== baseOrigin) {
        return;
      }
      current = next;
      continue;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`The JLC EDA login endpoint returned HTTP ${response.status}.`);
    }

    const body = tryParseJson(text);
    if (isRecord(body) && body.success === false) {
      const codeText = body.code === undefined ? '' : ` (code ${String(body.code)})`;
      throw new Error(`The JLC EDA login endpoint rejected the authorization code${codeText}.`);
    }
    return;
  }
}

async function fetchCurrentUser(cookies: Map<string, string>): Promise<unknown> {
  const baseUrl = getBaseUrl();
  const response = await fetchRequest(new URL(`${baseUrl}/api/editor/user`), cookies);
  const text = await response.text();
  const body = tryParseJson(text);

  if (!response.ok || !isRecord(body) || body.success !== true) {
    const code = isRecord(body) && body.code !== undefined ? ` (code ${String(body.code)})` : '';
    throw new Error(`The session could not access /api/editor/user${code}.`);
  }

  return body.result ?? body.data ?? body;
}

async function fetchRequest(url: URL, cookies: Map<string, string>): Promise<Response> {
  const baseUrl = getBaseUrl();
  const cookie = formatCookieHeader(cookies);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
        Referer: `${baseUrl}${EDITOR_PATH}`,
        Origin: baseUrl,
        ...(cookie === '' ? {} : { Cookie: cookie }),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(getTimeoutMs()),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Request to JLC EDA failed: ${reason}`);
  }

  captureSetCookies(response.headers, cookies);
  return response;
}

async function saveEditorCookies(cookies: Map<string, string>, baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  const domain = url.hostname;
  const secure = url.protocol === 'https:';
  const list: CdpCookie[] = [...cookies]
    .filter(([name, value]) => name !== '' && value !== '')
    .map(([name, value]) => ({ name, value, domain, path: '/', secure, httpOnly: true, session: true }));

  const chrome: ChromeInfo = { browser: 'node-fetch', endpoint: baseUrl };
  const target: PageTarget = { id: 'api-login', type: 'page', url: `${baseUrl}/api/editor/login` };
  await saveCookieSnapshot(getEditorCookiesFilePath(), domain, list, chrome, target);
}

function cookieHeader(cookies: CdpCookie[]): string {
  return cookies
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function captureSetCookies(headers: Headers, cookies: Map<string, string>): void {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(headers) : [];

  for (const raw of setCookies) {
    const attributes = raw.split(';');
    const pair = attributes[0] ?? '';
    const index = pair.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name === '') {
      continue;
    }

    const expired = isExpiredSetCookie(attributes.slice(1));
    if (value === '' || expired) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
}

/** Max-Age takes precedence over Expires, per RFC 6265. */
function isExpiredSetCookie(attributes: string[]): boolean {
  for (const attribute of attributes) {
    const maxAge = attribute.match(/^\s*max-age\s*=\s*(-?\d+)\s*$/i);
    if (maxAge) {
      return Number(maxAge[1]) <= 0;
    }
  }

  for (const attribute of attributes) {
    const expires = attribute.match(/^\s*expires\s*=\s*(.+)$/i);
    if (expires) {
      const time = Date.parse(expires[1]);
      return Number.isFinite(time) && time <= Date.now();
    }
  }

  return false;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
