import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { logDebug } from './logger.js';

/** Legacy session paths used before the current config directory. */
export function getLegacySessionPaths(): string[] {
  return [join(homedir(), '.jlc-ecad-mcp', 'session.json'), join(homedir(), 'Documents', 'JLC-ECAD', 'jlc-ecad-web-mcp', 'session.json')];
}

/** Legacy cookie snapshot candidates: old project dir, old home dir, previous config dir. */
export function getLegacyCookiePaths(fileName: string): string[] {
  return [
    join(process.cwd(), '.jlc-ecad-mcp', fileName),
    join(homedir(), '.jlc-ecad-mcp', fileName),
    join(homedir(), 'Documents', 'JLC-ECAD', 'jlc-ecad-web-mcp', fileName),
  ];
}

/**
 * Copy the first existing legacy file to targetPath when targetPath is missing.
 * Existing credentials are never deleted by this migration.
 */
export function migrateLegacyFile(targetPath: string, legacyPaths: string[]): void {
  if (existsSync(targetPath)) {
    return;
  }

  for (const legacyPath of legacyPaths) {
    if (resolve(legacyPath) === resolve(targetPath) || !existsSync(legacyPath)) {
      continue;
    }

    try {
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      copyFileSync(legacyPath, targetPath);
      if (process.platform !== 'win32') {
        chmodSync(targetPath, 0o600);
      }
      logDebug(`Migrated legacy file ${legacyPath} -> ${targetPath}`);
      return;
    } catch (error) {
      logDebug(`Could not migrate ${legacyPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
