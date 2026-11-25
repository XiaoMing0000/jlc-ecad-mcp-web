import { loginViaCdp } from '../auth/cdp-login.js';
import { loginWithCookie, type LoginResult } from '../auth/login.js';
import { getLoginTimeoutMs, getSessionFilePath } from '../config.js';
import { isRecord } from '../utils.js';
import { readOptionValue } from './options.js';

export const LOGIN_USAGE = `Usage: jlc-ecad-mcp login [options]

Sign in to JLC EDA. It tries the current session, saved editor cookies, and saved
passport cookies first. If all fail, it opens https://www.jlc-ecad.com/editor in
Chrome via CDP, waits for a successful GET /api/editor/user response, saves the
passport.jlc.com and www.jlc-ecad.com cookies, then closes Chrome.

Options:
  --timeout <sec>      Chrome login wait timeout (default: 300)
  --profile-dir <dir>  Reuse an existing Chrome profile instead of a temporary one
  --port <port>        Chrome DevTools port (default: random free port)
  --chrome <path>      Chrome executable
  --login-url <url>    Editor page URL (default: https://www.jlc-ecad.com/editor)
  --cookie <cookie>    Validate and save a Cookie header without Chrome
  -h, --help           Show this help`;

export async function runLoginCommand(argv: string[]): Promise<number> {
  let timeoutMs: number;
  let profileDir: string | undefined;
  let chromePort: number | undefined;
  let chromeBinary: string | undefined;
  let editorUrl: string | undefined;
  let cookie: string | undefined;

  try {
    timeoutMs = getLoginTimeoutMs();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${LOGIN_USAGE}\n`);
      return 0;
    }
    if (argument === '--cookie' || argument.startsWith('--cookie=')) {
      const value = readOptionValue(argument, '--cookie', argv, index);
      if (value === null || value.value.trim() === '') {
        process.stderr.write('Invalid --cookie value; expected a Cookie header value.\n');
        return 2;
      }
      cookie = value.value.trim();
      index = value.index;
      continue;
    }
    if (argument === '--timeout' || argument.startsWith('--timeout=')) {
      const value = readOptionValue(argument, '--timeout', argv, index);
      const seconds = value === null ? Number.NaN : Number(value.value);
      if (value === null || !Number.isFinite(seconds) || seconds <= 0) {
        process.stderr.write('Invalid --timeout value; expected a positive number of seconds.\n');
        return 2;
      }
      timeoutMs = seconds * 1000;
      index = value.index;
      continue;
    }
    if (argument === '--profile-dir' || argument.startsWith('--profile-dir=')) {
      const value = readOptionValue(argument, '--profile-dir', argv, index);
      if (value === null || value.value.trim() === '') {
        process.stderr.write('Invalid --profile-dir value.\n');
        return 2;
      }
      profileDir = value.value;
      index = value.index;
      continue;
    }
    if (argument === '--port' || argument.startsWith('--port=')) {
      const value = readOptionValue(argument, '--port', argv, index);
      const port = value === null ? Number.NaN : Number(value.value);
      if (value === null || !Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write('Invalid --port value; expected an integer from 1 to 65535.\n');
        return 2;
      }
      chromePort = port;
      index = value.index;
      continue;
    }
    if (argument === '--chrome' || argument.startsWith('--chrome=')) {
      const value = readOptionValue(argument, '--chrome', argv, index);
      if (value === null || value.value.trim() === '') {
        process.stderr.write('Invalid --chrome value.\n');
        return 2;
      }
      chromeBinary = value.value;
      index = value.index;
      continue;
    }
    if (argument === '--login-url' || argument.startsWith('--login-url=')) {
      const value = readOptionValue(argument, '--login-url', argv, index);
      if (value === null || value.value.trim() === '') {
        process.stderr.write('Invalid --login-url value.\n');
        return 2;
      }
      editorUrl = value.value;
      index = value.index;
      continue;
    }

    process.stderr.write(`Unknown login option: ${argument}\n\n${LOGIN_USAGE}\n`);
    return 2;
  }

  if (cookie !== undefined) {
    try {
      const result = await loginWithCookie(cookie);
      printLoginSuccess(result);
      return 0;
    } catch (error) {
      process.stderr.write(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.stderr.write('Make sure the cookie includes the authenticated VEN-SESSION value from the JLC EDA site.\n');
      return 1;
    }
  }

  process.stdout.write('Signing in to JLC EDA...\n');
  process.stdout.write('Trying current session, saved editor cookies, and saved passport cookies; Chrome opens only if all fail.\n');

  try {
    const result = await loginViaCdp({
      timeoutMs,
      profileDir,
      chromePort,
      chromeBinary,
      editorUrl,
    });
    printLoginSuccess(result);
    return 0;
  } catch (error) {
    process.stderr.write(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Make sure Chrome is available and remote debugging is allowed; try --chrome <path> or --profile-dir <dir>.\n');
    return 1;
  }
}

function printLoginSuccess(result: LoginResult): void {
  const user = isRecord(result.user) ? result.user : {};
  const name = typeof user.username === 'string' ? user.username : typeof user.nickname === 'string' ? user.nickname : '';

  process.stdout.write(`\nLogin successful${name === '' ? '' : `: ${name}`}.\n`);
  process.stdout.write(`Session saved to: ${result.sessionPath ?? getSessionFilePath()}\n`);

  if (process.env.JLC_ECAD_COOKIE?.trim()) {
    process.stderr.write('Warning: JLC_ECAD_COOKIE is set and takes precedence over the saved session file.\n');
  }
}
