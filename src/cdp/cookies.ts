import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { getPassportCookiesFilePath } from '../config.js';
import { getLegacyCookiePaths, migrateLegacyFile } from '../paths.js';
import { isRecord } from '../utils.js';
import { CdpClient } from './client.js';
import type { PageTarget } from './chrome.js';

export const DEFAULT_COOKIE_HOST = 'passport.jlc.com';
export const DEFAULT_CDP_PORT = 9222;

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  [key: string]: unknown;
}

export interface ChromeInfo {
  browser: string;
  protocolVersion?: string;
  userAgent?: string;
  endpoint: string;
}

export interface CapturedCookies {
  version: 1;
  source: 'cdp';
  host: string;
  capturedAt: string;
  chrome: ChromeInfo;
  target: { id: string; url?: string };
  /** Convenience Cookie header for https://<host>/ using root-path cookies. */
  cookie: string;
  cookies: CdpCookie[];
}

export interface FetchCookiesOptions {
  chromeHost?: string;
  chromePort?: number;
  cookieHost?: string;
  outputPath?: string;
}

export interface FetchCookiesResult {
  outputPath: string;
  host: string;
  count: number;
  cookieNames: string[];
  chrome: ChromeInfo;
}

export interface ReadCookiesResult {
  cookies: CdpCookie[];
  chrome: ChromeInfo;
  target: PageTarget;
}

/** Read every cookie from a running Chrome, without filtering. */
export async function readAllCookiesViaCdp(options: { chromeHost?: string; chromePort?: number } = {}): Promise<ReadCookiesResult> {
  const chromeHost = options.chromeHost ?? '127.0.0.1';
  const chromePort = options.chromePort ?? DEFAULT_CDP_PORT;
  const endpoint = `http://${chromeHost}:${chromePort}`;

  const chrome = await readChromeInfo(endpoint);
  const target = await findPageTarget(endpoint);
  if (!target.webSocketDebuggerUrl) {
    throw new Error('The selected Chrome page target has no WebSocket debugger URL.');
  }

  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send('Network.enable');
    return { cookies: await readAllCookies(client), chrome, target };
  } finally {
    client.close();
  }
}

/** Save a 0600 snapshot of the given cookies for one domain. */
export async function saveCookieSnapshot(
  outputPath: string,
  host: string,
  cookies: CdpCookie[],
  chrome: ChromeInfo,
  target: PageTarget,
): Promise<string> {
  const resolved = resolve(outputPath);
  await writeSnapshot(resolved, buildSnapshot(host, cookies, chrome, target));
  return resolved;
}

/**
 * Connect to a running Chrome via the DevTools Protocol, read all browser
 * cookies with Network.getAllCookies, filter them for `cookieHost`, and save a
 * 0600 JSON snapshot to the project directory.
 */
export async function fetchCookiesViaCdp(options: FetchCookiesOptions = {}): Promise<FetchCookiesResult> {
  const cookieHost = options.cookieHost ?? DEFAULT_COOKIE_HOST;
  const { cookies, chrome, target } = await readAllCookiesViaCdp(options);
  const matched = cookies.filter((cookie) => cookieDomainMatchesHost(cookie.domain, cookieHost));
  const outputPath = await saveCookieSnapshot(options.outputPath ?? getPassportCookiesFilePath(), cookieHost, matched, chrome, target);

  return {
    outputPath,
    host: cookieHost,
    count: matched.length,
    cookieNames: matched.map((cookie) => cookie.name),
    chrome,
  };
}

/** Return true when a cookie domain (for example ".jlc.com") applies to host. */
export function cookieDomainMatchesHost(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.trim().replace(/^\./, '').toLowerCase();
  const target = host.trim().toLowerCase();
  if (domain === '' || target === '') {
    return false;
  }
  return target === domain || target.endsWith(`.${domain}`);
}

/** Load a cookie snapshot written by saveCookieSnapshot/fetchCookiesViaCdp. */
export function loadCookieSnapshot(outputPath: string): CapturedCookies | null {
  migrateLegacyFile(outputPath, getLegacyCookiePaths(basename(outputPath)));

  let raw: string;
  try {
    raw = readFileSync(outputPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) {
    return null;
  }

  return parsed as unknown as CapturedCookies;
}

/** Select cookies that apply to requestUrl (domain, path, secure, expiry). */
export function selectCookiesForUrl(cookies: CdpCookie[], requestUrl: string): CdpCookie[] {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return [];
  }

  const nowSeconds = Date.now() / 1000;
  return cookies.filter((cookie) => {
    const expires = cookie.expires ?? -1;
    if (expires >= 0 && expires <= nowSeconds) {
      return false;
    }
    if (url.protocol === 'http:' && cookie.secure === true) {
      return false;
    }
    return cookieDomainMatchesHost(cookie.domain, url.hostname) && cookiePathMatches(cookie.path, url.pathname);
  });
}

function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === '' || cookiePath === '/') {
    return true;
  }
  if (requestPath === cookiePath) {
    return true;
  }
  const prefix = cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`;
  return requestPath.startsWith(prefix);
}

async function readAllCookies(client: CdpClient): Promise<CdpCookie[]> {
  try {
    const result = await client.send<{ cookies?: CdpCookie[] }>('Network.getAllCookies');
    return result.cookies ?? [];
  } catch {
    // Storage.getCookies is the newer API and works on page targets too.
    const result = await client.send<{ cookies?: CdpCookie[] }>('Storage.getCookies', {});
    return result.cookies ?? [];
  }
}

async function readChromeInfo(endpoint: string): Promise<ChromeInfo> {
  const version = await fetchJson<{
    Browser?: string;
    'Protocol-Version'?: string;
    'User-Agent'?: string;
  }>(`${endpoint}/json/version`);

  return {
    browser: version.Browser ?? 'unknown',
    protocolVersion: version['Protocol-Version'],
    userAgent: version['User-Agent'],
    endpoint,
  };
}

async function findPageTarget(endpoint: string): Promise<PageTarget> {
  const targets = await fetchJson<PageTarget[]>(`${endpoint}/json/list`);
  const page = targets.find(
    (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string' && !(target.url ?? '').startsWith('devtools://'),
  );

  if (page) {
    return page;
  }

  return createPageTarget(endpoint);
}

async function createPageTarget(endpoint: string): Promise<PageTarget> {
  for (const method of ['PUT', 'GET'] as const) {
    const response = await fetch(`${endpoint}/json/new?about:blank`, {
      method,
      signal: AbortSignal.timeout(5_000),
    });

    if (response.ok) {
      return (await response.json()) as PageTarget;
    }
    if (response.status !== 404 && response.status !== 405) {
      throw new Error(`Could not create a Chrome page target (HTTP ${response.status}).`);
    }
  }

  throw new Error('No Chrome page target is available, and Chrome refused to create one. Open about:blank in Chrome and retry.');
}

async function fetchJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`Could not reach Chrome DevTools at ${url}. Start Chrome with --remote-debugging-port and --remote-allow-origins=*.`, {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`Chrome DevTools returned HTTP ${response.status} for ${url}.`);
  }

  return (await response.json()) as T;
}

function buildSnapshot(host: string, cookies: CdpCookie[], chrome: ChromeInfo, target: PageTarget): CapturedCookies {
  const nowSeconds = Date.now() / 1000;
  const usable = cookies.filter((cookie) => {
    if (cookie.value === '') {
      return false;
    }
    const expires = cookie.expires ?? -1;
    return expires < 0 || expires > nowSeconds;
  });

  const cookieHeader = usable
    .filter((cookie) => cookiePathMatchesRoot(cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');

  return {
    version: 1,
    source: 'cdp',
    host,
    capturedAt: new Date().toISOString(),
    chrome,
    target: { id: target.id, url: target.url },
    cookie: cookieHeader,
    cookies: usable,
  };
}

function cookiePathMatchesRoot(cookiePath: string): boolean {
  return cookiePath === '' || cookiePath === '/';
}

async function writeSnapshot(outputPath: string, snapshot: CapturedCookies): Promise<void> {
  const directory = dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700).catch(() => undefined);
  }
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(outputPath, 0o600);
  }
}
