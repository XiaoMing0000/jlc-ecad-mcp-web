# ECAD tools

Most files in this directory are generated from the JLC ECAD desktop app's MCP
catalog; do not edit the generated ones by hand. The hand-written tools are
`user.ts` (`jlc_ecad_get_user` and user settings), `auth.ts` (`jlc_ecad_login`), `eda.ts` (the
EDA component/device searches), `parts-web.ts` (web-only parts endpoints),
`product.ts` (product catalog endpoints), `rights.ts` (ERP/member endpoints),
`beta.ts` (beta program), `category.ts` (category endpoints),
`macro-upload.ts` (macro data upload), `team.ts` (team management), and the
shared helper `format.ts`.

- Source: `/opt/apps/jlc-ecad/resources/app/server.js`
- Tools: 99
- Destructive tools: 52
- Excluded domains (desktop-app local server only): client
- Excluded tools (local-server-only or rejected by the public API): config_index, system_attribute_get_preference, system_attribute_get_proxy_url, eplan_macro_read, form_copy_form

Each generated file contains one domain and exports an
`EcadToolDefinition[]` whose `inputSchema` is a Zod schema converted from the
desktop app's JSON Schema; `index.ts` aggregates them into `ECAD_TOOLS` and
`ECAD_TOOL_MAP`. Descriptions are English translations that use owner/UUID
wording instead of the desktop app's local file and directory details. The
executor in `src/ecad/executor.ts` calls the corresponding endpoint under
`JLC_ECAD_BASE_URL`.

Tools that only work against the desktop app's local server, and tools the
public API rejects, are listed under "Excluded tools" above and are not
generated.

Regenerate after a JLC ECAD update:

```bash
node scripts/import-ecad-catalog.mjs /path/to/resources/app/server.js
pnpm run fmt
```
