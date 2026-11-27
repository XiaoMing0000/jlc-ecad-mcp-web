# jlc-ecad-mcp

English | [简体中文](./README.md)

[![CI](https://github.com/XiaoMing0000/jlc-ecad-mcp-web/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoMing0000/jlc-ecad-mcp-web/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jlc-ecad-mcp.svg)](https://www.npmjs.com/package/jlc-ecad-mcp)

An MCP server (stdio) for the [JLC EDA](https://www.jlc-ecad.com/editor) editor backend API.

> Current version `1.0.0`: 141 tools (hand-written plus the imported desktop catalog); see [Tools](#tools).

## Features

- stdio MCP server compatible with Claude Desktop, Claude Code, Cursor, and other MCP clients.
- Calls `https://www.jlc-ecad.com/api/editor/*` directly, without browser automation.
- **CDP login**: opens the JLC editor page, watches `/api/editor/user`, and saves both `passport.jlc.com` and `www.jlc-ecad.com` cookies.
- Reads login cookies from an environment variable or a local `session.json` and sends them with every request.
- Returns actionable login instructions when the session is missing or expired instead of crashing.
- Request timeouts, gzip decoding, JSON parsing, and business error-code handling.

## Requirements

- Node.js >= 22.18.0

## Quick Start

### 1. Configure your MCP client

**Claude Code:**

```bash
claude mcp add jlc-ecad -- npx -y jlc-ecad-mcp
```

**Claude Desktop / Cursor (`mcpServers` config):**

```json
{
  "mcpServers": {
    "jlc-ecad": {
      "command": "npx",
      "args": ["-y", "jlc-ecad-mcp"]
    }
  }
}
```

### 2. Sign in

**Option A: CLI login (recommended)**

```bash
npx -y jlc-ecad-mcp login
```

Flow:

1. Call `GET /api/editor/user` with the current session; if it succeeds, finish.
2. Otherwise call `GET /api/editor/user` with `<config-dir>/editor-cookies.json`; if it succeeds, save the session and finish.
3. Otherwise use `<config-dir>/passport-cookies.json`:
   - `POST https://passport.jlc.com/api/cas/sso/check-login` with `{"appId":"jlc_fa_ecad"}`
   - If a code such as `AC-xxxx` is returned, call `GET https://www.jlc-ecad.com/api/editor/login?code=...`
   - Save the response cookies to `<config-dir>/editor-cookies.json` and `<config-dir>/session.json`
   - Validate with `/api/editor/user`; finish if it passes
4. If everything above fails, launch Chrome via CDP at <https://www.jlc-ecad.com/editor> and let the user sign in.
   Watch `https://www.jlc-ecad.com/api/editor/user`; after a signed-in response, save to `<config-dir>`:
   - `passport.jlc.com` cookies → `passport-cookies.json`
   - `www.jlc-ecad.com` cookies → `editor-cookies.json`
   - `www.jlc-ecad.com` session → `session.json`
     then close Chrome.

Options:

```bash
npx -y jlc-ecad-mcp login --timeout 600          # Chrome login wait timeout in seconds (default: 300)
npx -y jlc-ecad-mcp login --profile-dir /tmp/jlc-cdp  # reuse a Chrome profile
npx -y jlc-ecad-mcp login --chrome /path/to/chrome    # Chrome executable
npx -y jlc-ecad-mcp login --login-url "https://www.jlc-ecad.com/editor"
npx -y jlc-ecad-mcp login --cookie "VEN-SESSION=...; VEN-CSRF=..."  # manual Cookie
```

> `--cookie` exposes the cookie in shell history; prefer `JLC_ECAD_COOKIE` or the session file for regular use.
> Chrome 136+ may require a non-default `--user-data-dir` for remote debugging; `login` uses a temporary profile by default and `--profile-dir` can reuse an existing one.

**Option B: call the `jlc_ecad_login` tool when the CLI is unavailable**

If the client can run shell commands, prefer Option A. If not, use this tool. It requires explicit user confirmation: a call without `confirm` only returns a confirmation prompt and does not start login. After the user agrees, call it with `{"confirm": true}`. It tries the current session, saved editor cookies, and saved passport cookies + `check-login`; only if all fail does it open the editor page via CDP. After signing in, call `jlc_ecad_get_user`.

**Option C: provide the cookie manually**

1. Open <https://www.jlc-ecad.com/editor> in a browser and sign in.
2. Press `F12` and copy the `Cookie` request header from **Application → Cookies** or **Network**.
3. Set `JLC_ECAD_COOKIE`, or save the cookie to the session file:

```bash
# Linux / macOS
mkdir -p ~/Documents/JLC-ECAD/jlc-ecad-mcp-web
chmod 700 ~/Documents/JLC-ECAD/jlc-ecad-mcp-web
cat > ~/Documents/JLC-ECAD/jlc-ecad-mcp-web/session.json <<'EOF'
{"version":1,"cookie":"VEN-SESSION=...; VEN-CSRF=...; ..."}
EOF
chmod 600 ~/Documents/JLC-ECAD/jlc-ecad-mcp-web/session.json

# Windows: %USERPROFILE%\Documents\JLC-ECAD\jlc-ecad-mcp-web\session.json
```

The cookie is an account credential. Do not commit it to Git or share it.

### Optional: read passport cookies from an existing Chrome (CDP)

`login` launches Chrome only when all local credentials fail. If you already have a Chrome instance with remote debugging, `cdp-cookies` can read the snapshot separately:

```bash
google-chrome --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir=/tmp/jlc-cdp https://www.jlc-ecad.com/editor

node dist/index.js cdp-cookies --port 9222
```

The default output is `~/Documents/JLC-ECAD/jlc-ecad-mcp-web/passport-cookies.json` (`0600`). Override with `--domain`, `--host`, `--port`, or `--output`.

### 3. Use it

Ask the model to call `jlc_ecad_get_user`.

### Sign out

```bash
npx -y jlc-ecad-mcp logout
```

This removes the following files from the current config directory and legacy locations:

```text
session.json
passport-cookies.json
editor-cookies.json
```

`logout` only clears local credentials; it does not sign out the browser or invalidate the JLC server-side session. To fully sign out, also log out of the JLC site in your browser. If `JLC_ECAD_COOKIE` is set, unset it as well.

## Tools

The server registers **141** tools: 42 hand-written tools (login/user, five user settings operations, two EDA searches, six web-only parts operations, four product catalog operations, three rights operations, two beta operations, four category operations, one macro data upload, and twelve team management operations) and **99** ECAD tools imported from the JLC ECAD desktop app (`resources/app/server.js`). `client_*` tools are implemented by the desktop app's local server and are not registered; `config_index`, `system_attribute_get_preference`, `system_attribute_get_proxy_url`, `eplan_macro_read`, and `form_copy_form` are also not registered because they only work against the local server or are rejected by the public API.

| Tool                                   | Description                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jlc_ecad_login`                       | Fallback when the CLI cannot run; requires user confirmation and `{"confirm": true}`                                                                                                              |
| `jlc_ecad_logout`                      | Calls `GET /api/editor/logout` to end the server session (local cookie files are kept)                                                                                                            |
| `jlc_ecad_get_user`                    | Calls `GET /api/editor/user` and returns the raw user JSON response                                                                                                                               |
| `jlc_ecad_accept_user_agreement`       | Calls `POST /api/editor/user/agreement` to accept the privacy agreement                                                                                                                           |
| `jlc_ecad_get_user_logs`               | Calls `GET /api/editor/user/logs` to read user operation logs                                                                                                                                     |
| `jlc_ecad_search_users`                | Calls `GET /api/editor/user/search` to search users by `q` and `limit`                                                                                                                            |
| `jlc_ecad_update_user`                 | Calls `POST /api/editor/user/update` to update the nickname and avatar                                                                                                                            |
| `jlc_ecad_get_user_by_uuid`            | Calls `GET /api/editor/user/:uuid` to read a specific user profile                                                                                                                                |
| `jlc_ecad_search_components`           | Calls `POST /api/editor/eda/components/searchByIds` to look up components by UUID                                                                                                                 |
| `jlc_ecad_search_devices`              | Calls `POST /api/editor/eda/devices/searchByIds` to look up devices by UUID                                                                                                                       |
| `jlc_ecad_order_part_bom`              | Calls `POST /api/editor/parts/orderBom` to place a BOM order; needs `{"__confirm": true}`                                                                                                         |
| `jlc_ecad_add_part_production`         | Calls `POST /api/editor/parts/production` to add production tabs                                                                                                                                  |
| `jlc_ecad_update_part_production`      | Calls `POST /api/editor/parts/production` to update production tabs                                                                                                                               |
| `jlc_ecad_delete_part_production`      | Calls `DELETE /api/editor/parts/production` to delete production tabs; needs `{"__confirm": true}`                                                                                                |
| `jlc_ecad_get_part_production`         | Calls `GET /api/editor/parts/production` to read production tabs                                                                                                                                  |
| `jlc_ecad_search_public_parts`         | Calls `GET /api/editor/parts/searchPublic` to search the public part catalog                                                                                                                      |
| `jlc_ecad_get_product_filters`         | Calls `GET /api/editor/product/filter` to read product filter options                                                                                                                             |
| `jlc_ecad_list_products`               | Calls `GET /api/editor/product/list` to list products                                                                                                                                             |
| `jlc_ecad_list_products_post`          | Calls `POST /api/editor/product/list` to list products with a JSON body                                                                                                                           |
| `jlc_ecad_get_product_tree`            | Calls `GET /api/editor/product/tree` to read the product category tree                                                                                                                            |
| `jlc_ecad_get_official_account_qrcode` | Calls `GET /api/editor/erp/ecad/qrcode` and returns the QR code image when served as one                                                                                                          |
| `jlc_ecad_get_designer_rights`         | Calls `GET /api/editor/erp/ecad/member/rights/designer` to read designer rights                                                                                                                   |
| `jlc_ecad_get_member_rights`           | Calls `GET /api/editor/erp/ecad/member/rights` to read the currently claimed rights                                                                                                               |
| `jlc_ecad_get_beta_status`             | Calls `GET /api/editor/beta/version` for beta info and the whitelist check                                                                                                                        |
| `jlc_ecad_join_beta_whitelist`         | Calls `POST /api/editor/beta/whitelist` to add the current user to the beta whitelist                                                                                                             |
| `jlc_ecad_create_category`             | Calls `POST /api/editor/categories` to create a category                                                                                                                                          |
| `jlc_ecad_list_categories`             | Calls `GET /api/editor/categories` to read categories (the `type` values are sent as the `type[]` query key)                                                                                      |
| `jlc_ecad_update_category`             | Calls `POST /api/editor/categories/:uuid` to update a category                                                                                                                                    |
| `jlc_ecad_delete_category`             | Calls `POST /api/editor/categories/:uuid/delete` to delete a category; needs `{"__confirm": true}`                                                                                                |
| `jlc_ecad_upload_macro_data`           | Calls `PUT /api/editor/macro/:uuid/:macroDataUuid` to upload raw macro bytes with `Content-Type: stream`; when `macroDataUuid` is omitted it is resolved from the macro detail `variables[].uuid` |
| `jlc_ecad_add_team_member`             | Calls `POST /api/editor/teams/:uuid/members/add` to add a team member                                                                                                                             |
| `jlc_ecad_create_team`                 | Calls `POST /api/editor/teams/create` to create a team                                                                                                                                            |
| `jlc_ecad_delete_team`                 | Calls `POST /api/editor/teams/:uuid/delete` to delete a team; needs `{"__confirm": true}`                                                                                                         |
| `jlc_ecad_list_teams`                  | Calls `GET /api/editor/teams` to list teams                                                                                                                                                       |
| `jlc_ecad_get_team_logs`               | Calls `GET /api/editor/teams/:uuid/logs` to read team operation logs                                                                                                                              |
| `jlc_ecad_get_other_teams`             | Calls `GET /api/editor/teams/otherTeams` to read related teams                                                                                                                                    |
| `jlc_ecad_remove_team_member`          | Calls `POST /api/editor/teams/:uuid/members/remove` to remove a member; needs `{"__confirm": true}`                                                                                               |
| `jlc_ecad_get_team_info`               | Calls `POST /api/editor/teams/:uuid/teamInfo` to read team details                                                                                                                                |
| `jlc_ecad_transfer_team`               | Calls `POST /api/editor/teams/:uuid/transfer` to transfer a team; needs `{"__confirm": true}`                                                                                                     |
| `jlc_ecad_update_team`                 | Calls `POST /api/editor/teams/:uuid/update` to update team information                                                                                                                            |
| `jlc_ecad_update_team_member_role`     | Calls `POST /api/editor/teams/:uuid/members/:memberUuid/update` to update a member role                                                                                                           |
| `jlc_ecad_update_team_member_remark`   | Calls `POST /api/editor/teams/:uuid/updateRemark` to update a member remark                                                                                                                       |

### Imported ECAD tools

The imported tools keep the desktop app's names and argument constraints; tool and property descriptions are translated to English by the generator, using owner/UUID wording without local file or directory details. Each `inputSchema` is emitted directly as Zod (`z.looseObject`, `z.string`, `z.array`, ...), split by domain under `src/tools/`. `tools/list` re-renders JSON Schema from Zod, dropping annotation keywords such as `format`:

| Domain          | Tools  | File             |
| --------------- | ------ | ---------------- |
| System          | 1      | `system.ts`      |
| Misc            | 1      | `misc.ts`        |
| Forms           | 10     | `forms.ts`       |
| Layers          | 6      | `layers.ts`      |
| Libraries       | 5      | `libraries.ts`   |
| Macros          | 8      | `macros.ts`      |
| Parts           | 24     | `parts.ts`       |
| Plot frames     | 9      | `plot-frames.ts` |
| Projects        | 16     | `projects.ts`    |
| Symbols         | 9      | `symbols.ts`     |
| Teams           | 2      | `teams.ts`       |
| User preference | 8      | `user-tools.ts`  |
| **Total**       | **99** |                  |

Usage notes:

- **Destructive tools** (52) require `{"__confirm": true}` after the user confirms; without it no request is sent.
- `GET` tools send arguments in the query string, with arrays serialized as `key[]=...` to match the editor frontend. `POST`/`PUT`/`PATCH`/`DELETE` default to a JSON body.
- Path parameters such as `:uuid` and `:projectUuid` are URL-encoded automatically.
- When a tool's schema has an optional `ownerUuid`/`owner_uuid`, the current user's UUID is filled in automatically.
- Tools that only work against the desktop app's local server (`config_index`, `system_attribute_get_preference`, `system_attribute_get_proxy_url`, `eplan_macro_read`) and `form_copy_form` (rejected by the public API) are excluded from the catalog. Adjust `excludedTools` in `scripts/import-ecad-catalog.mjs` and regenerate to change this.
- Desktop schemas may differ slightly from the online API; API errors include the raw response body to make differences easy to diagnose.
- For binary request bodies, pass `__rawBodyBase64` (base64 string) and optionally `__contentType`; this is used by chunked-upload endpoints.
- Regenerate the catalog after a desktop-app update: `pnpm run import:ecad /path/to/resources/app/server.js`, then `pnpm run fmt`.

## Configuration

| Environment variable             | Required | Default                                 | Description                                                  |
| -------------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------ |
| `JLC_ECAD_HOME`                  | No       | `~/Documents/JLC-ECAD/jlc-ecad-mcp-web` | Override the whole config directory                          |
| `JLC_ECAD_COOKIE`                | No       | -                                       | Full cookie string, highest priority                         |
| `JLC_ECAD_SESSION_FILE`          | No       | `<config-dir>/session.json`             | Session file path                                            |
| `JLC_ECAD_BASE_URL`              | No       | `https://www.jlc-ecad.com`              | API base URL; can also target the desktop app's local server |
| `JLC_ECAD_CAS_URL`               | No       | `https://passport.jlc.com`              | CAS check-login URL                                          |
| `JLC_ECAD_APP_ID`                | No       | `jlc_fa_ecad`                           | CAS application id                                           |
| `JLC_ECAD_TIMEOUT_MS`            | No       | `15000`                                 | Per-request timeout in milliseconds                          |
| `JLC_ECAD_LOGIN_TIMEOUT_MS`      | No       | `300000`                                | CDP login timeout in milliseconds                            |
| `JLC_ECAD_PASSPORT_COOKIES_FILE` | No       | `<config-dir>/passport-cookies.json`    | Passport cookie snapshot path                                |
| `JLC_ECAD_EDITOR_COOKIES_FILE`   | No       | `<config-dir>/editor-cookies.json`      | Editor cookie snapshot path                                  |
| `JLC_ECAD_DEBUG`                 | No       | -                                       | Set to `1` to log debug output to stderr                     |

### Configuration directory

The default user-level directory is shared by all clients (Claude Code, Codex, OpenCode, Hermes, etc.):

```text
Linux / macOS: ~/Documents/JLC-ECAD/jlc-ecad-mcp-web/
Windows:       %USERPROFILE%\Documents\JLC-ECAD\jlc-ecad-mcp-web\
```

It contains:

```text
session.json
passport-cookies.json
editor-cookies.json
```

Directory permissions are `0700` and file permissions are `0600`. Override the whole directory with `JLC_ECAD_HOME`, or override individual files with the per-file environment variables. Legacy credentials under `~/.jlc-ecad-mcp/`, a project-local `.jlc-ecad-mcp/`, or the previous `~/Documents/JLC-ECAD/jlc-ecad-web-mcp/` directory are copied into the new directory on first read; the old files are not deleted.

### Session file format

```json
{ "version": 1, "cookie": "VEN-SESSION=...; VEN-CSRF=...; ..." }
```

Per-cookie storage is also supported:

```json
{ "version": 1, "cookies": { "VEN-SESSION": "...", "VEN-CSRF": "..." } }
```

The file is read on every request, so no restart is needed after updating it. `chmod 600` is recommended.

## Development

```bash
pnpm install
pnpm run hooks        # install simple-git-hooks (once after cloning)
pnpm run build        # bundle to dist/index.js
pnpm run smoke        # build + end-to-end test (includes the login flow)
pnpm run dev:unwatch  # run directly over stdio with tsx
pnpm run lint:check   # oxlint + tsc
pnpm run fmt          # format
```

To run a local build, point the client at `node` and `dist/index.js`:

```json
{
  "mcpServers": {
    "jlc-ecad": {
      "command": "node",
      "args": ["/absolute/path/to/jlc-ecad-mcp/dist/index.js"]
    }
  }
}
```

Local login:

```bash
node dist/index.js login
```

## CI and release

CI runs on pushes to `main` and on pull requests (Node 22 / 24): `fmt:check`, `lint:check`, `smoke`, and `npm pack --dry-run` to verify the published contents. See [.github/workflows/ci.yml](.github/workflows/ci.yml).

Releases are triggered by `v*` tags ([.github/workflows/release.yml](.github/workflows/release.yml)): the workflow checks that the tag matches `package.json` `version`, runs the same checks, publishes with `pnpm publish --access public --provenance`, and creates a GitHub Release.

```bash
pnpm version patch --no-git-tag-version   # or minor / major
git add package.json
git commit -m "chore(release): 1.0.1"
git tag v1.0.1
git push origin main --tags
```

Configure an `NPM_TOKEN` repository secret with permission to publish `jlc-ecad-mcp` (npm automation or granular token). The GitHub Release uses the default `GITHUB_TOKEN`; no extra secret is needed. Publishing uses npm provenance, so the source information appears on the npm package page.

## Login flow

```text
CLI / MCP tool
  → 1. current session → GET /api/editor/user
       success: done
  → 2. <config-dir>/editor-cookies.json → GET /api/editor/user
       success: save session, done
  → 3. <config-dir>/passport-cookies.json
       → POST /api/cas/sso/check-login {appId: jlc_fa_ecad}
       → code returned: GET /api/editor/login?code=...
       → save editor-cookies.json + session.json
       → validate GET /api/editor/user; success: done
  → 4. all failed: launch Chrome via CDP → open /editor → user signs in
       → watch /api/editor/user
       → save passport-cookies.json + editor-cookies.json + session.json
       → close Chrome
```

## Security

- Login uses the Chrome DevTools Protocol; the debugging port is only used for a local temporary profile.
- Remote debugging exposes browser control, so the Chrome instance is closed after login.
- This tool only accesses JLC EDA endpoints on behalf of the user and does not bypass authentication.
- Session cookies and both domain cookie snapshots stay on the local machine (`0600`) and are never logged or published with the npm package.
- Endpoint paths come from the editor frontend bundle and may change when JLC EDA updates. Please open an issue if something breaks.

## License

[MIT](./LICENSE)

## Author

[xiaoming0000](https://github.com/XiaoMing0000)
