import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CdpClient } from './client.js';

export interface PageTarget {
  id: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface DevToolsVersion {
  webSocketDebuggerUrl?: string;
}

export interface ChromeLaunchOptions {
  binary: string;
  port: number;
  userDataDir: string;
  url: string;
}

export interface LaunchedChrome {
  child: ChildProcess;
  stderr(): string;
}

/** Locate a Chrome/Chromium executable. JLC_CDP_CHROME or --chrome overrides it. */
export async function findChromeBinary(explicit?: string): Promise<string> {
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(`Chrome executable not found: ${explicit}`);
    }
  }

  const candidates = [
    process.env.JLC_CDP_CHROME,
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : undefined,
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe') : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : undefined,
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Chrome executable not found. Set JLC_CDP_CHROME or pass --chrome <path>.');
}

/** Launch Chrome with remote debugging and the given URL. Port 0 lets Chrome choose. */
export function launchChrome(options: ChromeLaunchOptions): LaunchedChrome {
  const child = spawn(
    options.binary,
    [
      `--remote-debugging-port=${options.port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${options.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      options.url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < 4000) {
      stderr += chunk;
    }
  });

  return { child, stderr: () => stderr };
}

/**
 * Read the actual DevTools port from <user-data-dir>/DevToolsActivePort.
 * Used when Chrome is started with --remote-debugging-port=0.
 */
export async function readDevToolsPort(userDataDir: string, child: ChildProcess, timeoutMs = 20_000): Promise<number> {
  const filePath = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.pid === undefined) {
      throw new Error('Chrome failed to start.');
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited before writing DevToolsActivePort (code ${child.exitCode ?? child.signalCode}).`);
    }

    try {
      const content = await readFile(filePath, 'utf8');
      const [firstLine] = content.split(/\r?\n/);
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch {
      // Chrome has not written the file yet.
    }

    await delay(100);
  }

  throw new Error('Timed out waiting for Chrome to write DevToolsActivePort.');
}

/** Wait until the DevTools HTTP endpoint responds. */
export async function waitForChrome(port: number, child: ChildProcess, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let spawnError: Error | undefined;
  const onError = (error: Error): void => {
    spawnError = error;
  };
  child.once('error', onError);

  try {
    while (Date.now() < deadline) {
      if (spawnError) {
        throw spawnError;
      }
      if (child.pid === undefined) {
        throw new Error('Chrome failed to start.');
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before DevTools became available (code ${child.exitCode ?? child.signalCode}).`);
      }

      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          return;
        }
      } catch {
        // Retry until the deadline.
      }

      await delay(200);
    }
  } finally {
    child.off('error', onError);
  }

  if (spawnError) {
    throw spawnError;
  }
  throw new Error(`Timed out waiting for Chrome DevTools on 127.0.0.1:${port}.`);
}

/** List debuggable page targets. */
export async function listPageTargets(port: number): Promise<PageTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    return [];
  }

  const targets = (await response.json()) as PageTarget[];
  return targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string');
}

/** Close the launched Chrome instance, preferring a graceful Browser.close. */
export async function closeChrome(port: number, child: ChildProcess): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      const version = (await response.json()) as DevToolsVersion;
      if (version.webSocketDebuggerUrl) {
        const client = await CdpClient.connect(version.webSocketDebuggerUrl, {
          connectTimeoutMs: 2_000,
          requestTimeoutMs: 2_000,
        });
        try {
          await client.send('Browser.close');
        } catch {
          // The browser usually closes the socket before replying.
        } finally {
          client.close();
        }
      }
    }
  } catch {
    // Fall back to killing the process.
  }

  if (await waitForExit(child, 3_000)) {
    return;
  }

  child.kill('SIGTERM');
  if (await waitForExit(child, 2_000)) {
    return;
  }

  child.kill('SIGKILL');
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);

    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };

    child.once('exit', onExit);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
