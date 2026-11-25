#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runCdpCookiesCommand } from './cli/cdp-cookies.js';
import { runLoginCommand } from './cli/login.js';
import { runLogoutCommand } from './cli/logout.js';
import { getPassportCookiesFilePath, getSessionFilePath } from './config.js';
import { DEFAULT_CDP_PORT } from './cdp/cookies.js';
import { logDebug, logError, logInfo } from './logger.js';
import { createServer } from './server.js';
import { getPackageVersion } from './version.js';

const USAGE = `jlc-ecad-mcp - MCP server for the JLC EDA editor API

Usage:
  jlc-ecad-mcp                     Start the MCP server over stdio
  jlc-ecad-mcp login [opts]        Sign in via Chrome CDP (editor page) and save the session
  jlc-ecad-mcp logout              Remove local session and cookie files
  jlc-ecad-mcp cdp-cookies [opts]  Read passport.jlc.com cookies from Chrome via CDP
  jlc-ecad-mcp --help              Show this help
  jlc-ecad-mcp --version           Show the version

Login options:
  --timeout <seconds>         Chrome login wait timeout (default: 300)
  --profile-dir <dir>         Reuse an existing Chrome profile
  --port <port>               Chrome DevTools port (default: random free port)
  --chrome <path>             Chrome executable
  --login-url <url>           Editor page URL
  --cookie <cookie>           Validate and save a Cookie header without Chrome

CDP cookie options:
  --host <host>               Chrome DevTools host (default: 127.0.0.1)
  --port <port>               Chrome DevTools port (default: ${DEFAULT_CDP_PORT})
  --domain <domain>           Cookie domain (default: passport.jlc.com)
  --output <path>             Output file (default: ${getPassportCookiesFilePath()})

Environment:
  JLC_ECAD_HOME                Config directory override
  JLC_ECAD_COOKIE             Full Cookie header (takes precedence)
  JLC_ECAD_SESSION_FILE       Session file path (default: ${getSessionFilePath()})
  JLC_ECAD_PASSPORT_COOKIES_FILE  Passport cookie snapshot path
  JLC_ECAD_EDITOR_COOKIES_FILE    Editor cookie snapshot path
  JLC_ECAD_BASE_URL           JLC EDA base URL
  JLC_ECAD_CAS_URL            CAS login center (default: https://passport.jlc.com)
  JLC_ECAD_APP_ID             CAS app id (default: jlc_fa_ecad)
  JLC_ECAD_TIMEOUT_MS         HTTP request timeout
  JLC_ECAD_LOGIN_TIMEOUT_MS   CDP login timeout
  JLC_ECAD_DEBUG              Set to 1 for debug logs on stderr`;

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'login') {
    process.exitCode = await runLoginCommand(process.argv.slice(3));
    return;
  }

  if (command === 'logout') {
    process.exitCode = await runLogoutCommand(process.argv.slice(3));
    return;
  }

  if (command === 'cdp-cookies') {
    process.exitCode = await runCdpCookiesCommand(process.argv.slice(3));
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command === '--version' || command === '-V' || command === 'version') {
    process.stdout.write(`${getPackageVersion()}\n`);
    return;
  }

  const server = createServer(getPackageVersion());
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo(`Received ${signal}, shutting down.`);
    void server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(transport);
  logDebug('MCP server connected over stdio.');
}

main().catch((error: unknown) => {
  logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
