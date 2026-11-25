import { existsSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { getConfigDir, getEditorCookiesFilePath, getPassportCookiesFilePath, getSessionFilePath } from '../config.js';
import { getLegacyCookiePaths, getLegacySessionPaths } from '../paths.js';

export const LOGOUT_USAGE = `Usage: jlc-ecad-mcp logout

Remove the locally stored JLC EDA session and cookie snapshots.

This removes:
  - <config-dir>/session.json
  - <config-dir>/passport-cookies.json
  - <config-dir>/editor-cookies.json
  - legacy credential files from old locations

It does not log out the browser or invalidate the session on the JLC server.`;

export async function runLogoutCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${LOGOUT_USAGE}\n`);
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown logout option: ${argv[0]}\n\n${LOGOUT_USAGE}\n`);
    return 2;
  }

  const targets = new Set<string>();
  const sessionPath = getSessionFilePath();
  const passportPath = getPassportCookiesFilePath();
  const editorPath = getEditorCookiesFilePath();

  targets.add(sessionPath);
  targets.add(passportPath);
  targets.add(editorPath);
  for (const path of getLegacySessionPaths()) {
    targets.add(path);
  }

  const cookieNames = new Set<string>(['passport-cookies.json', 'editor-cookies.json', basename(passportPath), basename(editorPath)]);
  for (const name of cookieNames) {
    for (const path of getLegacyCookiePaths(name)) {
      targets.add(path);
    }
  }

  const removed: string[] = [];
  const failed: string[] = [];

  for (const path of targets) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      await rm(path, { force: true });
      removed.push(path);
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Remove the config directory only when it is empty.
  try {
    await rmdir(getConfigDir());
  } catch {
    // Directory is not empty or inaccessible; leave it.
  }

  if (removed.length > 0) {
    process.stdout.write('Removed local JLC EDA credentials:\n');
    for (const path of removed) {
      process.stdout.write(`  ${path}\n`);
    }
  } else {
    process.stdout.write('No local JLC EDA session or cookie files were found.\n');
  }

  if (failed.length > 0) {
    process.stderr.write('Failed to remove:\n');
    for (const item of failed) {
      process.stderr.write(`  ${item}\n`);
    }
    return 1;
  }

  if (process.env.JLC_ECAD_COOKIE?.trim()) {
    process.stderr.write('Warning: JLC_ECAD_COOKIE is still set in the environment; unset it to fully log out.\n');
  }

  process.stdout.write('Local logout complete. The browser and server-side session are unchanged.\n');
  return 0;
}
