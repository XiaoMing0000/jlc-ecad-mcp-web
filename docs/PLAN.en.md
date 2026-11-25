# jlc-ecad-mcp Implementation Plan

English | [简体中文](./PLAN.md)

> Status: in progress (M2 implemented, pending verification with a real account)
> Last updated: 2026-11-25

## 1. Project Goals

Wrap the backend API of the [JLC EDA editor](https://www.jlc-ecad.com/editor) in an MCP (Model Context Protocol) server that communicates over **stdio**, and publish it to [npmjs.com](https://www.npmjs.com/) as `jlc-ecad-mcp`.

Users can configure the server in Claude Desktop, Claude Code, Cursor, or any other MCP-compatible client, letting the model read JLC EDA data as the currently signed-in user.

Core requirements:

1. Implement the MCP server in Node.js + TypeScript and communicate with clients over **stdio**.
2. Integrate with the `https://www.jlc-ecad.com` backend API instead of driving the browser UI.
3. When the user is not signed in, guide them through login, store the session cookie locally, and attach it to every subsequent request.
4. Publish the package to npm.

## 2. API Research Findings

### 2.1 `GET /api/editor/user`

This endpoint returns the profile of the signed-in user. It was found in the editor frontend bundle (`ecad.js`):

```js
#Be = '/api/editor/user';
getUserInfo(t = {}) {
  return nd(this.#Be, t);
}
```

Key points from the `nd()` request helper:

- It uses the browser `fetch` API and sends **no** `Authorization` header; authentication relies entirely on same-origin cookies.
- `GET` parameters are appended to the query string.
- Responses are parsed as JSON first; the server may also return a gzip content type.

Measured response when signed out:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"success":false,"code":401}
```

Note that the HTTP status is `200` while the business error code is in the body's `code` field. Clients must check both the HTTP status and `success/code`.

The server also sets these cookies:

| Cookie        | Description                                                          |
| ------------- | -------------------------------------------------------------------- |
| `VEN-SESSION` | Session ID; an anonymous session is issued even when signed out      |
| `VEN-CSRF`    | CSRF token, mainly used by write endpoints and WebSocket connections |
| `acw_tc`      | Alibaba Cloud WAF cookie, normally maintained automatically          |

Login-related research:

- Editor page config: `window.ECAD_EDITOR_ENVIRONMENT.casServerDomain = "https://passport.jlc.com"`.
- CAS appId: `jlc_fa_ecad`.
- The editor performs the CAS login itself and calls `GET /api/editor/user` afterwards.
- `check-login` / `/api/editor/login` serve as the passport-cookie fallback: `POST check-login {appId}` returns a `code` (for example `AC-xxxx`), then `GET /api/editor/login?code=...` returns the editor cookies.
- M2 login order:
  1. current session → `/api/editor/user`
  2. `editor-cookies.json` → `/api/editor/user`
  3. `passport-cookies.json` → check-login → code → `/api/editor/login` → save editor cookies + session → validate `/api/editor/user`
  4. all failed → open the editor page via CDP, watch `/api/editor/user`, save both cookie stores

### 2.2 Request Conventions

- Base URL: `https://www.jlc-ecad.com` (overridable with `JLC_ECAD_BASE_URL` for tests).
- `Cookie`: read from the local session.
- `User-Agent`: a common browser UA to avoid CDN/WAF rejection.
- `Referer` / `Origin`: `https://www.jlc-ecad.com`.
- Timeout: 15 seconds by default.
- Response bodies follow `{ success, code, result }`; status-only responses without `result` are also possible.

## 3. Architecture

```text
MCP Client (Claude Desktop / Claude Code / Cursor)
        │  JSON-RPC over stdio
        ▼
jlc-ecad-mcp (Node.js process)
        │
        ├── MCP Server (@modelcontextprotocol/sdk)
        ├── Tool layer: input validation, result formatting
        ├── API Client: cookies, timeout, error mapping
        └── Session Store: environment variables / local session.json
        │  HTTPS + Cookie
        ▼
https://www.jlc-ecad.com/api/editor/*
```

Design requirements:

- **stdout carries only MCP protocol messages**; all logs go to stderr.
- API errors become readable MCP tool errors (`isError: true`); the process must not crash.
- The session file is re-read on every request, so a future login flow can update it without restarting the server.
- Networking and business logic are separate; adding an endpoint means adding `api/*.ts` and `tools/*.ts`.

## 4. Directory Structure (target)

```text
jlc-ecad-mcp/
├── docs/
│   ├── PLAN.md                 # Chinese version
│   ├── PLAN.en.md              # This file (English)
│   └── ...
├── src/
│   ├── index.ts                # Entry: CLI dispatch, create server, connect stdio, signals
│   ├── server.ts               # MCP server assembly and tool registration
│   ├── config.ts               # Base URL, timeout, session file path, etc.
│   ├── version.ts              # Read the package.json version
│   ├── logger.ts               # stderr logging
│   ├── session.ts              # Session loading / atomic writes (0600)
│   ├── auth/
│   │   ├── login.ts            # Manual Cookie validation / saving
│   │   └── cdp-login.ts        # Check current session, start CDP login if needed
│   ├── cdp/
│   │   ├── client.ts           # Minimal CDP client (Node native WebSocket)
│   │   ├── chrome.ts           # Chrome discovery, launch, targets, close
│   │   ├── cookies.ts          # Network.getAllCookies + domain/path filter + local save
│   │   └── login-watch.ts      # Watch /api/editor/user, save both cookie stores
│   ├── cli/
│   │   ├── login.ts            # `jlc-ecad-mcp login` subcommand
│   │   └── cdp-cookies.ts      # `jlc-ecad-mcp cdp-cookies` subcommand
│   ├── api/
│   │   ├── client.ts           # fetch wrapper: cookies, timeout, error mapping
│   │   ├── errors.ts           # ApiError / AuthRequiredError
│   │   └── user.ts             # GET /api/editor/user
│   └── tools/
│       ├── auth.ts             # jlc_ecad_login tool
│       └── user.ts             # jlc_ecad_get_user tool
├── config/esbuild.config.ts    # Bundle to a single-file ESM CLI
├── package.json                # bin, files, prepack
└── README.md / README.en.md
```

## 5. Session and Login Design

### 5.1 Storage Location

Priority, highest first:

1. Environment variable `JLC_ECAD_COOKIE`: full cookie string.
2. The file named by `JLC_ECAD_SESSION_FILE`.
3. Default file: `<config-dir>/session.json`

Default config directory (shared by all clients):

```text
Linux / macOS: ~/Documents/JLC-ECAD/jlc-ecad-mcp-web/
Windows:       %USERPROFILE%\Documents\JLC-ECAD\jlc-ecad-mcp-web\
```

Override the whole directory with `JLC_ECAD_HOME`. Legacy credentials under `~/.jlc-ecad-mcp/`, project-local `.jlc-ecad-mcp/`, or the previous `~/Documents/JLC-ECAD/jlc-ecad-web-mcp/` are migrated on first read.

The passport / editor cookie snapshots are separate files:

4. The file named by `JLC_ECAD_PASSPORT_COOKIES_FILE`.
5. Default: `<config-dir>/passport-cookies.json`
6. The file named by `JLC_ECAD_EDITOR_COOKIES_FILE`.
7. Default: `<config-dir>/editor-cookies.json`

### 5.2 File Format

```json
{
  "version": 1,
  "cookie": "VEN-SESSION=...; VEN-CSRF=...; ...",
  "cookies": {
    "VEN-SESSION": "...",
    "VEN-CSRF": "..."
  },
  "updatedAt": "2026-11-25T00:00:00.000Z",
  "user": {}
}
```

- Provide either `cookie` or `cookies`; `cookie` takes precedence.
- `user` is an optional cached profile, useful for offline display.
- Permissions: write files as `0600` and the directory as `0700`.
- Never print the raw cookie in logs or error messages.

### 5.3 Behavior by Milestone

| Milestone | Behavior                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | Read the cookie from env vars or `session.json`; a request is still sent without a cookie, and a 401 returns login instructions          |
| M2 (now)  | Try current session, editor cookies, then passport cookies + check-login; only then open the editor via CDP and watch `/api/editor/user` |
| M3        | `logout` is implemented for local credentials; session expiry detection, refresh, and `whoami` remain                                    |

### 5.4 Error Guidance

When signed out, the tool returns a message like:

```text
Not logged in to JLC EDA (API code 401).

Ask the user whether they want to sign in. Do not start login automatically.
If yes, run the CLI login:
  npx -y jlc-ecad-mcp login
  (from this repository: node dist/index.js login)
After it completes, call jlc_ecad_get_user again.
If the client cannot run shell commands, call jlc_ecad_login with {"confirm": true}.

Manual alternatives:
  - JLC_ECAD_COOKIE="VEN-SESSION=...; ..."
  - <config-dir>/session.json with {"cookie":"VEN-SESSION=...; ..."}

The cookie is read on every request, so no restart is needed after updating it.
```

## 6. Milestones

### M1: Runnable skeleton + `get_user` (this iteration)

- [x] Initialize the MCP server (stdio).
- [x] Local session loading (env vars / `session.json`).
- [x] `GET /api/editor/user` client and the `jlc_ecad_get_user` tool.
- [x] Friendly errors for 401, network failures, timeouts, and non-JSON responses.
- [x] Bundle as a single-file CLI with a shebang and `bin` entry.
- [x] `pnpm run smoke`: end-to-end test against a local mock API (handshake, tool list, signed out, cookie forwarding, session file).
- [x] README and npm publishing configuration.
- Acceptance: `tools/list` shows the tool; without a cookie the tool returns login instructions; with a valid cookie it returns the user JSON.

### M2: Login Guidance and Session Persistence (multi-level fallback)

- [x] `jlc-ecad-mcp login` subcommand and `jlc_ecad_login` MCP tool.
- [x] Check the current editor session with `/api/editor/user`; return immediately when signed in.
- [x] Validate `<config-dir>/editor-cookies.json` via `/api/editor/user`; save the session when it works.
- [x] Use `<config-dir>/passport-cookies.json` with CAS `check-login`; when a code is returned, call `/api/editor/login`, save editor cookies + session, and validate `/api/editor/user`.
- [x] If all saved credentials fail, launch Chrome via CDP and open `https://www.jlc-ecad.com/editor`.
- [x] Watch for a successful `https://www.jlc-ecad.com/api/editor/user` response.
- [x] Save `passport.jlc.com` cookies to `<config-dir>/passport-cookies.json` (`0600`).
- [x] Save `www.jlc-ecad.com` cookies to `<config-dir>/editor-cookies.json` and `<config-dir>/session.json` (`0600`), then close Chrome.
- [x] `--timeout`, `--profile-dir`, `--port`, `--chrome`, and `--login-url` CDP controls.
- [x] `--cookie <cookie>` manual fallback.
- [x] `cdp-cookies`: read passport cookies from an already-debuggable Chrome.
- [x] `logout` command (M3): remove session, passport/editor cookie files from current and legacy locations.
- [ ] `whoami` helper command (M3).
- Acceptance: the mock end-to-end test passes; `login` skips Chrome when the session/editor/passport cookies are valid.
- Related env vars: `JLC_ECAD_HOME`, `JLC_ECAD_CAS_URL`, `JLC_ECAD_APP_ID`, `JLC_ECAD_LOGIN_TIMEOUT_MS`, `JLC_ECAD_PASSPORT_COOKIES_FILE`, `JLC_ECAD_EDITOR_COOKIES_FILE`.

### M3: More Endpoints and Maintenance

- [x] `logout`: remove `session.json`, `passport-cookies.json`, and `editor-cookies.json` from the current config directory and legacy locations; browser/server sessions are unchanged.
- [ ] `whoami`: print the current session's user (optional).

Add endpoints based on real use cases. Candidates:

- `/api/editor/user/preference`
- `/api/editor/teams`, `/api/editor/teams/{uuid}`
- `/api/editor/projects`, project details / history
- `/api/editor/forms` (project files)
- `/api/editor/symbols`, `/api/editor/footprints`, `/api/editor/devices`

Each endpoint gets its own tool whose description states whether login is required, what the parameters mean, and what the response looks like.

### M4: Publishing and Maintenance

- [ ] `npm publish --access public` (package name `jlc-ecad-mcp`).
- [ ] Set up GitHub Actions: build + test + publish on tags (using `NPM_TOKEN`).
- [ ] Add configuration examples for common MCP clients to the README.
- [ ] Follow SemVer for versions and Conventional Commits for messages (the repo already enforces this with hooks).

## 7. npm Publishing Checklist

```bash
pnpm install
pnpm run lint:check
pnpm run smoke             # build + mock end-to-end test
pnpm pack --dry-run        # inspect package contents (runs prepack build)
npm publish --access public
```

Key `package.json` fields:

- `name`: `jlc-ecad-mcp` (confirmed available on npm)
- `bin`: `{ "jlc-ecad-mcp": "dist/index.js" }`
- `files`: publish only `dist`, README, and LICENSE
- `engines.node`: `>=22.18.0` (matches the build environment)
- `prepack`: force a build before packing / publishing

## 8. Security and Compliance

- Access JLC EDA endpoints only after the user explicitly configures a cookie; no built-in account.
- The session file is a sensitive credential: `0600` permissions, never printed or logged, never published with the package.
- `.gitignore` must exclude `.env`, local session files, and test cookies.
- Do not bypass website authentication or fetch unauthorized data; the tool only accesses endpoints on behalf of the user.
- If JLC EDA changes its API or disallows third-party clients, stop using the affected endpoints and update the documentation.

## 9. Risks and Open Questions

1. **API stability**: `/api/editor/*` has no public documentation and fields may change; keep coupling low by passing through raw JSON plus a small stable wrapper.
2. **WAF / rate limiting**: frequent requests may trigger Alibaba Cloud WAF; limit concurrency, keep sensible timeouts, and prompt users when necessary.
3. **Cookie lifetime**: `VEN-SESSION` defaults to `Max-Age=86400`; users must sign in again after expiry, which M2 should handle.
4. **npm package name and repository URL**: `jlc-ecad-mcp` is currently available; the `repository` field should be confirmed once the GitHub repository exists.
5. **MCP client compatibility**: clients render stderr logs, timeouts, and tool errors differently; test in Claude Desktop and Claude Code.
6. **CAS redirect restrictions (confirmed in practice)**: `passport.jlc.com` rejects `127.0.0.1` callbacks ("redirect domain is not whitelisted"). The localhost loopback is not used; passport cookies are exchanged via `check-login` + `/api/editor/login`, falling back to CDP.
7. **Remote/container environments**: CDP login needs to launch Chrome on the machine hosting the MCP server/CLI; containers, remote hosts, or SSH sessions may not have a display. Use `--cookie` as a fallback.
8. **CDP browser cookie access**: requires Chrome started with `--remote-debugging-port`; Chrome 136+ may refuse remote debugging on the default profile, requiring a separate `--user-data-dir` (`login` uses a temporary profile). The debugging port grants browser control, so use it locally and only temporarily.
