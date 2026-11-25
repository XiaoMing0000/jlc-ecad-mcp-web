const PREFIX = '[jlc-ecad-mcp]';

/**
 * MCP uses stdout for protocol traffic, so every log line must go to stderr.
 * Keeping logging behind this module makes that invariant easy to audit.
 */
export function logInfo(message: string): void {
  process.stderr.write(`${PREFIX} ${message}\n`);
}

export function logError(message: string): void {
  process.stderr.write(`${PREFIX} error: ${message}\n`);
}

export function logDebug(message: string): void {
  if (process.env.JLC_ECAD_DEBUG === '1') {
    process.stderr.write(`${PREFIX} debug: ${message}\n`);
  }
}
