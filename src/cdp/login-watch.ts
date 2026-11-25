import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { getEditorCookiesFilePath, getPassportCookiesFilePath } from '../config.js';
import { saveSession } from '../session.js';
import { isRecord } from '../utils.js';
import { closeChrome, delay, findChromeBinary, launchChrome, listPageTargets, readDevToolsPort, waitForChrome, type PageTarget } from './chrome.js';
import { CdpClient } from './client.js';
import { cookieDomainMatchesHost, readAllCookiesViaCdp, saveCookieSnapshot, selectCookiesForUrl } from './cookies.js';

export const DEFAULT_EDITOR_URL = 'https://www.jlc-ecad.com/editor';
export const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60 * 1000;

export interface WatchLoginOptions {
  editorUrl?: string;
  timeoutMs?: number;
  chromePort?: number;
  chromeBinary?: string;
  /** Reuse an existing profile (for example /tmp/jlc-cdp-profile). Not deleted afterwards. */
  profileDir?: string;
}

export interface WatchLoginResult {
  user: unknown;
  sessionPath: string;
  passportCookieCount: number;
  editorCookieCount: number;
}

interface NetworkResponseReceived {
  requestId: string;
  response: { url: string; status: number };
}

interface NetworkLoadingFinished {
  requestId: string;
}

/**
 * Open the JLC EDA editor in Chrome, wait for a successful
 * https://www.jlc-ecad.com/api/editor/user response, then save:
 *
 *   - passport.jlc.com cookies to ./.jlc-ecad-mcp/passport-cookies.json
 *   - www.jlc-ecad.com cookies to <config-dir>/session.json
 *
 * The Chrome window is closed afterwards.
 */
export async function watchEditorLogin(options: WatchLoginOptions = {}): Promise<WatchLoginResult> {
  const editorUrl = options.editorUrl ?? DEFAULT_EDITOR_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
  const requestedPort = options.chromePort;
  const binary = await findChromeBinary(options.chromeBinary);
  const profileDir = options.profileDir ?? (await mkdtemp(join(tmpdir(), 'jlc-cdp-login-')));
  const ownsProfile = options.profileDir === undefined;

  let port = requestedPort ?? 0;
  const { child, stderr } = launchChrome({ binary, port, userDataDir: profileDir, url: editorUrl });

  let settled = false;
  const timers: { discovery?: NodeJS.Timeout; timeout?: NodeJS.Timeout } = {};
  const clients = new Map<string, CdpClient>();

  let resolveResult!: (value: WatchLoginResult) => void;
  let rejectResult!: (reason: Error) => void;
  const resultPromise = new Promise<WatchLoginResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const cleanup = (): void => {
    if (timers.discovery) {
      clearInterval(timers.discovery);
    }
    if (timers.timeout) {
      clearTimeout(timers.timeout);
    }
    for (const client of clients.values()) {
      client.close();
    }
    clients.clear();
  };

  const fail = (error: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    void (async () => {
      cleanup();
      await closeChrome(port, child).catch(() => undefined);
      if (ownsProfile) {
        await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
      }
      rejectResult(error);
    })();
  };

  const succeed = (user: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    void (async () => {
      cleanup();
      try {
        await delay(250);
        const all = await readAllCookiesViaCdp({ chromePort: port });
        const passportCookies = all.cookies.filter((cookie) => cookieDomainMatchesHost(cookie.domain, 'passport.jlc.com'));
        const editorCookies = selectCookiesForUrl(all.cookies, 'https://www.jlc-ecad.com/');

        await saveCookieSnapshot(getPassportCookiesFilePath(), 'passport.jlc.com', passportCookies, all.chrome, all.target);
        await saveCookieSnapshot(getEditorCookiesFilePath(), 'www.jlc-ecad.com', editorCookies, all.chrome, all.target);

        const editorMap = new Map<string, string>();
        for (const cookie of editorCookies) {
          if (cookie.name !== '' && cookie.value !== '') {
            editorMap.set(cookie.name, cookie.value);
          }
        }
        if (editorMap.size === 0) {
          throw new Error('The editor session cookies were not found after login.');
        }

        const sessionPath = await saveSession(editorMap, { user });
        await closeChrome(port, child);
        if (ownsProfile) {
          await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        }

        resolveResult({
          user,
          sessionPath,
          passportCookieCount: passportCookies.length,
          editorCookieCount: editorCookies.length,
        });
      } catch (error) {
        await closeChrome(port, child).catch(() => undefined);
        if (ownsProfile) {
          await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
        }
        rejectResult(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  };

  child.once('error', (error) => {
    fail(new Error(`Failed to launch Chrome: ${error.message}`));
  });
  child.once('exit', (code, signal) => {
    if (!settled) {
      fail(new Error(`Chrome exited before a successful /api/editor/user response (code ${code ?? signal}).\n${stderr()}`));
    }
  });

  try {
    if (port === 0) {
      port = await readDevToolsPort(profileDir, child);
    }
    await waitForChrome(port, child);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    return resultPromise;
  }

  const attaching = new Set<string>();

  const readEditorUserBody = async (client: CdpClient, requestId: string): Promise<void> => {
    try {
      const body = await client.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId });
      let buffer = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
      if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        buffer = gunzipSync(buffer);
      }
      const text = buffer.toString('utf8');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      if (!isLoggedInEditorUser(data)) {
        return;
      }
      const user = isRecord(data.result) ? data.result : isRecord(data.data) ? data.data : data;
      succeed(user);
    } catch {
      // The body may be unavailable (preflight/redirect); ignore and keep listening.
    }
  };

  const attach = async (target: PageTarget): Promise<void> => {
    if (clients.has(target.id) || attaching.has(target.id) || !target.webSocketDebuggerUrl) {
      return;
    }
    attaching.add(target.id);

    try {
      const client = await CdpClient.connect(target.webSocketDebuggerUrl, { connectTimeoutMs: 2_000 });
      clients.set(target.id, client);

      const matched = new Set<string>();
      client.onEvent<NetworkResponseReceived>('Network.responseReceived', (params) => {
        if (isEditorUserUrl(params.response.url, editorUrl)) {
          matched.add(params.requestId);
        }
      });
      client.onEvent<NetworkLoadingFinished>('Network.loadingFinished', (params) => {
        if (!matched.delete(params.requestId)) {
          return;
        }
        void readEditorUserBody(client, params.requestId);
      });

      await client.send('Network.enable');
    } catch {
      const client = clients.get(target.id);
      client?.close();
      clients.delete(target.id);
    } finally {
      attaching.delete(target.id);
    }
  };

  const refreshTargets = async (): Promise<void> => {
    try {
      const targets = await listPageTargets(port);
      await Promise.all(targets.map((target) => attach(target)));
    } catch {
      // Chrome may be closing; the child exit handler will report it.
    }
  };

  await refreshTargets();
  timers.discovery = setInterval(() => {
    void refreshTargets();
  }, 250);

  timers.timeout = setTimeout(() => {
    fail(
      new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for a successful /api/editor/user response. ` +
          'Make sure you completed sign-in in the opened Chrome window.',
      ),
    );
  }, timeoutMs);

  return resultPromise;
}

function isEditorUserUrl(rawUrl: string, editorUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const editor = new URL(editorUrl);
    return (
      url.protocol === editor.protocol &&
      url.host.toLowerCase() === editor.host.toLowerCase() &&
      (url.pathname === '/api/editor/user' || url.pathname === '/api/editor/user/')
    );
  } catch {
    return false;
  }
}

function isLoggedInEditorUser(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.success === true && (isRecord(value.result) || isRecord(value.data));
}
