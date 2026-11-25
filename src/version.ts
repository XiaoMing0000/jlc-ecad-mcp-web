import { readFileSync } from 'node:fs';

/** Read the package version from the package.json next to dist/ or src/. */
export function getPackageVersion(): string {
  try {
    const packageJson = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
