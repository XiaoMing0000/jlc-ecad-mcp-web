import { gunzipSync } from 'node:zlib';
import { EDITOR_PATH, getBaseUrl, getTimeoutMs, USER_AGENT } from '../config.js';
import { logDebug } from '../logger.js';
import { loadSession } from '../session.js';
import { isRecord } from '../utils.js';
import { AuthRequiredError, JlcEcadApiError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface ApiResponse<T = unknown> {
  httpStatus: number;
  data: T;
}

/** A raw response, including binary bodies, for the generic ECAD tool executor. */
export interface ApiRawResponse {
  httpStatus: number;
  contentType: string;
  buffer: Buffer;
  text: string;
  data: unknown;
  isJson: boolean;
}

export interface ApiRequestOptions {
  method?: HttpMethod;
  path: string;
  query?: QueryParams;
  /** JSON request body (GET requests ignore this). */
  body?: unknown;
  /** Raw request body, for endpoints that accept application/octet-stream. */
  rawBody?: Uint8Array;
  contentType?: string;
  accept?: string;
  timeoutMs?: number;
  /** Throw when a non-empty successful response is not valid JSON. */
  requireJson?: boolean;
  /** Tool name used in the 401 guidance. Defaults to jlc_ecad_get_user. */
  retryTool?: string;
}

/**
 * Call a JLC EDA editor API endpoint.
 *
 * The endpoint is authenticated by cookies only (the editor frontend does not
 * send an Authorization header). Every call reloads the session so users can
 * update the cookie without restarting the MCP server.
 *
 * Unlike apiGet, this function keeps binary bodies intact so tools such as
 * snapshot/chunk endpoints can return them without corrupting the bytes.
 */
export async function apiRequest(options: ApiRequestOptions): Promise<ApiRawResponse> {
  const method = options.method ?? 'GET';
  const baseUrl = getBaseUrl();
  const url = new URL(`${baseUrl}${options.path.startsWith('/') ? options.path : `/${options.path}`}`);
  appendQuery(url, options.query);

  const session = loadSession();
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/json, text/plain, */*',
    'User-Agent': USER_AGENT,
    Referer: `${baseUrl}${EDITOR_PATH}`,
    Origin: baseUrl,
  };
  if (session) {
    headers.Cookie = session.cookie;
  }
  if (options.rawBody !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'application/json';
  }

  logDebug(`${method} ${url.pathname}${url.search} (session: ${session ? session.source : 'none'})`);

  const timeoutMs = options.timeoutMs ?? getTimeoutMs();
  const init: RequestInit = {
    method,
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (method !== 'GET') {
    if (options.rawBody !== undefined) {
      init.body = options.rawBody as RequestInit['body'];
    } else if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, init);
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
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  const buffer = isGzip(rawBuffer) ? gunzipSync(rawBuffer) : rawBuffer;
  const text = buffer.toString('utf8');
  const parsed = parseJson(text);
  logDebug(`Response ${response.status} from ${url.pathname}${url.search}`);

  const bodyForError = parsed.isJson ? parsed.data : truncate(text);
  const businessCode = parsed.isJson && isRecord(parsed.data) ? parsed.data.code : undefined;
  const isBusinessAuthError = parsed.isJson && isRecord(parsed.data) && parsed.data.success === false && Number(businessCode) === 401;

  if (response.status === 401 || (isLoginRedirect(response) && !parsed.isJson) || isBusinessAuthError) {
    throw new AuthRequiredError({
      httpStatus: response.status,
      code: 401,
      body: bodyForError,
      retryTool: options.retryTool,
    });
  }

  if (!response.ok) {
    const detail = parsed.isJson ? extractErrorMessage(parsed.data) : undefined;
    throw new JlcEcadApiError(`JLC EDA API request failed (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`, {
      httpStatus: response.status,
      code: normalizeCode(businessCode),
      body: bodyForError,
    });
  }

  if (parsed.isJson && isRecord(parsed.data) && parsed.data.success === false) {
    const code = normalizeCode(businessCode);
    const detail = extractErrorMessage(parsed.data);
    const codeText = code === undefined ? '' : ` (code ${String(code)})`;
    throw new JlcEcadApiError(`JLC EDA API error${codeText}${detail ? `: ${detail}` : ''}.`, {
      httpStatus: response.status,
      code,
      body: parsed.data,
    });
  }

  if (options.requireJson && !parsed.isJson && text.trim() !== '') {
    throw new JlcEcadApiError(`JLC EDA returned a non-JSON response (HTTP ${response.status}): ${truncate(text)}`, {
      httpStatus: response.status,
      body: text.slice(0, 300),
    });
  }

  return {
    httpStatus: response.status,
    contentType,
    buffer,
    text,
    data: parsed.data,
    isJson: parsed.isJson,
  };
}

/**
 * GET a JLC EDA editor API endpoint and require a JSON response.
 * Kept as a small wrapper for existing callers that only need the parsed body.
 */
export async function apiGet<T = unknown>(path: string, query?: QueryParams): Promise<ApiResponse<T>> {
  const response = await apiRequest({ method: 'GET', path, query, requireJson: true });
  const data = response.text.trim() === '' ? null : response.data;
  return { httpStatus: response.httpStatus, data: data as T };
}

function appendQuery(url: URL, query: QueryParams | undefined): void {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        // The editor frontend serializes array query values as key[]=...
        url.searchParams.append(`${key}[]`, String(item));
      }
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.append(key, String(value));
  }
}

function parseJson(text: string): { isJson: boolean; data: unknown } {
  if (text.trim() === '') {
    return { isJson: false, data: undefined };
  }
  try {
    return { isJson: true, data: JSON.parse(text) };
  } catch {
    return { isJson: false, data: undefined };
  }
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
