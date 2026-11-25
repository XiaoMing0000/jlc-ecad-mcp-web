import { homedir } from 'node:os';
import { join } from 'node:path';

/** MCP server name exposed to clients. */
export const SERVER_NAME = 'jlc-ecad-mcp';
export const SERVER_TITLE = 'JLC EDA MCP';

/** JLC EDA editor origin. */
export const DEFAULT_BASE_URL = 'https://www.jlc-ecad.com';
export const EDITOR_PATH = '/editor';

/** JLC CAS (passport) login center, used by the passport-cookie fallback. */
export const DEFAULT_CAS_URL = 'https://passport.jlc.com';
export const DEFAULT_APP_ID = 'jlc_fa_ecad';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The editor bundle talks to the backend without an Authorization header, so a
 * browser-like User-Agent keeps us consistent with normal same-origin traffic.
 */
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Base URL used for API requests. Overridable for tests or a local proxy. */
export function getBaseUrl(): string {
  return normalizeHttpUrl(process.env.JLC_ECAD_BASE_URL, DEFAULT_BASE_URL, 'JLC_ECAD_BASE_URL');
}

/** CAS login center. Overridable for tests. */
export function getCasUrl(): string {
  return normalizeHttpUrl(process.env.JLC_ECAD_CAS_URL, DEFAULT_CAS_URL, 'JLC_ECAD_CAS_URL');
}

/** CAS application id used by the JLC EDA editor. */
export function getAppId(): string {
  return process.env.JLC_ECAD_APP_ID?.trim() || DEFAULT_APP_ID;
}

/** How long the browser login flow waits for the callback. */
export function getLoginTimeoutMs(): number {
  return parsePositiveNumber(process.env.JLC_ECAD_LOGIN_TIMEOUT_MS, DEFAULT_LOGIN_TIMEOUT_MS, 'JLC_ECAD_LOGIN_TIMEOUT_MS');
}

/** Request timeout in milliseconds. */
export function getTimeoutMs(): number {
  return parsePositiveNumber(process.env.JLC_ECAD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'JLC_ECAD_TIMEOUT_MS');
}

function normalizeHttpUrl(raw: string | undefined, fallback: string, envName: string): string {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} is not a valid URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http or https: ${value}`);
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function parsePositiveNumber(raw: string | undefined, fallback: number, envName: string): number {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive number: ${value}`);
  }

  return parsed;
}

/**
 * User-scoped configuration directory for credentials.
 *
 * Default: ~/Documents/JLC-ECAD/jlc-ecad-mcp-web
 * (Windows: %USERPROFILE%\Documents\JLC-ECAD\jlc-ecad-mcp-web)
 *
 * Override the whole directory with JLC_ECAD_HOME (useful for profiles or tests).
 */
export function getConfigDir(): string {
  const override = process.env.JLC_ECAD_HOME?.trim();
  if (override) {
    return override;
  }

  return join(homedir(), 'Documents', 'JLC-ECAD', 'jlc-ecad-mcp-web');
}

/**
 * Editor session file. Defaults to <config-dir>/session.json.
 * Can be overridden with JLC_ECAD_SESSION_FILE.
 */
export function getSessionFilePath(): string {
  const override = process.env.JLC_ECAD_SESSION_FILE?.trim();
  if (override) {
    return override;
  }

  return join(getConfigDir(), 'session.json');
}

/**
 * Snapshot of passport.jlc.com cookies captured via CDP.
 * Defaults to <config-dir>/passport-cookies.json.
 * Can be overridden with JLC_ECAD_PASSPORT_COOKIES_FILE.
 */
export function getPassportCookiesFilePath(): string {
  const override = process.env.JLC_ECAD_PASSPORT_COOKIES_FILE?.trim();
  if (override) {
    return override;
  }

  return join(getConfigDir(), 'passport-cookies.json');
}

/**
 * Snapshot of www.jlc-ecad.com cookies captured via CDP.
 * Defaults to <config-dir>/editor-cookies.json.
 * Can be overridden with JLC_ECAD_EDITOR_COOKIES_FILE.
 */
export function getEditorCookiesFilePath(): string {
  const override = process.env.JLC_ECAD_EDITOR_COOKIES_FILE?.trim();
  if (override) {
    return override;
  }

  return join(getConfigDir(), 'editor-cookies.json');
}
