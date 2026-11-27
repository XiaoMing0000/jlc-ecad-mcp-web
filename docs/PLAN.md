# jlc-ecad-mcp 实施计划

[English](./PLAN.en.md) | 简体中文

> 状态：进行中（M2 登录流程、M3 logout、M5 桌面端工具迁移已实现）
> 最后更新：2026-11-25

## 1. 项目目标

将 [JLC EDA 编辑器](https://www.jlc-ecad.com/editor) 的后端接口封装为一个基于 **stdio** 的 MCP（Model Context Protocol）服务，并以 `jlc-ecad-mcp` 为包名发布到 [npmjs.com](https://www.npmjs.com/)。

用户可以在 Claude Desktop、Claude Code、Cursor 等支持 MCP 的客户端中配置本服务，让模型以当前登录用户的身份读取 JLC EDA 的数据。

核心需求：

1. 以 Node.js + TypeScript 实现 MCP Server，通过 **stdio** 与客户端通信。
2. 对接 `https://www.jlc-ecad.com` 的后端接口，而不是驱动浏览器 UI。
3. 未登录时引导用户登录，把登录态（Cookie / Session）保存在用户本地，并在后续每次请求中自动携带。
4. 最终发布到 npm。

## 2. 接口调研结论

### 2.1 `GET /api/editor/user`

这是获取当前登录用户信息的接口，来自编辑器前端 bundle（`ecad.js`）：

```js
#Be = '/api/editor/user';
getUserInfo(t = {}) {
  return nd(this.#Be, t);
}
```

请求封装 `nd()` 的要点：

- 使用浏览器 `fetch`，**没有** `Authorization` 头，鉴权完全依赖同源 Cookie。
- `GET` 参数会拼到 query string。
- 响应优先按 JSON 解析；服务端也可能返回 gzip 内容类型。

未登录时实测响应：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"success":false,"code":401}
```

注意：HTTP 状态码是 `200`，业务错误码在 body 的 `code` 字段中，因此客户端必须同时检查 HTTP 状态和 `success/code`。

服务端同时会下发这些 Cookie：

| Cookie        | 说明                                      |
| ------------- | ----------------------------------------- |
| `VEN-SESSION` | 会话 ID，未登录时也会下发匿名会话         |
| `VEN-CSRF`    | CSRF Token，主要供写接口 / WebSocket 使用 |
| `acw_tc`      | 阿里云 WAF 风控 Cookie，通常自动维护      |

登录相关调研：

- 编辑器页面注入的配置：`window.ECAD_EDITOR_ENVIRONMENT.casServerDomain = "https://passport.jlc.com"`。
- CAS appId：`jlc_fa_ecad`。
- 编辑器自身通过 CAS 完成登录，并在登录后调用 `GET /api/editor/user`。
- `check-login` / `/api/editor/login` 作为 passport Cookie 的回退路径：`POST check-login {appId}` 返回 `code`（如 `AC-xxxx`），再 `GET /api/editor/login?code=...` 获取编辑器 Cookie。
- M2 登录顺序：
  1. 当前会话 → `/api/editor/user`
  2. `editor-cookies.json` → `/api/editor/user`
  3. `passport-cookies.json` → check-login → code → `/api/editor/login` → 保存 editor cookies + session → 验证 `/api/editor/user`
  4. 都失败 → CDP 打开编辑器页面，监听 `/api/editor/user`，保存两个域名 Cookie

### 2.2 请求约定

- Base URL：`https://www.jlc-ecad.com`（可用 `JLC_ECAD_BASE_URL` 覆盖，便于测试）。
- `Cookie`：从本地会话中读取。
- `User-Agent`：使用常见浏览器 UA，避免 CDN/WAF 直接拦截。
- `Referer` / `Origin`：`https://www.jlc-ecad.com`。
- 超时：默认 15 秒。
- 响应体统一为 `{ success, code, result }` 结构，也可能出现无 `result` 的纯状态响应。

## 3. 总体架构

```text
MCP Client (Claude Desktop / Claude Code / Cursor)
        │  JSON-RPC over stdio
        ▼
jlc-ecad-mcp (Node.js process)
        │
        ├── MCP Server (@modelcontextprotocol/sdk)
        ├── Tool 层：参数校验、结果格式化
        ├── API Client：Cookie、超时、错误映射
        └── Session Store：环境变量 / 本地 session.json
        │  HTTPS + Cookie
        ▼
https://www.jlc-ecad.com/api/editor/*
```

设计要求：

- **stdout 只输出 MCP 协议消息**，所有日志一律写 stderr。
- 接口错误转换为可读的 MCP 工具错误（`isError: true`），不让进程崩溃。
- 每次请求重新读取会话文件，这样后续登录流程写入文件后无需重启服务。
- 网络层与业务层分离，后续新增接口只需增加 `api/*.ts` 与 `tools/*.ts`。

## 4. 目录结构（目标）

```text
jlc-ecad-mcp/
├── docs/
│   ├── PLAN.md                 # 本文件（中文）
│   ├── PLAN.en.md              # 英文版本
│   └── ...
├── src/
│   ├── index.ts                # 入口：CLI 分发、创建 Server、连接 stdio、进程信号处理
│   ├── server.ts               # MCP Server 组装与工具注册
│   ├── config.ts               # Base URL、超时、会话文件路径等
│   ├── version.ts              # 读取 package.json 版本
│   ├── logger.ts               # stderr 日志
│   ├── session.ts              # 会话读取 / 原子写入（0600）
│   ├── auth/
│   │   ├── login.ts            # 手动 Cookie 校验 / 保存
│   │   └── cdp-login.ts        # 当前会话检查，必要时启动 CDP 登录
│   ├── cdp/
│   │   ├── client.ts           # 最小 CDP 客户端（Node 原生 WebSocket）
│   │   ├── chrome.ts           # Chrome 查找、启动、目标发现、关闭
│   │   ├── cookies.ts          # Network.getAllCookies + 域名/路径过滤 + 本地保存
│   │   └── login-watch.ts      # 监听 /api/editor/user，保存两个域名 Cookie
│   ├── cli/
│   │   ├── login.ts            # `jlc-ecad-mcp login` 子命令
│   │   └── cdp-cookies.ts      # `jlc-ecad-mcp cdp-cookies` 子命令
│   ├── api/
│   │   ├── client.ts           # fetch 封装：Cookie、超时、业务错误映射、二进制响应
│   │   ├── errors.ts           # ApiError / AuthRequiredError
│   │   └── user.ts             # GET /api/editor/user
│   ├── ecad/
│   │   ├── executor.ts         # 通用执行器：路径参数 / query / JSON body / __confirm
│   │   ├── metadata.ts         # EcadToolDefinition -> McpServer 注册配置
│   │   ├── owner.ts            # 当前用户 UUID 缓存（ownerUuid 默认值）
│   │   └── types.ts            # EcadToolDefinition（inputSchema 为 Zod schema）
│   └── tools/
│       ├── index.ts            # 汇总 114 个迁移工具（生成）
│       ├── client.ts 等        # 按业务域生成的工具定义（生成）
│       ├── user-tools.ts       # 用户偏好域工具（生成，避免与 user.ts 重名）
│       ├── auth.ts             # jlc_ecad_login 工具（手写）
│       └── user.ts             # jlc_ecad_get_user 工具（手写）
├── scripts/
│   └── import-ecad-catalog.mjs # 从桌面端 server.js 重新生成工具目录
├── config/esbuild.config.ts    # 打包为单文件 ESM CLI
├── package.json                # bin、files、prepack
└── README.md / README.en.md
```

## 5. 会话与登录态设计

### 5.1 存储位置

优先级从高到低：

1. 环境变量 `JLC_ECAD_COOKIE`：完整 Cookie 字符串。
2. 环境变量 `JLC_ECAD_SESSION_FILE` 指定的文件。
3. 默认文件：`<config-dir>/session.json`

默认配置目录（所有客户端共用）：

```text
Linux / macOS: ~/Documents/JLC-ECAD/jlc-ecad-mcp-web/
Windows:       %USERPROFILE%\Documents\JLC-ECAD\jlc-ecad-mcp-web\
```

可用 `JLC_ECAD_HOME` 覆盖整个目录。旧目录 `~/.jlc-ecad-mcp/`、项目内 `.jlc-ecad-mcp/`、上一版 `~/Documents/JLC-ECAD/jlc-ecad-web-mcp/` 会在首次读取时自动迁移。

passport / editor Cookie 快照是独立文件：

4. 环境变量 `JLC_ECAD_PASSPORT_COOKIES_FILE` 指定的文件。
5. 默认文件：`<config-dir>/passport-cookies.json`
6. 环境变量 `JLC_ECAD_EDITOR_COOKIES_FILE` 指定的文件。
7. 默认文件：`<config-dir>/editor-cookies.json`

### 5.2 文件格式

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

- `cookie` 与 `cookies` 二选一，`cookie` 优先。
- `user` 为可选的用户信息缓存，方便离线展示。
- 文件权限：写入时设为 `0600`；目录设为 `0700`。
- 不在日志、错误信息中输出 Cookie 原文。

### 5.3 各阶段行为

| 阶段       | 行为                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M1         | 从环境变量或 `session.json` 读取 Cookie；无 Cookie 时请求仍会发出，收到 401 后返回登录引导                                                     |
| M2（当前） | 依次尝试当前会话、editor Cookie、passport Cookie + check-login；都失败再通过 CDP 打开编辑器页面，监听 `/api/editor/user` 并保存两个域名 Cookie |
| M3         | 已实现 `logout` 清理本地凭据；待做会话过期检测、自动刷新、`whoami` 辅助命令                                                                    |

### 5.4 错误引导

未登录时工具返回类似信息：

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

## 6. 里程碑

### M1：可运行骨架 + `get_user`（本次实现）

- [x] 初始化 MCP Server（stdio）。
- [x] 本地会话读取（环境变量 / `session.json`）。
- [x] `GET /api/editor/user` 客户端与 `jlc_ecad_get_user` 工具。
- [x] 401、网络错误、超时、非 JSON 响应的友好错误。
- [x] 打包为单文件 CLI，带 shebang 与 `bin` 字段。
- [x] `pnpm run smoke`：本地 mock API 的端到端测试（握手、工具列表、未登录、Cookie 透传、会话文件）。
- [x] README、npm 发布配置。
- 验收：`tools/list` 能看到工具；未配置 Cookie 时返回登录引导；配置有效 Cookie 时返回用户 JSON。

### M2：登录引导与会话持久化（多级回退）

- [x] `jlc-ecad-mcp login` 子命令与 `jlc_ecad_login` MCP 工具。
- [x] 先用当前编辑器会话请求 `/api/editor/user`，已登录时直接返回。
- [x] 用 `<config-dir>/editor-cookies.json` 请求 `/api/editor/user`，成功后保存会话。
- [x] 用 `<config-dir>/passport-cookies.json` 调 CAS `check-login`；有 code 时调 `/api/editor/login`，保存 editor Cookie 和会话，再验证 `/api/editor/user`。
- [x] 以上都失败时通过 CDP 启动 Chrome、打开 `https://www.jlc-ecad.com/editor`。
- [x] 监听 `https://www.jlc-ecad.com/api/editor/user` 的成功响应。
- [x] 成功后保存 `passport.jlc.com` Cookie 到 `<config-dir>/passport-cookies.json`（`0600`）。
- [x] 保存 `www.jlc-ecad.com` Cookie 到 `<config-dir>/editor-cookies.json` 和 `<config-dir>/session.json`（`0600`），并关闭 Chrome。
- [x] `--timeout`、`--profile-dir`、`--port`、`--chrome`、`--login-url` 等 CDP 控制。
- [x] `--cookie <cookie>` 手动兜底路径。
- [x] `cdp-cookies`：从已开启远程调试的 Chrome 读取 passport Cookie。
- [x] `logout` 命令（M3）：删除当前和旧目录中的 session、passport/editor Cookie 文件。
- [ ] `whoami` 辅助命令（M3）。
- 验收：mock 端到端测试通过；已有有效会话/editor Cookie/passport Cookie 时 `login` 不启动 Chrome。
- 相关环境变量：`JLC_ECAD_HOME`、`JLC_ECAD_CAS_URL`、`JLC_ECAD_APP_ID`、`JLC_ECAD_LOGIN_TIMEOUT_MS`、`JLC_ECAD_PASSPORT_COOKIES_FILE`、`JLC_ECAD_EDITOR_COOKIES_FILE`。

### M3：接口扩展与维护

- [x] `logout`：删除当前配置目录和旧目录中的 `session.json`、`passport-cookies.json`、`editor-cookies.json`；不影响浏览器/服务端会话。
- [ ] `whoami`：打印当前会话对应的用户信息（可选）。

优先按使用场景补充接口，候选接口：

- `/api/editor/user/preference`
- `/api/editor/teams`、`/api/editor/teams/{uuid}`
- `/api/editor/projects`、项目详情 / 历史
- `/api/editor/forms`（工程文件）
- `/api/editor/symbols`、`/api/editor/footprints`、`/api/editor/devices`

每个接口对应一个工具，工具描述需说明是否需要登录、参数含义与返回结构。

### M4：发布与维护

- [ ] `npm publish --access public`（包名 `jlc-ecad-mcp`）。
- [ ] 配置 GitHub Actions：tag 触发构建 + 测试 + 发布（使用 `NPM_TOKEN`）。
- [ ] README 增加各客户端的配置示例。
- [ ] 版本遵循 SemVer；提交信息遵循 Conventional Commits（仓库已有钩子校验）。

### M5：迁移桌面端 MCP 工具目录

- [x] 从 JLC ECAD 桌面端 `resources/app/server.js` 提取完整工具目录（`var fx` 到 `var Bx`，共 114 个工具，覆盖原请求范围 25088–27850 及其后的用户偏好工具）；其中 10 个 `client_*` 工具只由桌面端本地服务实现，另有 5 个仅本地可用或线上不可用的工具（`config_index`、`system_attribute_get_preference`、`system_attribute_get_proxy_url`、`eplan_macro_read`、`form_copy_form`）由生成器的 `excludedTools` 排除，注册 99 个。
- [x] 按业务域拆分到 `src/tools/`：system、misc、forms、layers、libraries、macros、parts、plot-frames、projects、symbols、teams、user（`client` 域已排除）。
- [x] 保留原始名称和参数约束；工具与参数描述由生成器翻译为英文（使用归属/UUID 语义，去掉本地文件/目录细节）；生成器直接把桌面端 JSON Schema 转成 Zod 代码（`z.looseObject`/`z.string`/`z.array` 等），由 SDK `McpServer.registerTool` 注册；`tools/list` 由 Zod 重新生成 JSON Schema（`format` 等注解字段不保留）。
- [x] 新增通用执行器 `src/ecad/executor.ts`：路径参数编码、GET query（数组使用 `key[]`）、写请求 JSON body、二进制响应、`__rawBodyBase64`。
- [x] 破坏性工具（52 个）要求用户确认后以 `{"__confirm": true}` 调用；未确认不发出请求。
- [x] 可选 `ownerUuid`/`owner_uuid` 自动填入当前用户 UUID（按 Cookie 缓存），生成器把该信息写入 `ownerParams`；必填的 owner 参数不会被隐式填入。
- [x] McpServer 用 Zod 校验 `tools/call` 参数，执行器不再单独校验；zod 经 esbuild 打包，包仍保持零运行时依赖。
- [x] `scripts/import-ecad-catalog.mjs` 可从新版桌面端重新生成目录。
- [x] smoke test 覆盖工具列表（141 个）、GET query、路径参数编码、破坏性确认、EDA 检索、部件 Web 操作、产品目录、权益/公测接口、分类接口、宏数据上传、团队管理和用户设置接口。
- 说明：仅桌面端本地可用的工具（`config_index`、`system_attribute_get_preference`、`system_attribute_get_proxy_url`、`eplan_macro_read`）已由生成器排除，不再注册；桌面端 schema 与线上接口可能存在差异，错误响应会原样返回。

## 7. npm 发布清单

```bash
pnpm install
pnpm run lint:check
pnpm run smoke             # 构建 + mock 端到端测试
pnpm pack --dry-run        # 检查包内容（会自动执行 prepack 构建）
npm publish --access public
```

`package.json` 关键字段：

- `name`: `jlc-ecad-mcp`（已确认 npm 上未被占用）
- `bin`: `{ "jlc-ecad-mcp": "dist/index.js" }`
- `files`: 只发布 `dist`、README、LICENSE
- `engines.node`: `>=22.18.0`（与构建环境一致）
- `prepack`: 发布 / 打包前强制构建

## 8. 安全与合规

- 仅在用户明确配置 Cookie 后访问 JLC EDA 接口；不内置任何账号。
- 会话文件属于敏感凭据：`0600` 权限、不打印、不写入日志、不随包发布。
- `.gitignore` 需排除 `.env`、本地会话文件与测试 Cookie。
- 不绕过网站鉴权、不抓取未授权数据；本工具只代表用户本人访问其有权访问的接口。
- 若 JLC EDA 调整接口或明确禁止第三方客户端访问，应停止相关接口并更新文档。

## 9. 风险与待确认

1. **接口稳定性**：`/api/editor/*` 未公开文档，字段可能变化；需要以「透传原始 JSON + 稳定包装字段」降低耦合。
2. **WAF / 风控**：频繁请求可能触发阿里云 WAF；需限制并发、保留合理超时、必要时提示用户。
3. **登录 Cookie 有效期**：`VEN-SESSION` 默认 `Max-Age=86400`；过期后需要重新登录，M2 需处理。
4. **npm 包名与仓库地址**：包名 `jlc-ecad-mcp` 当前可用；`repository` 字段需在 GitHub 仓库创建后确认。
5. **MCP 客户端兼容性**：不同客户端对 stderr 日志、超时和工具错误展示不同，需要在 Claude Desktop / Claude Code 实测。
6. **CAS 回跳限制（已实测）**：`passport.jlc.com` 不允许 `127.0.0.1` 回调，提示“回调域名未配置到白名单”。因此不使用 localhost 回环；passport Cookie 通过 `check-login` + `/api/editor/login` 换取编辑器会话，失败时再走 CDP。
7. **远程/容器环境**：CDP 登录需要在运行 MCP Server/CLI 的机器上启动 Chrome；容器、远程主机或 SSH 场景下可能无法显示浏览器，需要在该机器内运行或使用 `--cookie` 兜底。
8. **CDP 读取浏览器 Cookie**：需要 Chrome 以 `--remote-debugging-port` 启动；Chrome 136+ 可能拒绝在默认 profile 上开启远程调试，需要独立 `--user-data-dir`（`login` 默认使用临时 profile）。远程调试端口等同浏览器控制权限，只应在本机临时使用，登录后关闭。
