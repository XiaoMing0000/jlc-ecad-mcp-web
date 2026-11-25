# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`jlc-ecad-mcp` is a stdio MCP server **and** CLI that wraps the JLC EDA editor backend (`https://www.jlc-ecad.com/api/editor/*`). It is packaged for npm as `jlc-ecad-mcp` (currently `0.3.0`; publishing is an explicit manual step) and is designed to have **zero runtime dependencies**: `@modelcontextprotocol/sdk` and its transitive dependencies are devDependencies bundled by esbuild into the single `dist/index.js` artifact.

Hard constraints:

- Node.js >= 22.13.0 (the code relies on global `fetch`, `WebSocket`, `AbortSignal.timeout`).
- When running as an MCP server, **stdout is reserved for JSON-RPC**. All logging must go through `src/logger.ts` (stderr); never use `console.log` in `src/`.
- The JLC API has no public documentation. Endpoint paths and response shapes were discovered from the editor frontend bundle (`ecad.js`); pass raw JSON through and avoid tight coupling to fields.
- Authentication is **cookie-only**; the editor does not send an `Authorization` header.
- Do not commit, print, or log cookie values or session tokens.

## Commands

```bash
pnpm install
pnpm run hooks          # install simple-git-hooks (once after cloning)
pnpm run build          # esbuild -> minified single-file ESM dist/index.js
pnpm run lint:check     # oxlint + tsc --noEmit (the standard check)
pnpm run fmt            # oxfmt; use pnpm run fmt:check for CI
pnpm run smoke          # build + full end-to-end test (mock API, MCP stdio, login flows)
pnpm run dev            # esbuild watch, rebuilds and restarts dist/index.js
pnpm run dev:unwatch    # run src/index.ts directly via tsx
```

Run the CLI after building:

```bash
node dist/index.js                     # MCP server over stdio
node dist/index.js login               # login: current session -> editor cookies -> passport cookies -> CDP
node dist/index.js logout              # remove local session and cookie files
node dist/index.js cdp-cookies         # read passport.jlc.com cookies from a debuggable Chrome
node dist/index.js --help
```

Packaging:

```bash
npm pack --dry-run
npm publish --access public            # only when the user explicitly asks to publish
```

`pnpm run dev` runs the esbuild watcher and spawns `dist/index.js` as a child. To attach an MCP client while debugging, prefer `pnpm run dev:unwatch` or run `node dist/index.js`; do not point the client at the watcher process.

## Tests

There is no unit-test framework. `scripts/smoke-test.mjs` is the only automated test:

- `pnpm run smoke` builds first, then runs the script.
- It starts a local mock HTTP server and spawns `dist/index.js` as an MCP child, driving JSON-RPC over stdio.
- Ten top-level scenarios cover: logged-out 401 guidance, `JLC_ECAD_COOKIE`, session-file cookies, raw gzip responses, the CLI current-session login, the MCP current-session login (confirmation gate), the editor-cookie fallback, the passport-cookie + check-login fallback, `JLC_ECAD_HOME` path resolution, and `logout` cleanup.
- There is no per-test filter/runner. To iterate on one scenario, run `pnpm run build` then `node scripts/smoke-test.mjs`, or temporarily comment out other scenario blocks.
- The smoke test points `JLC_ECAD_BASE_URL` at the local mock; it never calls the real JLC services.

## Architecture

### Entry points and MCP layer

- `src/index.ts` is both the MCP server entry and the CLI dispatcher. No subcommand → create `McpServer` and connect `StdioServerTransport`. Subcommands: `login`, `cdp-cookies`, `--help`, `--version`.
- `src/server.ts` registers two tools:
  - `jlc_ecad_get_user` (`src/tools/user.ts`) → `src/api/user.ts` → `src/api/client.ts`
  - `jlc_ecad_login` (`src/tools/auth.ts`) → `src/auth/login.ts`
- `src/tools/user.ts` returns the API's raw JSON. On errors it appends the backend `Response body` when available.

### API client and session

- `src/api/client.ts` is the only generic HTTP layer. It reloads the session **on every request**, so updating the session file needs no server restart.
- Requests send a browser-like `User-Agent`, `Referer`, `Origin`, and the cookie header.
- The backend often returns **HTTP 200 with `{"success":false,"code":401}`**; `apiGet` detects both HTTP 401 and business-code 401 and raises `AuthRequiredError` with login guidance.
- The backend may return raw gzip bytes with `content-type: application/gzip`; the client detects the gzip magic bytes and decompresses.
- `src/session.ts` loads credentials in this priority order:
  1. `JLC_ECAD_COOKIE`
  2. `JLC_ECAD_SESSION_FILE`
  3. `<config-dir>/session.json`
- Default config directory: `~/Documents/JLC-ECAD/jlc-ecad-mcp-web` (override with `JLC_ECAD_HOME`).
- `saveSession` writes atomically (temp file + rename) with mode `0600` on POSIX; the config directory is `0700`.
- Legacy `~/.jlc-ecad-mcp/*`, project-local `.jlc-ecad-mcp/*`, and the previous `~/Documents/JLC-ECAD/jlc-ecad-web-mcp/*` files are copied into the config directory on first read.

### Authentication flows

- `src/auth/login.ts`:
  - `loginWithCookie`: validate a manually supplied Cookie header via `/api/editor/user` and save the session.
  - `loginWithEditorCookies`: load `<config-dir>/editor-cookies.json`, validate it via `/api/editor/user`, and save the session when valid.
  - `loginWithPassportCookies`: load `<config-dir>/passport-cookies.json`, POST `/api/cas/sso/check-login` with `{appId}`, take `data.code`, GET `/api/editor/login?code=...`, save editor cookies + session, and validate `/api/editor/user`.
- `src/auth/cdp-login.ts`:
  - `getCurrentEditorLogin`: call `/api/editor/user` with the current session; return the user when valid.
  - `trySavedLogin`: current session → editor cookies → passport cookies + check-login.
  - `loginViaCdp`: try saved credentials; if all fail, call `watchEditorLogin` (CDP).
- `src/cdp/login-watch.ts` launches Chrome at `https://www.jlc-ecad.com/editor`, watches page targets for a successful `/api/editor/user` response, then saves:
  - `passport.jlc.com` cookies to `<config-dir>/passport-cookies.json`
  - `www.jlc-ecad.com` cookies to `<config-dir>/editor-cookies.json`
  - the editor session to `<config-dir>/session.json`
    and closes Chrome.
- The localhost loopback login was removed; `check-login` remains only as the passport-cookie fallback.
- `jlc_ecad_login` is the in-client fallback. Prefer the CLI `npx -y jlc-ecad-mcp login` (or `node dist/index.js login`) when the client can run shell commands. The tool requires `{"confirm": true}` after explicit user consent; a call without `confirm` returns only a confirmation prompt and must not open a browser. With confirmation, it calls `trySavedLogin` synchronously; if no saved credential works, it starts `loginViaCdp` in the background and returns instructions. The server stays alive while Chrome is open; the user calls `jlc_ecad_get_user` after signing in.
- The `jlc_ecad_get_user` 401 message explicitly tells the assistant to ask the user first and prefer the CLI login; the tool is only a fallback for clients without shell access.

### CDP subsystem (zero-dependency Chrome DevTools Protocol)

- `src/cdp/client.ts`: minimal CDP client over Node's native global `WebSocket`; correlates command IDs, supports `send()` and `onEvent()`.
- `src/cdp/chrome.ts`: Chrome binary discovery, free-port allocation, launching with remote debugging, target discovery, and `Browser.close`/kill fallback.
- `src/cdp/cookies.ts`: `Network.getAllCookies` (falls back to `Storage.getCookies`), filters cookies by domain/path, and writes 0600 snapshots. It exports `readAllCookiesViaCdp`, `saveCookieSnapshot`, `loadCookieSnapshot`, `selectCookiesForUrl`, and `cookieDomainMatchesHost`.
- `src/cdp/login-watch.ts`: launches Chrome with a temporary profile (or `--profile-dir`), monitors page targets for a successful `www.jlc-ecad.com/api/editor/user` response, saves passport and editor cookies (including the session file), then closes Chrome.
- `cdp-cookies` connects to an already-running Chrome started with `--remote-debugging-port`; `login` launches its own Chrome and closes it. Recent Chrome versions may require a non-default `--user-data-dir` for remote debugging; `login` creates a temp profile by default.
- Chrome is discovered via `JLC_CDP_CHROME` or common install paths; `--chrome <path>` overrides it.

### CLI modules

- `src/cli/login.ts`: saved-credential fallbacks plus CDP editor login; `--cookie` manual fallback.
- `src/cli/logout.ts`: remove current and legacy session/cookie files, optionally removing the empty config dir.
- `src/cli/cdp-cookies.ts`: connect to an existing Chrome and save cookies.
- `src/cli/options.ts`: shared `--name value` / `--name=value` parser.

### Configuration

`src/config.ts` centralizes environment handling:

- `JLC_ECAD_HOME` (default `~/Documents/JLC-ECAD/jlc-ecad-mcp-web`)
- `JLC_ECAD_BASE_URL` (default `https://www.jlc-ecad.com`)
- `JLC_ECAD_CAS_URL` (default `https://passport.jlc.com`)
- `JLC_ECAD_APP_ID` (default `jlc_fa_ecad`)
- `JLC_ECAD_COOKIE` / `JLC_ECAD_SESSION_FILE`
- `JLC_ECAD_PASSPORT_COOKIES_FILE` (default `<config-dir>/passport-cookies.json`)
- `JLC_ECAD_EDITOR_COOKIES_FILE` (default `<config-dir>/editor-cookies.json`)
- `JLC_ECAD_TIMEOUT_MS` / `JLC_ECAD_LOGIN_TIMEOUT_MS`
- `JLC_ECAD_DEBUG=1`

`JLC_ECAD_COOKIE` takes precedence over the session file; login commands warn when it is set.

### Build and packaging

- `config/esbuild.config.ts` deletes `dist/` and bundles `src/index.ts` into a minified ESM `dist/index.js` with the shebang. Dev mode adds sourcemaps, a `createRequire` banner, and a rebuild/restart plugin. The build config is TypeScript run directly by Node; Node 22.13–22.17 need `--experimental-strip-types`, while this workspace has been developed on Node 26.
- `src/version.ts` reads `../package.json` relative to `import.meta.url`; keep the `dist/index.js` ↔ `package.json` layout when changing build output.
- `dist/` and the legacy project-local `.jlc-ecad-mcp/` directory are gitignored. `package.json` `files` publishes only `dist`, READMEs, and LICENSE; `prepack` runs the build.
- `.mcp.json` runs `node dist/index.js`, so build before using the project-scoped MCP server.

## Credential files and cleanup

All under the config directory (`~/Documents/JLC-ECAD/jlc-ecad-mcp-web` by default, `JLC_ECAD_HOME` override):

- `session.json`: editor session (cookie), `0600`.
- `passport-cookies.json`: CDP-captured passport cookies, `0600`.
- `editor-cookies.json`: CDP-captured editor cookies, `0600`.
- `/tmp/jlc-cdp-login-*`: temporary Chrome profiles; deleted by `login` when it owns the profile. `--profile-dir` reuses a profile and does not delete it.
- Never read these files into logs or commits. `login` and `logout` are the supported ways to populate/clear them. When asked to clear login state, run `node dist/index.js logout` (or remove the three files and any temp Chrome profile) and suggest logging out of the JLC site to invalidate the server-side session.

## Documentation

- `README.md` (Chinese) / `README.en.md` (English): user-facing install, MCP client configuration, login options, tools, environment variables.
- `docs/PLAN.md` / `docs/PLAN.en.md`: API research, architecture decisions, milestones, risks, and npm publishing checklist. Update these when endpoints or login behavior change.
