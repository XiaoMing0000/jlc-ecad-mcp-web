import { getPassportCookiesFilePath } from '../config.js';
import { DEFAULT_CDP_PORT, DEFAULT_COOKIE_HOST, fetchCookiesViaCdp } from '../cdp/cookies.js';
import { readOptionValue } from './options.js';

export const CDP_COOKIES_USAGE = `Usage: jlc-ecad-mcp cdp-cookies [options]

Read cookies for passport.jlc.com from a running Chrome via the DevTools Protocol
(Network.getAllCookies) and save them to a local JSON file.

Options:
  --host <host>       Chrome DevTools host (default: 127.0.0.1)
  --port <port>       Chrome DevTools port (default: ${DEFAULT_CDP_PORT})
  --domain <domain>   Cookie domain to read (default: passport.jlc.com)
  --output <path>     Output file (default: ${getPassportCookiesFilePath()})
  -h, --help          Show this help

Chrome must be started with remote debugging, for example:
  google-chrome --remote-debugging-port=9222 --remote-allow-origins=*

Recent Chrome versions may require a non-default --user-data-dir for remote
debugging. In that case start Chrome with a separate profile and sign in there:
  google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/jlc-cdp \\
    --remote-allow-origins=* https://www.jlc-ecad.com/editor`;

export async function runCdpCookiesCommand(argv: string[]): Promise<number> {
  let host = '127.0.0.1';
  let port = DEFAULT_CDP_PORT;
  let domain = DEFAULT_COOKIE_HOST;
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${CDP_COOKIES_USAGE}\n`);
      return 0;
    }
    if (argument === '--host' || argument.startsWith('--host=')) {
      const value = readOptionValue(argument, '--host', argv, index);
      if (value === null) {
        process.stderr.write('Invalid --host value.\n');
        return 2;
      }
      host = value.value;
      index = value.index;
      continue;
    }
    if (argument === '--port' || argument.startsWith('--port=')) {
      const value = readOptionValue(argument, '--port', argv, index);
      const parsed = value === null ? Number.NaN : Number(value.value);
      if (value === null || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        process.stderr.write('Invalid --port value; expected an integer from 1 to 65535.\n');
        return 2;
      }
      port = parsed;
      index = value.index;
      continue;
    }
    if (argument === '--domain' || argument.startsWith('--domain=')) {
      const value = readOptionValue(argument, '--domain', argv, index);
      if (value === null || value.value.trim() === '') {
        process.stderr.write('Invalid --domain value.\n');
        return 2;
      }
      domain = value.value.trim();
      index = value.index;
      continue;
    }
    if (argument === '--output' || argument.startsWith('--output=')) {
      const value = readOptionValue(argument, '--output', argv, index);
      if (value === null || value.value.trim() === '') {
        process.stderr.write('Invalid --output value.\n');
        return 2;
      }
      outputPath = value.value;
      index = value.index;
      continue;
    }

    process.stderr.write(`Unknown cdp-cookies option: ${argument}\n\n${CDP_COOKIES_USAGE}\n`);
    return 2;
  }

  try {
    const result = await fetchCookiesViaCdp({
      chromeHost: host,
      chromePort: port,
      cookieHost: domain,
      outputPath,
    });

    process.stdout.write(`Chrome: ${result.chrome.browser}\n`);

    if (result.count === 0) {
      process.stderr.write(`No cookies found for ${result.host}.\n`);
      process.stderr.write('Make sure Chrome is signed in to https://passport.jlc.com and that you are connected to the right Chrome profile.\n');
      process.stdout.write(`Saved an empty snapshot to: ${result.outputPath}\n`);
      return 1;
    }

    process.stdout.write(`Found ${result.count} cookie(s) for ${result.host}: ${result.cookieNames.join(', ')}\n`);
    process.stdout.write(`Saved to: ${result.outputPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Failed to read cookies: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`Start Chrome with: google-chrome --remote-debugging-port=${port} --remote-allow-origins=*\n`);
    process.stderr.write('Recent Chrome versions may require a non-default --user-data-dir.\n');
    return 1;
  }
}
