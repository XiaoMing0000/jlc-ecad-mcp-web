# jlc-ecad-mcp

[English](./README.en.md) | 简体中文

用于 [JLC EDA（嘉立创 EDA）](https://www.jlc-ecad.com/editor) 后端接口的 MCP Server，通过 **stdio** 与 AI 客户端通信。

> 当前版本 `0.3.0`（M2）：通过 Chrome CDP 登录、本地会话保存，以及 `GET /api/editor/user`。更多接口见[路线图](https://github.com/XiaoMing0000/jlc-ecad-mcp-web/blob/main/docs/PLAN.md)（[English plan](https://github.com/XiaoMing0000/jlc-ecad-mcp-web/blob/main/docs/PLAN.en.md)）。

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

| 工具                | 说明                                                          |
| ------------------- | ------------------------------------------------------------- |
| `jlc_ecad_login`    | CLI 无法运行时的兜底；需用户确认后以 `{"confirm": true}` 调用 |
| `jlc_ecad_get_user` | 调用 `GET /api/editor/user`，返回当前登录用户的原始 JSON 响应 |

## 配置项

| 环境变量                         | 必填 | 默认值                                  | 说明                                  |
| -------------------------------- | ---- | --------------------------------------- | ------------------------------------- |
| `JLC_ECAD_HOME`                  | 否   | `~/Documents/JLC-ECAD/jlc-ecad-mcp-web` | 覆盖整个配置目录                      |
| `JLC_ECAD_COOKIE`                | 否   | -                                       | 完整 Cookie 字符串，优先级最高        |
| `JLC_ECAD_SESSION_FILE`          | 否   | `<config-dir>/session.json`             | 会话文件路径                          |
| `JLC_ECAD_BASE_URL`              | 否   | `https://www.jlc-ecad.com`              | 接口 Base URL，主要用于测试或本地代理 |
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
