# jlc-ecad-mcp

[English](./README.en.md) | 简体中文

[![CI](https://github.com/XiaoMing0000/jlc-ecad-mcp-web/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoMing0000/jlc-ecad-mcp-web/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jlc-ecad-mcp.svg)](https://www.npmjs.com/package/jlc-ecad-mcp)

用于 [JLC EDA（嘉立创 EDA）](https://www.jlc-ecad.com/editor) 后端接口的 MCP Server，通过 **stdio** 与 AI 客户端通信。

> 当前版本 `1.0.0`：覆盖 141 个工具（手写 + 桌面端迁移），详见[提供的工具](#提供的工具)。

## 功能

- 基于 stdio 的 MCP Server，可接入 Claude Desktop、Claude Code、Cursor 等客户端。
- 直接调用 `https://www.jlc-ecad.com/api/editor/*` 后端接口，不依赖浏览器自动化。
- **CDP 登录**：打开 JLC 编辑器页面，监听 `/api/editor/user`，保存 `passport.jlc.com` 与 `www.jlc-ecad.com` 的 Cookie。
- 从环境变量或本地 `session.json` 读取登录 Cookie，每次请求自动携带。
- 未登录或 Cookie 过期时返回可操作的登录引导，而不是让进程崩溃。
- 网络请求带超时、gzip 解压、JSON 解析与业务错误码处理。

## 环境要求

- Node.js >= 22.18.0

## 快速开始

### 1. 配置 MCP 客户端

**Claude Code：**

```bash
claude mcp add jlc-ecad -- npx -y jlc-ecad-mcp
```

**Claude Desktop / Cursor（`mcpServers` 配置）：**

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

### 2. 登录

**方式 A：CLI 登录（推荐）**

```bash
npx -y jlc-ecad-mcp login
```

流程：

1. 用当前会话请求 `GET /api/editor/user`；如果通过，直接完成；
2. 否则用 `<config-dir>/editor-cookies.json` 请求 `/api/editor/user`；如果通过，保存为会话并完成；
3. 否则用 `<config-dir>/passport-cookies.json`：
   - `POST https://passport.jlc.com/api/cas/sso/check-login`，body 为 `{"appId":"jlc_fa_ecad"}`
   - 如果返回 code（如 `AC-xxxx`），请求 `GET https://www.jlc-ecad.com/api/editor/login?code=...`
   - 保存响应 Cookie 到 `<config-dir>/editor-cookies.json` 和 `<config-dir>/session.json`
   - 再调用 `/api/editor/user` 验证；通过则完成
4. 以上都失败：通过 CDP 启动 Chrome，打开 <https://www.jlc-ecad.com/editor>，由用户完成登录；
   监听 `https://www.jlc-ecad.com/api/editor/user`，成功后保存到 `<config-dir>`：
   - `passport.jlc.com` Cookie → `passport-cookies.json`
   - `www.jlc-ecad.com` Cookie → `editor-cookies.json`
   - `www.jlc-ecad.com` 会话 → `session.json`
     然后关闭 Chrome。

可选参数：

```bash
npx -y jlc-ecad-mcp login --timeout 600          # Chrome 登录等待超时（秒），默认 300
npx -y jlc-ecad-mcp login --profile-dir /tmp/jlc-cdp  # 复用 Chrome profile
npx -y jlc-ecad-mcp login --chrome /path/to/chrome    # 指定 Chrome 可执行文件
npx -y jlc-ecad-mcp login --login-url "https://www.jlc-ecad.com/editor"
npx -y jlc-ecad-mcp login --cookie "VEN-SESSION=...; VEN-CSRF=..."  # 手动 Cookie
```

> `--cookie` 会把 Cookie 暴露在 shell 历史中，仅建议在临时终端使用。
> Chrome 136+ 可能要求非默认 `--user-data-dir` 才能开启远程调试；`login` 默认使用临时 profile，`--profile-dir` 可复用已有 profile。

**方式 B：无法运行 CLI 时调用 `jlc_ecad_login` 工具**

如果客户端可以直接运行 shell，优先使用方式 A 的 `login` 命令。无法运行 shell 时，再让模型调用该工具；工具需要用户确认：不带 `confirm` 调用只会返回确认提示，不会启动登录；用户同意后，再用 `{"confirm": true}` 调用。工具会依次尝试当前会话、editor Cookie、passport Cookie + `check-login`；都失败才通过 CDP 打开编辑器页面。登录完成后调用 `jlc_ecad_get_user`。

**方式 C：手动提供 Cookie**

1. 在浏览器打开 <https://www.jlc-ecad.com/editor> 并登录。
2. 按 `F12`，在 **Application（应用）** → **Cookies** 或 **Network（网络）** 中复制 `Cookie` 请求头。
3. 写入环境变量 `JLC_ECAD_COOKIE`，或保存到会话文件：

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

Cookie 等同于账号凭据，请勿提交到 Git 仓库或分享给他人。

### 补充：从已有 Chrome 读取 passport Cookie（CDP）

`login` 会在本地凭据都不可用时启动 Chrome。如果已经有一个开启远程调试的 Chrome，可以用 `cdp-cookies` 单独读取：

```bash
google-chrome --remote-debugging-port=9222 --remote-allow-origins=* \
  --user-data-dir=/tmp/jlc-cdp https://www.jlc-ecad.com/editor

node dist/index.js cdp-cookies --port 9222
```

默认保存到 `~/Documents/JLC-ECAD/jlc-ecad-mcp-web/passport-cookies.json`（权限 `0600`）。可用 `--domain`、`--host`、`--port`、`--output` 覆盖。

### 3. 使用

在客户端中让模型调用 `jlc_ecad_get_user` 获取当前登录用户信息。

### 退出登录

```bash
npx -y jlc-ecad-mcp logout
```

会删除当前配置目录及旧目录中的：

```text
session.json
passport-cookies.json
editor-cookies.json
```

`logout` 只清理本地凭据，不会影响浏览器登录态或 JLC 服务端会话；如需彻底退出，请在浏览器中退出 JLC 账号。如果设置了 `JLC_ECAD_COOKIE`，请同时取消该环境变量。

## 提供的工具

MCP 服务注册了 **141** 个工具：42 个手写工具（登录/用户 3 个 + 用户设置 5 个 + EDA 检索 2 个 + 部件 Web 操作 6 个 + 产品目录 4 个 + 权益 3 个 + 公测 2 个 + 分类 4 个 + 宏上传 1 个 + 团队管理 12 个），以及从 JLC ECAD 桌面端 `resources/app/server.js` 迁移的 **99** 个 ECAD 工具。`client_*` 仅由桌面端本地服务实现，未注册；`config_index`、`system_attribute_get_preference`、`system_attribute_get_proxy_url`、`eplan_macro_read`、`form_copy_form` 要么仅本地可用、要么线上接口不可用，同样未注册。

| 工具                                   | 说明                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jlc_ecad_login`                       | CLI 无法运行时的兜底；需用户确认后以 `{"confirm": true}` 调用                                                                                                  |
| `jlc_ecad_logout`                      | 调用 `GET /api/editor/logout` 注销服务端会话（不删除本地 Cookie 文件）                                                                                         |
| `jlc_ecad_get_user`                    | 调用 `GET /api/editor/user`，返回当前登录用户的原始 JSON 响应                                                                                                  |
| `jlc_ecad_accept_user_agreement`       | 调用 `POST /api/editor/user/agreement` 统一隐私协议                                                                                                            |
| `jlc_ecad_get_user_logs`               | 调用 `GET /api/editor/user/logs` 获取用户操作日志                                                                                                              |
| `jlc_ecad_search_users`                | 调用 `GET /api/editor/user/search` 按 `q`/`limit` 搜索用户                                                                                                     |
| `jlc_ecad_update_user`                 | 调用 `POST /api/editor/user/update` 修改昵称和头像                                                                                                             |
| `jlc_ecad_get_user_by_uuid`            | 调用 `GET /api/editor/user/:uuid` 获取指定用户信息                                                                                                             |
| `jlc_ecad_search_components`           | 调用 `POST /api/editor/eda/components/searchByIds` 按 UUID 查询 components                                                                                     |
| `jlc_ecad_search_devices`              | 调用 `POST /api/editor/eda/devices/searchByIds` 按 UUID 查询器件                                                                                               |
| `jlc_ecad_order_part_bom`              | 调用 `POST /api/editor/parts/orderBom` 提交 BOM 下单；需 `{"__confirm": true}`                                                                                 |
| `jlc_ecad_add_part_production`         | 调用 `POST /api/editor/parts/production` 添加生产选项卡                                                                                                        |
| `jlc_ecad_update_part_production`      | 调用 `POST /api/editor/parts/production` 更新生产选项卡                                                                                                        |
| `jlc_ecad_delete_part_production`      | 调用 `DELETE /api/editor/parts/production` 删除生产选项卡；需 `{"__confirm": true}`                                                                            |
| `jlc_ecad_get_part_production`         | 调用 `GET /api/editor/parts/production` 获取生产选项卡                                                                                                         |
| `jlc_ecad_search_public_parts`         | 调用 `GET /api/editor/parts/searchPublic` 搜索公共部件                                                                                                         |
| `jlc_ecad_get_product_filters`         | 调用 `GET /api/editor/product/filter` 获取产品筛选项                                                                                                           |
| `jlc_ecad_list_products`               | 调用 `GET /api/editor/product/list` 获取产品列表                                                                                                               |
| `jlc_ecad_list_products_post`          | 调用 `POST /api/editor/product/list` 获取产品列表（字段放在 JSON body）                                                                                        |
| `jlc_ecad_get_product_tree`            | 调用 `GET /api/editor/product/tree` 获取产品树分类                                                                                                             |
| `jlc_ecad_get_official_account_qrcode` | 调用 `GET /api/editor/erp/ecad/qrcode` 获取公众号二维码（后端返回图片时直接返回图片）                                                                          |
| `jlc_ecad_get_designer_rights`         | 调用 `GET /api/editor/erp/ecad/member/rights/designer` 查询客户设计师权益                                                                                      |
| `jlc_ecad_get_member_rights`           | 调用 `GET /api/editor/erp/ecad/member/rights` 查询客户当前领取的权益                                                                                           |
| `jlc_ecad_get_beta_status`             | 调用 `GET /api/editor/beta/version` 获取公测信息并校验是否在内测名单                                                                                           |
| `jlc_ecad_join_beta_whitelist`         | 调用 `POST /api/editor/beta/whitelist` 将当前用户加入公测名单                                                                                                  |
| `jlc_ecad_create_category`             | 调用 `POST /api/editor/categories` 创建分类                                                                                                                    |
| `jlc_ecad_list_categories`             | 调用 `GET /api/editor/categories` 获取分类数据（`type` 以 `type[]` 查询参数发送）                                                                              |
| `jlc_ecad_update_category`             | 调用 `POST /api/editor/categories/:uuid` 更新分类                                                                                                              |
| `jlc_ecad_delete_category`             | 调用 `POST /api/editor/categories/:uuid/delete` 删除分类；需 `{"__confirm": true}`                                                                             |
| `jlc_ecad_upload_macro_data`           | 调用 `PUT /api/editor/macro/:uuid/:macroDataUuid` 上传宏数据（原始字节，默认 `Content-Type: stream`；省略 `macroDataUuid` 时从宏详情 `variables[].uuid` 解析） |
| `jlc_ecad_add_team_member`             | 调用 `POST /api/editor/teams/:uuid/members/add` 添加团队成员                                                                                                   |
| `jlc_ecad_create_team`                 | 调用 `POST /api/editor/teams/create` 创建团队                                                                                                                  |
| `jlc_ecad_delete_team`                 | 调用 `POST /api/editor/teams/:uuid/delete` 删除团队；需 `{"__confirm": true}`                                                                                  |
| `jlc_ecad_list_teams`                  | 调用 `GET /api/editor/teams` 获取团队列表                                                                                                                      |
| `jlc_ecad_get_team_logs`               | 调用 `GET /api/editor/teams/:uuid/logs` 获取团队操作日志                                                                                                       |
| `jlc_ecad_get_other_teams`             | 调用 `GET /api/editor/teams/otherTeams` 获取相关团队                                                                                                           |
| `jlc_ecad_remove_team_member`          | 调用 `POST /api/editor/teams/:uuid/members/remove` 移除团队成员；需 `{"__confirm": true}`                                                                      |
| `jlc_ecad_get_team_info`               | 调用 `POST /api/editor/teams/:uuid/teamInfo` 获取团队详情                                                                                                      |
| `jlc_ecad_transfer_team`               | 调用 `POST /api/editor/teams/:uuid/transfer` 转移团队；需 `{"__confirm": true}`                                                                                |
| `jlc_ecad_update_team`                 | 调用 `POST /api/editor/teams/:uuid/update` 更新团队信息                                                                                                        |
| `jlc_ecad_update_team_member_role`     | 调用 `POST /api/editor/teams/:uuid/members/:memberUuid/update` 修改成员角色                                                                                    |
| `jlc_ecad_update_team_member_remark`   | 调用 `POST /api/editor/teams/:uuid/updateRemark` 修改成员备注                                                                                                  |

### 迁移的 ECAD 工具

迁移工具保留桌面端名称和参数约束；工具描述与参数描述由生成器翻译为英文（使用归属/UUID 语义，去掉本地文件/目录细节），`inputSchema` 直接写成 Zod（`z.looseObject`/`z.string`/`z.array` 等），按业务域拆分在 `src/tools/`；`tools/list` 由 Zod 重新生成 JSON Schema（`format` 等注解字段不保留）：

| 分类     | 工具数 | 文件             |
| -------- | ------ | ---------------- |
| 系统     | 1      | `system.ts`      |
| 其他     | 1      | `misc.ts`        |
| 表单     | 10     | `forms.ts`       |
| 层       | 6      | `layers.ts`      |
| 库       | 5      | `libraries.ts`   |
| 宏       | 8      | `macros.ts`      |
| 部件     | 24     | `parts.ts`       |
| 图框     | 9      | `plot-frames.ts` |
| 工程     | 16     | `projects.ts`    |
| 符号     | 9      | `symbols.ts`     |
| 团队     | 2      | `teams.ts`       |
| 用户偏好 | 8      | `user-tools.ts`  |
| **合计** | **99** |                  |

使用说明：

- **破坏性工具**（52 个）必须由用户确认后，以 `{"__confirm": true}` 调用；未确认时不会发出请求。
- `GET` 工具把参数放在 query string 中，数组参数按编辑器前端的约定序列化为 `key[]=...`；`POST`/`PUT`/`PATCH`/`DELETE` 默认发送 JSON body。
- 路径参数（如 `:uuid`、`:projectUuid`）会自动 `encodeURIComponent` 后填入 URL。
- 若工具 schema 中 `ownerUuid`/`owner_uuid` 为可选参数，调用时会自动填入当前登录用户的 UUID。
- 仅桌面端本地服务可用的工具（`config_index`、`system_attribute_get_preference`、`system_attribute_get_proxy_url`、`eplan_macro_read`）以及线上接口不可用的 `form_copy_form` 已从工具目录排除；如后续需要本地能力，可在 `scripts/import-ecad-catalog.mjs` 的 `excludedTools` 中调整并重新生成。
- 桌面端 schema 与线上接口可能存在细节差异；接口错误会原样返回响应体，便于排查。
- 需要二进制请求体时，可传 `__rawBodyBase64`（base64 字符串）和可选的 `__contentType`；用于分片上传等接口。
- 桌面端升级后重新生成目录：`pnpm run import:ecad /path/to/resources/app/server.js`，然后运行 `pnpm run fmt`。

## 配置项

| 环境变量                         | 必填 | 默认值                                  | 说明                                  |
| -------------------------------- | ---- | --------------------------------------- | ------------------------------------- |
| `JLC_ECAD_HOME`                  | 否   | `~/Documents/JLC-ECAD/jlc-ecad-mcp-web` | 覆盖整个配置目录                      |
| `JLC_ECAD_COOKIE`                | 否   | -                                       | 完整 Cookie 字符串，优先级最高        |
| `JLC_ECAD_SESSION_FILE`          | 否   | `<config-dir>/session.json`             | 会话文件路径                          |
| `JLC_ECAD_BASE_URL`              | 否   | `https://www.jlc-ecad.com`              | 接口 Base URL；也可指向桌面端本地服务 |
| `JLC_ECAD_CAS_URL`               | 否   | `https://passport.jlc.com`              | CAS check-login 地址                  |
| `JLC_ECAD_APP_ID`                | 否   | `jlc_fa_ecad`                           | CAS 应用 ID                           |
| `JLC_ECAD_TIMEOUT_MS`            | 否   | `15000`                                 | 单次 HTTP 请求超时（毫秒）            |
| `JLC_ECAD_LOGIN_TIMEOUT_MS`      | 否   | `300000`                                | CDP 登录等待超时（毫秒）              |
| `JLC_ECAD_PASSPORT_COOKIES_FILE` | 否   | `<config-dir>/passport-cookies.json`    | passport Cookie 快照路径              |
| `JLC_ECAD_EDITOR_COOKIES_FILE`   | 否   | `<config-dir>/editor-cookies.json`      | editor Cookie 快照路径                |
| `JLC_ECAD_DEBUG`                 | 否   | -                                       | 设为 `1` 时输出调试日志到 stderr      |

### 配置目录

默认使用用户级目录，所有客户端（Claude Code、Codex、OpenCode、Hermes 等）共用同一份登录态：

```text
Linux / macOS: ~/Documents/JLC-ECAD/jlc-ecad-mcp-web/
Windows:       %USERPROFILE%\Documents\JLC-ECAD\jlc-ecad-mcp-web\
```

目录内包含：

```text
session.json
passport-cookies.json
editor-cookies.json
```

目录权限 `0700`，文件权限 `0600`。可用 `JLC_ECAD_HOME` 覆盖整个目录，或用单文件环境变量分别覆盖。旧版本的 `~/.jlc-ecad-mcp/`、项目内 `.jlc-ecad-mcp/` 或上一版目录 `~/Documents/JLC-ECAD/jlc-ecad-web-mcp/` 凭据会在首次读取时自动复制迁移，旧文件不会被删除。

### 会话文件格式

```json
{ "version": 1, "cookie": "VEN-SESSION=...; VEN-CSRF=...; ..." }
```

也支持逐项存储：

```json
{ "version": 1, "cookies": { "VEN-SESSION": "...", "VEN-CSRF": "..." } }
```

会话文件按请求实时读取，修改后无需重启 MCP Server。建议使用 `chmod 600` 限制权限。

## 开发

```bash
pnpm install
pnpm run hooks        # 安装 simple-git-hooks（首次克隆后执行一次）
pnpm run build        # 打包为单文件 dist/index.js
pnpm run smoke        # 构建 + 本地 mock API 端到端测试（含登录流程）
pnpm run dev:unwatch  # 用 tsx 直接以 stdio 运行，便于调试
pnpm run lint:check   # oxlint + tsc
pnpm run fmt          # 格式化
```

本地运行时，客户端配置里的 `command` 可直接指向 `node`，`args` 指向 `dist/index.js`：

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

本地登录：

```bash
node dist/index.js login
```

## CI 与发布

CI 在 push 到 `main` 和 PR 时运行（Node 22 / 24）：`fmt:check`、`lint:check`、`smoke`，并执行 `npm pack --dry-run` 校验发布内容。工作流见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

发布由 `v*` 标签触发（[.github/workflows/release.yml](.github/workflows/release.yml)）：先校验标签版本与 `package.json` 的 `version` 一致，再运行同样的检查，最后执行 `pnpm publish --access public --provenance` 并创建 GitHub Release。

```bash
pnpm version patch --no-git-tag-version   # 或 minor / major
git add package.json
git commit -m "chore(release): 1.0.1"
git tag v1.0.1
git push origin main --tags
```

需要在仓库 Secrets 中配置 `NPM_TOKEN`（npm 的 Automation 或 Granular token，需有发布 `jlc-ecad-mcp` 的权限）。GitHub Release 使用默认的 `GITHUB_TOKEN`，无需额外配置；发布带 npm provenance，来源信息会显示在 npm 包页面。

## 登录流程

```text
CLI / MCP 工具
  → 1. 当前会话 → GET /api/editor/user
       通过：完成
  → 2. <config-dir>/editor-cookies.json → GET /api/editor/user
       通过：保存会话，完成
  → 3. <config-dir>/passport-cookies.json
       → POST /api/cas/sso/check-login {appId: jlc_fa_ecad}
       → 有 code：GET /api/editor/login?code=...
       → 保存 editor-cookies.json + session.json
       → GET /api/editor/user 验证；通过：完成
  → 4. 都失败：CDP 启动 Chrome → 打开 /editor → 用户登录
       → 监听 /api/editor/user
       → 保存 passport-cookies.json + editor-cookies.json + session.json
       → 关闭 Chrome
```

## 安全说明

- 登录通过 Chrome DevTools Protocol 完成；远程调试端口只用于本机临时 profile。
- Chrome 远程调试会暴露浏览器控制能力，登录完成后会关闭该 Chrome 实例。
- 本工具只代表用户本人访问其有权访问的 JLC EDA 接口，不绕过网站鉴权。
- 会话 Cookie 与两个域名的 Cookie 快照仅保存在本机（`0600`），不会被写入日志或随 npm 包发布。
- 接口路径来自网站前端 bundle，可能随 JLC EDA 更新而变化；如遇接口调整请提交 Issue。

## 许可证

[MIT](./LICENSE)

## 作者

[xiaoming0000](https://github.com/XiaoMing0000)
