import { gunzipSync } from 'node:zlib';
import { EDITOR_PATH, getBaseUrl, getTimeoutMs, USER_AGENT } from '../config.js';
import { logDebug } from '../logger.js';
import { loadSession } from '../session.js';
import { isRecord } from '../utils.js';
import { AuthRequiredError, JlcEcadApiError } from './errors.js';

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiResponse<T = unknown> {
  httpStatus: number;
  data: T;
}

/**
 * GET a JLC EDA editor API endpoint.
 *
 * The endpoint is authenticated by cookies only (the editor frontend does not
 * send an Authorization header). Every call reloads the session so users can
 * update the cookie without restarting the MCP server.
 */
export async function apiGet<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<ApiResponse<T>> {
  const baseUrl = getBaseUrl();
  const url = new URL(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }

  const session = loadSession();
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': USER_AGENT,
    Referer: `${baseUrl}${EDITOR_PATH}`,
    Origin: baseUrl,
  };
  if (session) {
    headers.Cookie = session.cookie;
  }

  logDebug(`GET ${url.pathname}${url.search} (session: ${session ? session.source : 'none'})`);

  const timeoutMs = getTimeoutMs();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new JlcEcadApiError(`Request to JLC EDA timed out after ${timeoutMs} ms.`, { cause: error });
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new JlcEcadApiError(`Failed to reach JLC EDA: ${reason}`, { cause: error });
  }

  // The editor backend sometimes returns raw gzip bytes with
  // "content-type: application/gzip" instead of applying Content-Encoding.
  // Reading bytes and checking the magic number handles both cases.
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = isGzip(buffer) ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  logDebug(`Response ${response.status} from ${url.pathname}${url.search}`);

  let data: unknown;
  try {
    data = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    if (response.status === 401 || isLoginRedirect(response)) {
      throw new AuthRequiredError({ httpStatus: response.status, body: text.slice(0, 300) });
    }
    throw new JlcEcadApiError(`JLC EDA returned a non-JSON response (HTTP ${response.status}): ${truncate(text)}`, {
      httpStatus: response.status,
      body: text.slice(0, 300),
    });
  }

  const businessCode = isRecord(data) ? data.code : undefined;
  const isBusinessAuthError = isRecord(data) && data.success === false && Number(businessCode) === 401;

  if (response.status === 401 || isBusinessAuthError) {
    throw new AuthRequiredError({ httpStatus: response.status, code: 401, body: data });
  }

  if (!response.ok) {
    const detail = extractErrorMessage(data);
    throw new JlcEcadApiError(`JLC EDA API request failed (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`, {
      httpStatus: response.status,
      code: normalizeCode(businessCode),
      body: data,
    });
  }

  if (isRecord(data) && data.success === false) {
    const code = normalizeCode(businessCode);
    const detail = extractErrorMessage(data);
    const codeText = code === undefined ? '' : ` (code ${String(code)})`;
    throw new JlcEcadApiError(`JLC EDA API error${codeText}${detail ? `: ${detail}` : ''}.`, {
      httpStatus: response.status,
      code,
      body: data,
    });
  }

  return { httpStatus: response.status, data: data as T };
}

function normalizeCode(value: unknown): number | string | undefined {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return undefined;
}

function extractErrorMessage(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  for (const key of ['message', 'msg', 'error']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return undefined;
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
}

function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

/** A redirect to the CAS / passport login page means the session is not valid. */
function isLoginRedirect(response: Response): boolean {
  return response.redirected && /(login|passport|cas)/i.test(response.url);
}
