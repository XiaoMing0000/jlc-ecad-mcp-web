import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getSessionFilePath } from './config.js';
import { logDebug } from './logger.js';
import { getLegacySessionPaths, migrateLegacyFile } from './paths.js';
import { isRecord } from './utils.js';

export type SessionSource = 'env' | 'file';

export interface SessionCredentials {
  /** Value for the HTTP Cookie header. */
  cookie: string;
  source: SessionSource;
}

export class SessionLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionLoadError';
  }
}

export class SessionSaveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionSaveError';
  }
}

/**
 * Load the stored login session.
 *
 * Priority:
 *   1. JLC_ECAD_COOKIE
 *   2. JLC_ECAD_SESSION_FILE
 *   3. ~/.jlc-ecad-mcp/session.json
 *
 * Returns null when no session is configured. `loadSession` is called on every
 * request so a future login flow can write the file without restarting the
 * server.
 */
export function loadSession(): SessionCredentials | null {
  const envCookie = process.env.JLC_ECAD_COOKIE?.trim();
  if (envCookie) {
    return { cookie: assertCookie(envCookie, 'JLC_ECAD_COOKIE'), source: 'env' };
  }

  const filePath = getSessionFilePath();
  migrateLegacyFile(filePath, getLegacySessionPaths());

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      logDebug(`No session file at ${filePath}.`);
      return null;
    }
    if (isNodeError(error) && error.code === 'EACCES') {
      throw new SessionLoadError(`Cannot read the session file at ${filePath}: permission denied.`, { cause: error });
    }
    throw new SessionLoadError(`Cannot read the session file at ${filePath}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SessionLoadError(
      `The session file at ${filePath} is not valid JSON. Expected {"cookie":"VEN-SESSION=...; ..."} or {"cookies":{"VEN-SESSION":"..."}}.`,
      { cause: error },
    );
  }

  const cookie = extractCookie(parsed);
  if (!cookie) {
    throw new SessionLoadError(`The session file at ${filePath} does not contain a cookie. Add a non-empty "cookie" string or a "cookies" object.`);
  }

  logDebug(`Loaded session from ${filePath}.`);
  return { cookie: assertCookie(cookie, 'session file'), source: 'file' };
}

function extractCookie(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }

  if (typeof value.cookie === 'string' && value.cookie.trim() !== '') {
    return value.cookie.trim();
  }

  if (isRecord(value.cookies)) {
    const pairs: string[] = [];
    for (const [name, cookieValue] of Object.entries(value.cookies)) {
      if (name.trim() === '' || typeof cookieValue !== 'string' || cookieValue === '') {
        continue;
      }
      pairs.push(`${name}=${cookieValue}`);
    }
    if (pairs.length > 0) {
      return pairs.join('; ');
    }
  }

  return '';
}

/** Reject header injection through a maliciously edited session file or env var. */
function assertCookie(cookie: string, origin: string): string {
  if (/[\r\n]/.test(cookie)) {
    throw new SessionLoadError(`The cookie from ${origin} contains a line break and cannot be used.`);
  }
  return cookie;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Parse a Cookie request header into a name/value map. */
export function parseCookieHeader(cookie: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name !== '') {
      cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

/** Serialize a cookie map into a Cookie request header. */
export function formatCookieHeader(cookies: Map<string, string> | Record<string, string>): string {
  const entries = cookies instanceof Map ? [...cookies.entries()] : Object.entries(cookies);
  const parts: string[] = [];

  for (const [name, value] of entries) {
    const cookieName = name.trim();
    if (cookieName === '' || typeof value !== 'string' || value === '') {
      continue;
    }
    if (/[\r\n]/.test(cookieName) || /[\r\n]/.test(value)) {
      continue;
    }
    parts.push(`${cookieName}=${value}`);
  }

  return parts.join('; ');
}

export interface SaveSessionOptions {
  /** Optional profile cached alongside the cookies. */
  user?: unknown;
}

/**
 * Persist cookies to the session file using an atomic replace.
 * The file is written with 0600 permissions on POSIX systems.
 */
export async function saveSession(cookies: Map<string, string> | Record<string, string>, options: SaveSessionOptions = {}): Promise<string> {
  const cookieMap = cookies instanceof Map ? new Map(cookies) : new Map(Object.entries(cookies));
  const cookie = formatCookieHeader(cookieMap);
  if (cookie === '') {
    throw new SessionSaveError('Refusing to save an empty session cookie.');
  }

  const filePath = getSessionFilePath();
  const cookiesObject = Object.fromEntries([...cookieMap].filter(([name, value]) => name.trim() !== '' && value !== ''));
  const data = {
    version: 1,
    cookie,
    cookies: cookiesObject,
    updatedAt: new Date().toISOString(),
    ...(options.user === undefined ? {} : { user: options.user }),
  };
  const directory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(directory, 0o700).catch(() => undefined);
    }
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      await chmod(filePath, 0o600);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new SessionSaveError(`Failed to save the session file at ${filePath}.`, { cause: error });
  }

  logDebug(`Saved session to ${filePath}.`);
  return filePath;
}
