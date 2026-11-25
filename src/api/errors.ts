import { getSessionFilePath } from '../config.js';

export interface ApiErrorOptions {
  httpStatus?: number;
  code?: number | string;
  body?: unknown;
  cause?: unknown;
}

export class JlcEcadApiError extends Error {
  readonly httpStatus: number | undefined;
  readonly code: number | string | undefined;
  readonly body: unknown;

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JlcEcadApiError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.body = options.body;
  }
}

export class AuthRequiredError extends JlcEcadApiError {
  constructor(options: ApiErrorOptions = {}) {
    super(buildAuthRequiredMessage(options.httpStatus, options.code), options);
    this.name = 'AuthRequiredError';
  }
}

/** Guidance shown to the user (through the MCP client) when no valid session exists. */
export function buildAuthRequiredMessage(httpStatus?: number, code?: number | string): string {
  // The editor backend commonly returns HTTP 200 with {"success":false,"code":401},
  // so only mention the HTTP status when that is what actually failed.
  let status = '';
  if (httpStatus !== undefined) {
    status = httpStatus === 401 ? ' (HTTP 401)' : httpStatus === 200 ? ' (API code 401)' : ` (HTTP ${httpStatus})`;
  } else if (code !== undefined) {
    status = ` (API code ${String(code)})`;
  }
  const sessionFile = getSessionFilePath();

  return [
    `Not logged in to JLC EDA${status}.`,
    '',
    'Ask the user whether they want to sign in. Do not start login automatically.',
    'If yes, run the CLI login in a terminal:',
    '  npx -y jlc-ecad-mcp login',
    '  (from this repository: node dist/index.js login)',
    'After it completes, call jlc_ecad_get_user again.',
    '',
    'If the client cannot run shell commands, call jlc_ecad_login with {"confirm": true} instead.',
    '',
    'Manual alternatives:',
    '  - JLC_ECAD_COOKIE="VEN-SESSION=...; ..."',
    `  - ${sessionFile} with {"cookie":"VEN-SESSION=...; ..."}`,
    '',
    'The cookie is read on every request, so no restart is needed after updating it.',
  ].join('\n');
}
