/**
 * End-to-end smoke test for the stdio MCP server.
 *
 * Starts a local mock of the JLC editor/cas endpoints, launches
 * dist/index.js as a child process, and verifies:
 *   1. the MCP handshake, tool listing, and logged-out 401 guidance,
 *   2. JLC_ECAD_COOKIE is forwarded,
 *   3. a session file with a "cookies" object is forwarded,
 *   4. a raw gzip response is decoded,
 *   5. imported ECAD catalog tools handle query/path parameters and destructive confirmation,
 *   6. the CLI `login` command succeeds with a valid current session (no Chrome),
 *   7. the MCP `jlc_ecad_login` tool does the same,
 *   8. the CLI `login` falls back to the editor cookie snapshot,
 *   9. the CLI `login` falls back to passport cookies + check-login,
 *  10. `login --cookie` saves the session under JLC_ECAD_HOME,
 *  11. `logout` removes current and legacy credential files.
 *
 * Run with: pnpm run smoke
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const requests = [];

const mock = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const cookie = req.headers.cookie ?? '';
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, cookie, body, headers: req.headers });

    if (url.pathname === '/api/cas/sso/check-login') {
      res.setHeader('Content-Type', 'application/json');
      if (cookie.includes('PASSPORT_SESSION=valid')) {
        res.end(JSON.stringify({ success: true, code: 200, data: { isLogin: true, code: 'AC-test' } }));
      } else {
        res.end(JSON.stringify({ success: true, code: 200, data: { isLogin: false } }));
      }
      return;
    }

    if (url.pathname === '/api/editor/login') {
      if (url.searchParams.get('code') === 'AC-test') {
        res.statusCode = 302;
        res.setHeader('Location', '/editor');
        res.setHeader('Set-Cookie', ['VEN-SESSION=valid; Path=/; HttpOnly', 'VEN-CSRF=from-login; Path=/']);
        res.end();
      } else {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, code: 400 }));
      }
      return;
    }

    if (url.pathname === '/editor') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html>editor</html>');
      return;
    }

    if (url.pathname === '/api/editor/teams') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'team-1', name: 'Demo' }] }));
      return;
    }

    if (url.pathname === '/api/editor/teams/otherTeams') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'team-2' }] }));
      return;
    }

    if (url.pathname === '/api/editor/teams/create') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { uuid: 'team-new' } }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/teams/') && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { logs: [{ uuid: 'log-1' }] } }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/teams/') && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { ok: true } }));
      return;
    }

    if (url.pathname === '/api/editor/eda/components/searchByIds') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'component-1' }] }));
      return;
    }

    if (url.pathname === '/api/editor/eda/devices/searchByIds') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'device-1' }] }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/libraries/symbols/') && req.method === 'DELETE') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: {} }));
      return;
    }

    if (url.pathname === '/api/editor/macro' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { uuid: 'm/2', variables: [{ type: 1, uuid: 'md-2' }] } }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/macro/') && req.method === 'PUT') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { uploaded: true } }));
      return;
    }

    if (url.pathname === '/api/editor/categories' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { uuid: 'cat-new' } }));
      return;
    }

    if (url.pathname === '/api/editor/categories' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'cat-1' }] }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/categories/')) {
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/delete')) {
        res.end(JSON.stringify({ success: true, code: 200, result: { deleted: true } }));
      } else {
        res.end(JSON.stringify({ success: true, code: 200, result: { updated: true } }));
      }
      return;
    }

    if (url.pathname === '/api/editor/logout') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { ok: true } }));
      return;
    }

    if (url.pathname === '/api/editor/erp/ecad/qrcode') {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
      return;
    }

    if (url.pathname === '/api/editor/erp/ecad/member/rights/designer') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { rights: ['designer'] } }));
      return;
    }

    if (url.pathname === '/api/editor/erp/ecad/member/rights') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { rights: ['member'] } }));
      return;
    }

    if (url.pathname === '/api/editor/beta/version') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { version: '1.0', inWhitelist: true } }));
      return;
    }

    if (url.pathname === '/api/editor/beta/whitelist') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { joined: true } }));
      return;
    }

    if (url.pathname === '/api/editor/product/filter') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { filters: ['resistor'] } }));
      return;
    }

    if (url.pathname === '/api/editor/product/list') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { list: [{ uuid: 'product-1' }] } }));
      return;
    }

    if (url.pathname === '/api/editor/product/search') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { list: [{ uuid: 'product-1' }] } }));
      return;
    }

    if (url.pathname === '/api/editor/product/tree') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ id: 'cat-1' }] }));
      return;
    }

    if (url.pathname === '/api/editor/parts/orderBom') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { orderId: 'bom-1' } }));
      return;
    }

    if (url.pathname === '/api/editor/parts/searchPublic') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'public-1' }] }));
      return;
    }

    if (url.pathname === '/api/editor/parts/production') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'prod-1' }] }));
      } else {
        res.end(JSON.stringify({ success: true, code: 200, result: { ok: true } }));
      }
      return;
    }

    if (url.pathname === '/api/editor/parts/list' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { list: [], page: 1, pageSize: 10 } }));
      return;
    }

    if (url.pathname === '/api/editor/parts' && req.method === 'DELETE') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: {} }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/parts/')) {
      res.setHeader('Content-Type', 'application/json');
      const uuid = decodeURIComponent(url.pathname.slice('/api/editor/parts/'.length));
      res.end(JSON.stringify({ success: true, code: 200, result: { uuid } }));
      return;
    }

    if (url.pathname === '/api/editor/client/clearLog') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { cleared: true } }));
      return;
    }

    if (url.pathname === '/api/editor/user/agreement') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { agreed: true } }));
      return;
    }

    if (url.pathname === '/api/editor/user/logs') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { logs: [{ uuid: 'log-1' }] } }));
      return;
    }

    if (url.pathname === '/api/editor/user/search') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: [{ uuid: 'user-2' }] }));
      return;
    }

    if (url.pathname === '/api/editor/user/update' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { updated: true } }));
      return;
    }

    if (url.pathname.startsWith('/api/editor/user/') && req.method === 'GET') {
      const uuid = decodeURIComponent(url.pathname.slice('/api/editor/user/'.length));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, code: 200, result: { uuid } }));
      return;
    }

    if (url.pathname === '/api/editor/user') {
      if (cookie.includes('VEN-SESSION=gzip')) {
        // Mimic the backend's occasional raw-gzip response.
        res.setHeader('Content-Type', 'application/gzip');
        res.end(gzipSync(JSON.stringify({ success: true, code: 200, result: { uuid: 'user-2', username: 'gzip-demo' } })));
      } else if (cookie.includes('VEN-SESSION=valid')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, code: 200, result: { uuid: 'user-1', username: 'demo' } }));
      } else {
        // The real backend returns HTTP 200 with a business-level 401.
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, code: 401 }));
      }
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const port = mock.address().port;

const sessionDir = mkdtempSync(join(tmpdir(), 'jlc-ecad-mcp-smoke-'));
const sessionFile = join(sessionDir, 'session.json');
writeFileSync(sessionFile, JSON.stringify({ version: 1, cookies: { 'VEN-SESSION': 'valid', 'VEN-CSRF': 'from-file' } }), { mode: 0o600 });

function makeClient(env) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JLC_ECAD_BASE_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_CAS_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_COOKIE: '',
      JLC_ECAD_SESSION_FILE: join(sessionDir, 'missing.json'),
      JLC_ECAD_PASSPORT_COOKIES_FILE: join(sessionDir, 'missing-passport.json'),
      JLC_ECAD_EDITOR_COOKIES_FILE: join(sessionDir, 'missing-editor.json'),
      JLC_ECAD_DEBUG: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}\n${stderr}`)), 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  };

  return { request, notify, close };
}

const initialize = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } };

async function callTool(client) {
  return client.request('tools/call', { name: 'jlc_ecad_get_user', arguments: {} });
}

// 1) Logged out: tool error with instructions, process stays healthy.
{
  const client = makeClient({});
  const init = await client.request('initialize', initialize);
  assert.equal(init.result.serverInfo.name, 'jlc-ecad-mcp');
  client.notify('notifications/initialized', {});

  const list = await client.request('tools/list', {});
  const listedNames = list.result.tools.map((tool) => tool.name);
  assert.equal(listedNames.length, 141);
  assert.equal(new Set(listedNames).size, listedNames.length);
  assert.ok(listedNames.includes('jlc_ecad_get_user'));
  assert.ok(listedNames.includes('jlc_ecad_login'));
  assert.ok(listedNames.includes('part_detail_part'));
  assert.ok(listedNames.includes('project_update_project'));
  for (const removed of ['config_index', 'system_attribute_get_preference', 'system_attribute_get_proxy_url', 'eplan_macro_read', 'form_copy_form']) {
    assert.ok(!listedNames.includes(removed), `${removed} should not be registered`);
  }
  const deleteForm = list.result.tools.find((tool) => tool.name === 'form_delete_form');
  assert.ok(deleteForm, 'form_delete_form should be registered');
  assert.deepEqual(Object.keys(deleteForm.inputSchema.properties ?? {}).sort(), ['ownerUuid', 'uuid']);

  const deleteLibrary = list.result.tools.find((tool) => tool.name === 'library_delete_libraries');
  assert.ok(deleteLibrary, 'library_delete_libraries should be registered');
  assert.deepEqual(Object.keys(deleteLibrary.inputSchema.properties ?? {}), ['uuid']);
  assert.ok(deleteLibrary.inputSchema.required?.includes('uuid'));

  const call = await callTool(client);
  assert.equal(call.result.isError, true);
  const text = call.result.content[0].text;
  assert.match(text, /Not logged in to JLC EDA/);
  assert.match(text, /Response body:/);
  assert.match(text, /"success": false/);
  assert.match(text, /"code": 401/);
  await client.close();
}

// 2) Cookie from JLC_ECAD_COOKIE is forwarded.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid; VEN-CSRF=abc' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const call = await callTool(client);
  assert.equal(call.result.isError, undefined);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.result.username, 'demo');
  assert.equal(requests.at(-1).cookie, 'VEN-SESSION=valid; VEN-CSRF=abc');
  await client.close();
}

// 3) Cookie from the "cookies" object in a session file is forwarded.
{
  const client = makeClient({ JLC_ECAD_SESSION_FILE: sessionFile });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const call = await callTool(client);
  assert.equal(call.result.isError, undefined);
  assert.equal(requests.at(-1).cookie, 'VEN-SESSION=valid; VEN-CSRF=from-file');
  await client.close();
}

// 4) Raw gzip response (content-type: application/gzip) is decoded.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=gzip' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const call = await callTool(client);
  assert.equal(call.result.isError, undefined);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.data.result.username, 'gzip-demo');
  await client.close();
}

// 5) Imported ECAD catalog tools: GET query, path encoding, destructive confirmation.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const teams = await client.request('tools/call', { name: 'team_team_list', arguments: { page: '1' } });
  assert.equal(teams.result.isError, undefined, teams.result.content[0].text);
  assert.match(teams.result.content[0].text, /team-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.match(requests.at(-1).url, /\/api\/editor\/teams\?page=1/);

  const part = await client.request('tools/call', { name: 'part_detail_part', arguments: { uuid: 'abc/def' } });
  assert.equal(part.result.isError, undefined, part.result.content[0].text);
  assert.match(part.result.content[0].text, /abc\/def/);
  assert.match(requests.at(-1).url, /\/api\/editor\/parts\/abc%2Fdef/);

  const before = requests.length;
  const denied = await client.request('tools/call', { name: 'part_delete_parts', arguments: { uuids: ['part-a'] } });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /destructive/);
  assert.match(denied.result.content[0].text, /__confirm/);
  assert.equal(requests.length, before);

  const deleted = await client.request('tools/call', {
    name: 'part_delete_parts',
    arguments: { uuids: ['part-a'], __confirm: true },
  });
  assert.equal(deleted.result.isError, undefined, deleted.result.content[0].text);
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).url, '/api/editor/parts');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { uuids: ['part-a'] });

  await client.close();
}

// 6) CLI `login`: valid current session -> success without Chrome.
{
  const cliSessionFile = join(sessionDir, 'cli-session.json');
  writeFileSync(cliSessionFile, JSON.stringify({ version: 1, cookie: 'VEN-SESSION=valid' }), { mode: 0o600 });

  const cli = spawn(process.execPath, ['dist/index.js', 'login', '--timeout', '10'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JLC_ECAD_BASE_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_CAS_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_COOKIE: '',
      JLC_ECAD_SESSION_FILE: cliSessionFile,
      JLC_ECAD_PASSPORT_COOKIES_FILE: join(sessionDir, 'missing-passport.json'),
      JLC_ECAD_EDITOR_COOKIES_FILE: join(sessionDir, 'missing-editor.json'),
      JLC_ECAD_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  cli.stdout.setEncoding('utf8');
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  cli.stderr.setEncoding('utf8');
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => cli.once('exit', resolve));
  assert.equal(exitCode, 0, `CLI login failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Login successful/);
  assert.match(requests.at(-1).cookie, /VEN-SESSION=valid/);

  const saved = JSON.parse(readFileSync(cliSessionFile, 'utf8'));
  assert.match(saved.cookie, /VEN-SESSION=valid/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(cliSessionFile).mode & 0o777, 0o600);
  }
}

// 7) MCP `jlc_ecad_login`: valid current session -> no Chrome.
{
  const toolSessionFile = join(sessionDir, 'tool-session.json');
  writeFileSync(toolSessionFile, JSON.stringify({ version: 1, cookie: 'VEN-SESSION=valid' }), { mode: 0o600 });

  const client = makeClient({
    JLC_ECAD_SESSION_FILE: toolSessionFile,
    JLC_ECAD_PASSPORT_COOKIES_FILE: join(sessionDir, 'missing-passport.json'),
    JLC_ECAD_EDITOR_COOKIES_FILE: join(sessionDir, 'missing-editor.json'),
  });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const confirmPrompt = await client.request('tools/call', { name: 'jlc_ecad_login', arguments: {} });
  assert.equal(confirmPrompt.result.isError, undefined);
  assert.match(confirmPrompt.result.content[0].text, /explicit user confirmation/i);
  assert.match(confirmPrompt.result.content[0].text, /npx -y jlc-ecad-mcp login/);
  assert.match(confirmPrompt.result.content[0].text, /confirm.*true/i);

  const loginCall = await client.request('tools/call', { name: 'jlc_ecad_login', arguments: { confirm: true } });
  assert.equal(loginCall.result.isError, undefined);
  assert.match(loginCall.result.content[0].text, /Already signed in/);

  const call = await callTool(client);
  assert.equal(call.result.isError, undefined, call.result.content[0].text);
  assert.match(requests.at(-1).cookie, /VEN-SESSION=valid/);
  await client.close();
}

// 8) CLI `login`: missing session -> editor cookie snapshot -> session saved.
{
  const editorFile = join(sessionDir, 'editor-snapshot.json');
  writeFileSync(
    editorFile,
    JSON.stringify(
      {
        version: 1,
        source: 'cdp',
        host: '127.0.0.1',
        capturedAt: new Date().toISOString(),
        chrome: { browser: 'mock', endpoint: `http://127.0.0.1:${port}` },
        target: { id: 'mock' },
        cookie: 'VEN-SESSION=valid',
        cookies: [{ name: 'VEN-SESSION', value: 'valid', domain: '127.0.0.1', path: '/', secure: false, session: true }],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const loginSessionFile = join(sessionDir, 'editor-fallback-session.json');
  const cli = spawn(process.execPath, ['dist/index.js', 'login', '--timeout', '10'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JLC_ECAD_BASE_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_CAS_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_COOKIE: '',
      JLC_ECAD_SESSION_FILE: loginSessionFile,
      JLC_ECAD_PASSPORT_COOKIES_FILE: join(sessionDir, 'missing-passport.json'),
      JLC_ECAD_EDITOR_COOKIES_FILE: editorFile,
      JLC_ECAD_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  cli.stdout.setEncoding('utf8');
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  cli.stderr.setEncoding('utf8');
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => cli.once('exit', resolve));
  assert.equal(exitCode, 0, `CLI login failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Login successful/);

  const saved = JSON.parse(readFileSync(loginSessionFile, 'utf8'));
  assert.match(saved.cookie, /VEN-SESSION=valid/);
  assert.equal(saved.user.username, 'demo');
}

// 9) CLI `login`: no saved session/editor cookies -> passport cookies + check-login.
{
  const passportFile = join(sessionDir, 'passport-snapshot.json');
  writeFileSync(
    passportFile,
    JSON.stringify(
      {
        version: 1,
        source: 'cdp',
        host: '127.0.0.1',
        capturedAt: new Date().toISOString(),
        chrome: { browser: 'mock', endpoint: `http://127.0.0.1:${port}` },
        target: { id: 'mock' },
        cookie: 'PASSPORT_SESSION=valid',
        cookies: [{ name: 'PASSPORT_SESSION', value: 'valid', domain: '127.0.0.1', path: '/', secure: false, session: true }],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const editorOut = join(sessionDir, 'editor-from-passport.json');
  const loginSessionFile = join(sessionDir, 'passport-fallback-session.json');
  const cli = spawn(process.execPath, ['dist/index.js', 'login', '--timeout', '10'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JLC_ECAD_BASE_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_CAS_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_COOKIE: '',
      JLC_ECAD_SESSION_FILE: loginSessionFile,
      JLC_ECAD_PASSPORT_COOKIES_FILE: passportFile,
      JLC_ECAD_EDITOR_COOKIES_FILE: editorOut,
      JLC_ECAD_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  cli.stdout.setEncoding('utf8');
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  cli.stderr.setEncoding('utf8');
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => cli.once('exit', resolve));
  assert.equal(exitCode, 0, `CLI login failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Login successful/);

  const saved = JSON.parse(readFileSync(loginSessionFile, 'utf8'));
  assert.match(saved.cookie, /VEN-SESSION=valid/);
  assert.match(saved.cookie, /VEN-CSRF=from-login/);
  assert.equal(saved.user.username, 'demo');

  const editorSnapshot = JSON.parse(readFileSync(editorOut, 'utf8'));
  const names = editorSnapshot.cookies.map((cookie) => cookie.name);
  assert.ok(names.includes('VEN-SESSION'));
  assert.ok(names.includes('VEN-CSRF'));
}

// 10) `login --cookie` saves the session under JLC_ECAD_HOME.
{
  const configDir = mkdtempSync(join(tmpdir(), 'jlc-ecad-home-'));
  const cli = spawn(process.execPath, ['dist/index.js', 'login', '--cookie', 'VEN-SESSION=valid'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JLC_ECAD_BASE_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_CAS_URL: `http://127.0.0.1:${port}`,
      JLC_ECAD_HOME: configDir,
      JLC_ECAD_COOKIE: '',
      JLC_ECAD_SESSION_FILE: '',
      JLC_ECAD_PASSPORT_COOKIES_FILE: '',
      JLC_ECAD_EDITOR_COOKIES_FILE: '',
      JLC_ECAD_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  cli.stdout.setEncoding('utf8');
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  cli.stderr.setEncoding('utf8');
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => cli.once('exit', resolve));
  assert.equal(exitCode, 0, `CLI login failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Login successful/);

  const sessionPath = join(configDir, 'session.json');
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
  assert.match(saved.cookie, /VEN-SESSION=valid/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
  }
}

// 11) `logout` removes current and legacy credential files.
{
  const projectRoot = process.cwd();
  const logoutDir = mkdtempSync(join(tmpdir(), 'jlc-logout-'));
  const legacyDir = join(logoutDir, '.jlc-ecad-mcp');
  const previousConfigDir = join(logoutDir, 'Documents', 'JLC-ECAD', 'jlc-ecad-web-mcp');
  mkdirSync(legacyDir, { recursive: true });
  mkdirSync(previousConfigDir, { recursive: true });

  const files = [
    join(logoutDir, 'session.json'),
    join(logoutDir, 'passport-cookies.json'),
    join(logoutDir, 'editor-cookies.json'),
    join(legacyDir, 'session.json'),
    join(legacyDir, 'passport-cookies.json'),
    join(legacyDir, 'editor-cookies.json'),
    join(previousConfigDir, 'session.json'),
    join(previousConfigDir, 'passport-cookies.json'),
    join(previousConfigDir, 'editor-cookies.json'),
  ];
  for (const file of files) {
    writeFileSync(file, '{}', { mode: 0o600 });
  }

  const cli = spawn(process.execPath, [join(projectRoot, 'dist/index.js'), 'logout'], {
    cwd: logoutDir,
    env: {
      ...process.env,
      HOME: logoutDir,
      USERPROFILE: logoutDir,
      JLC_ECAD_HOME: logoutDir,
      JLC_ECAD_COOKIE: '',
      JLC_ECAD_SESSION_FILE: '',
      JLC_ECAD_PASSPORT_COOKIES_FILE: '',
      JLC_ECAD_EDITOR_COOKIES_FILE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  cli.stdout.setEncoding('utf8');
  cli.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  cli.stderr.setEncoding('utf8');
  cli.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve) => cli.once('exit', resolve));
  assert.equal(exitCode, 0, `CLI logout failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Removed local JLC EDA credentials/);
  for (const file of files) {
    assert.equal(existsSync(file), false, `${file} should be removed`);
  }
}

// 12) Hand-written EDA search tools post their JSON body to the editor API.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const components = await client.request('tools/call', {
    name: 'jlc_ecad_search_components',
    arguments: { path: '/demo', uuids: ['c1', 'c2'] },
  });
  assert.equal(components.result.isError, undefined, components.result.content[0].text);
  assert.match(components.result.content[0].text, /component-1/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/eda/components/searchByIds');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { path: '/demo', uuids: ['c1', 'c2'] });

  const devices = await client.request('tools/call', {
    name: 'jlc_ecad_search_devices',
    arguments: { uuids: ['d1'] },
  });
  assert.equal(devices.result.isError, undefined, devices.result.content[0].text);
  assert.match(devices.result.content[0].text, /device-1/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/eda/devices/searchByIds');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { uuids: ['d1'] });

  await client.close();
}

// 13) Web-only parts tools: BOM order, production tabs, and public search.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const beforeOrder = requests.length;
  const deniedOrder = await client.request('tools/call', {
    name: 'jlc_ecad_order_part_bom',
    arguments: { list: [{ partUuid: 'p1', count: 2 }], bom_name: 'BOM-A', customer_code: 'C-1' },
  });
  assert.equal(deniedOrder.result.isError, true);
  assert.match(deniedOrder.result.content[0].text, /destructive/);
  assert.match(deniedOrder.result.content[0].text, /__confirm/);
  assert.equal(requests.length, beforeOrder);

  const ordered = await client.request('tools/call', {
    name: 'jlc_ecad_order_part_bom',
    arguments: { list: [{ partUuid: 'p1', count: 2 }], bom_name: 'BOM-A', customer_code: 'C-1', __confirm: true },
  });
  assert.equal(ordered.result.isError, undefined, ordered.result.content[0].text);
  assert.match(ordered.result.content[0].text, /bom-1/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/parts/orderBom');
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    list: [{ partUuid: 'p1', count: 2 }],
    bom_name: 'BOM-A',
    customer_code: 'C-1',
  });

  const added = await client.request('tools/call', {
    name: 'jlc_ecad_add_part_production',
    arguments: { partUuid: 'p1', data: [{ drillUuid: 'd1', name: 'top', offsetX: 1, offsetY: 2, sort: 0 }] },
  });
  assert.equal(added.result.isError, undefined, added.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/parts/production');
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    partUuid: 'p1',
    data: [{ drillUuid: 'd1', name: 'top', offsetX: 1, offsetY: 2, sort: 0 }],
  });

  const updated = await client.request('tools/call', {
    name: 'jlc_ecad_update_part_production',
    arguments: { partUuid: 'p1', data: [{ uuid: 't1', offsetX: 3 }] },
  });
  assert.equal(updated.result.isError, undefined, updated.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/parts/production');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { partUuid: 'p1', data: [{ uuid: 't1', offsetX: 3 }] });

  const beforeDelete = requests.length;
  const deniedDelete = await client.request('tools/call', {
    name: 'jlc_ecad_delete_part_production',
    arguments: { partUuid: 'p1', uuids: ['t1'] },
  });
  assert.equal(deniedDelete.result.isError, true);
  assert.match(deniedDelete.result.content[0].text, /__confirm/);
  assert.equal(requests.length, beforeDelete);

  const deleted = await client.request('tools/call', {
    name: 'jlc_ecad_delete_part_production',
    arguments: { partUuid: 'p1', uuids: ['t1'], __confirm: true },
  });
  assert.equal(deleted.result.isError, undefined, deleted.result.content[0].text);
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).url, '/api/editor/parts/production');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { partUuid: 'p1', uuids: ['t1'] });

  const listed = await client.request('tools/call', {
    name: 'jlc_ecad_get_part_production',
    arguments: { partUuid: 'p1' },
  });
  assert.equal(listed.result.isError, undefined, listed.result.content[0].text);
  assert.match(listed.result.content[0].text, /prod-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/parts/production?partUuid=p1');

  const search = await client.request('tools/call', {
    name: 'jlc_ecad_search_public_parts',
    arguments: { keyword: 'res', type: 1, page: 2, pageSize: 20 },
  });
  assert.equal(search.result.isError, undefined, search.result.content[0].text);
  assert.match(search.result.content[0].text, /public-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/parts/searchPublic?keyword=res&type=1&page=2&pageSize=20');

  await client.close();
}

// 14) Web-only product catalog tools: filters, list (GET/POST), and tree.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const query = {
    pageNum: 1,
    pageSize: 20,
    catalog: 'res',
    param: '{}',
    keyword: '10k',
    piceSort: 'asc',
    stockSort: 'desc',
  };

  const filters = await client.request('tools/call', {
    name: 'jlc_ecad_get_product_filters',
    arguments: query,
  });
  assert.equal(filters.result.isError, undefined, filters.result.content[0].text);
  assert.match(filters.result.content[0].text, /resistor/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(
    requests.at(-1).url,
    '/api/editor/product/filter?pageNum=1&pageSize=20&catalog=res&param=%7B%7D&keyword=10k&piceSort=asc&stockSort=desc',
  );

  const listed = await client.request('tools/call', { name: 'jlc_ecad_list_products', arguments: query });
  assert.equal(listed.result.isError, undefined, listed.result.content[0].text);
  assert.match(listed.result.content[0].text, /product-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.match(requests.at(-1).url, /^\/api\/editor\/product\/list\?pageNum=1&/);

  const posted = await client.request('tools/call', { name: 'jlc_ecad_list_products_post', arguments: query });
  assert.equal(posted.result.isError, undefined, posted.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/product/search');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { pageNum: 1, pageSize: 20, keyword: '10k' });

  const tree = await client.request('tools/call', { name: 'jlc_ecad_get_product_tree', arguments: {} });
  assert.equal(tree.result.isError, undefined, tree.result.content[0].text);
  assert.match(tree.result.content[0].text, /cat-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/product/tree');

  await client.close();
}

// 15) Web-only logout, ERP rights, and beta program tools.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const logout = await client.request('tools/call', { name: 'jlc_ecad_logout', arguments: {} });
  assert.equal(logout.result.isError, undefined, logout.result.content[0].text);
  assert.match(logout.result.content[0].text, /"ok": true/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/logout');

  const qrcode = await client.request('tools/call', {
    name: 'jlc_ecad_get_official_account_qrcode',
    arguments: {},
  });
  assert.equal(qrcode.result.isError, undefined);
  assert.equal(qrcode.result.content[0].type, 'image');
  assert.equal(qrcode.result.content[0].mimeType, 'image/png');
  assert.ok(qrcode.result.content[0].data.length > 0);
  assert.equal(requests.at(-1).url, '/api/editor/erp/ecad/qrcode');

  const designer = await client.request('tools/call', {
    name: 'jlc_ecad_get_designer_rights',
    arguments: {},
  });
  assert.equal(designer.result.isError, undefined, designer.result.content[0].text);
  assert.match(designer.result.content[0].text, /designer/);
  assert.equal(requests.at(-1).url, '/api/editor/erp/ecad/member/rights/designer');

  const member = await client.request('tools/call', { name: 'jlc_ecad_get_member_rights', arguments: {} });
  assert.equal(member.result.isError, undefined, member.result.content[0].text);
  assert.match(member.result.content[0].text, /member/);
  assert.equal(requests.at(-1).url, '/api/editor/erp/ecad/member/rights');

  const beta = await client.request('tools/call', { name: 'jlc_ecad_get_beta_status', arguments: {} });
  assert.equal(beta.result.isError, undefined, beta.result.content[0].text);
  assert.match(beta.result.content[0].text, /inWhitelist/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/beta/version');

  const joined = await client.request('tools/call', { name: 'jlc_ecad_join_beta_whitelist', arguments: {} });
  assert.equal(joined.result.isError, undefined, joined.result.content[0].text);
  assert.match(joined.result.content[0].text, /joined/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/beta/whitelist');
  assert.equal(requests.at(-1).body, '{}');

  await client.close();
}

// 16) Category tools: create, list, update, and confirmed delete.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const created = await client.request('tools/call', {
    name: 'jlc_ecad_create_category',
    arguments: { name: 'Resistors', type: 6, user_uuid: 'u1', order_no: 1 },
  });
  assert.equal(created.result.isError, undefined, created.result.content[0].text);
  assert.match(created.result.content[0].text, /cat-new/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/categories');
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    name: 'Resistors',
    type: 6,
    user_uuid: 'u1',
    order_no: 1,
  });

  const listed = await client.request('tools/call', {
    name: 'jlc_ecad_list_categories',
    arguments: { user_uuid: 'u1', type: [6] },
  });
  assert.equal(listed.result.isError, undefined, listed.result.content[0].text);
  assert.match(listed.result.content[0].text, /cat-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/categories?user_uuid=u1&type%5B%5D=6');

  const updated = await client.request('tools/call', {
    name: 'jlc_ecad_update_category',
    arguments: { uuid: 'cat-1', name: 'Resistors 0805', order_no: 2 },
  });
  assert.equal(updated.result.isError, undefined, updated.result.content[0].text);
  assert.match(updated.result.content[0].text, /updated/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/categories/cat-1');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { name: 'Resistors 0805', order_no: 2 });

  const beforeDelete = requests.length;
  const denied = await client.request('tools/call', {
    name: 'jlc_ecad_delete_category',
    arguments: { uuid: 'cat-1' },
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /destructive/);
  assert.match(denied.result.content[0].text, /__confirm/);
  assert.equal(requests.length, beforeDelete);

  const deleted = await client.request('tools/call', {
    name: 'jlc_ecad_delete_category',
    arguments: { uuid: 'cat/1', __confirm: true },
  });
  assert.equal(deleted.result.isError, undefined, deleted.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/categories/cat%2F1/delete');
  assert.equal(requests.at(-1).body, '{}');

  await client.close();
}

// 17) Web-only macro data upload: raw body with the stream content type.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const uploaded = await client.request('tools/call', {
    name: 'jlc_ecad_upload_macro_data',
    arguments: { uuid: 'm/1', macroDataUuid: 'md/1', dataBase64: Buffer.from('macro-data').toString('base64') },
  });
  assert.equal(uploaded.result.isError, undefined, uploaded.result.content[0].text);
  assert.match(uploaded.result.content[0].text, /uploaded/);
  assert.equal(requests.at(-1).method, 'PUT');
  assert.equal(requests.at(-1).url, '/api/editor/macro/m%2F1/md%2F1');
  assert.equal(requests.at(-1).body, 'macro-data');
  assert.equal(requests.at(-1).headers['content-type'], 'stream');

  // Without macroDataUuid the tool resolves it from the macro detail variables.
  const resolved = await client.request('tools/call', {
    name: 'jlc_ecad_upload_macro_data',
    arguments: { uuid: 'm/2', type: 1, dataBase64: Buffer.from('resolved-data').toString('base64') },
  });
  assert.equal(resolved.result.isError, undefined, resolved.result.content[0].text);
  assert.match(resolved.result.content[0].text, /uploaded/);
  assert.equal(requests.at(-2).method, 'GET');
  assert.equal(requests.at(-2).url, '/api/editor/macro?uuid=m%2F2');
  assert.equal(requests.at(-1).method, 'PUT');
  assert.equal(requests.at(-1).url, '/api/editor/macro/m%2F2/md-2');
  assert.equal(requests.at(-1).body, 'resolved-data');

  await client.close();
}

// 17b) Imported library delete uses the per-UUID route with path encoding.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const denied = await client.request('tools/call', {
    name: 'library_delete_libraries',
    arguments: { uuid: 'lib/1' },
  });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /destructive/);

  const deleted = await client.request('tools/call', {
    name: 'library_delete_libraries',
    arguments: { uuid: 'lib/1', __confirm: true },
  });
  assert.equal(deleted.result.isError, undefined, deleted.result.content[0].text);
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).url, '/api/editor/libraries/symbols/lib%2F1');
  assert.equal(requests.at(-1).body, '{}');

  await client.close();
}

// 17c) Imported part list sends the frontend-compatible POST body.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const listed = await client.request('tools/call', {
    name: 'part_get_part_list',
    arguments: {
      ownerUuid: 'u1',
      type: 1,
      category: [['22001', 'test']],
      attrIds: ['22001', '22024'],
      keyword: 'resistor',
      page: 1,
      pageSize: 10,
    },
  });
  assert.equal(listed.result.isError, undefined, listed.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/parts/list');
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    ownerUuid: 'u1',
    type: 1,
    category: [['22001', 'test']],
    attrIds: ['22001', '22024'],
    keyword: 'resistor',
    page: 1,
    pageSize: 10,
  });

  await client.close();
}

// 18) Web-only team management tools.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const list = await client.request('tools/call', {
    name: 'jlc_ecad_list_teams',
    arguments: { page: 1, pageSize: 10, type: 'all', form: 'all' },
  });
  assert.equal(list.result.isError, undefined, list.result.content[0].text);
  assert.match(list.result.content[0].text, /team-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/teams?page=1&pageSize=10&type=all&form=all');

  const other = await client.request('tools/call', { name: 'jlc_ecad_get_other_teams', arguments: {} });
  assert.equal(other.result.isError, undefined, other.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/otherTeams');

  const created = await client.request('tools/call', {
    name: 'jlc_ecad_create_team',
    arguments: { username: 'team-a', members: ['u1', 'u2'] },
  });
  assert.equal(created.result.isError, undefined, created.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/teams/create');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { username: 'team-a', members: ['u1', 'u2'] });

  const added = await client.request('tools/call', {
    name: 'jlc_ecad_add_team_member',
    arguments: { teamUuid: 't/1', memberUuid: 'm1' },
  });
  assert.equal(added.result.isError, undefined, added.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t%2F1/members/add');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { uuid: 'm1' });

  const role = await client.request('tools/call', {
    name: 'jlc_ecad_update_team_member_role',
    arguments: { teamUuid: 't1', memberUuid: 'm1', role: 'admin' },
  });
  assert.equal(role.result.isError, undefined, role.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/members/m1/update');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { role: 'admin' });

  const remark = await client.request('tools/call', {
    name: 'jlc_ecad_update_team_member_remark',
    arguments: { teamUuid: 't1', memberUuid: 'm1', remark: 'lead' },
  });
  assert.equal(remark.result.isError, undefined, remark.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/updateRemark');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { uuid: 'm1', remark: 'lead' });

  const info = await client.request('tools/call', {
    name: 'jlc_ecad_get_team_info',
    arguments: { teamUuid: 't1' },
  });
  assert.equal(info.result.isError, undefined, info.result.content[0].text);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/teamInfo');

  const updated = await client.request('tools/call', {
    name: 'jlc_ecad_update_team',
    arguments: { teamUuid: 't1', nickname: 'New', introduction: 'hi' },
  });
  assert.equal(updated.result.isError, undefined, updated.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/update');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { nickname: 'New', introduction: 'hi' });

  const logs = await client.request('tools/call', {
    name: 'jlc_ecad_get_team_logs',
    arguments: { teamUuid: 't1', search: 'x', startTime: 1, endTime: 2, sort: 'desc' },
  });
  assert.equal(logs.result.isError, undefined, logs.result.content[0].text);
  assert.match(logs.result.content[0].text, /log-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/logs?search=x&startTime=1&endTime=2&sort=desc');

  const beforeRemove = requests.length;
  const deniedRemove = await client.request('tools/call', {
    name: 'jlc_ecad_remove_team_member',
    arguments: { teamUuid: 't1', memberUuid: 'm1', remove_project_member: 'false' },
  });
  assert.equal(deniedRemove.result.isError, true);
  assert.match(deniedRemove.result.content[0].text, /__confirm/);
  assert.equal(requests.length, beforeRemove);

  const removed = await client.request('tools/call', {
    name: 'jlc_ecad_remove_team_member',
    arguments: { teamUuid: 't1', memberUuid: 'm1', remove_project_member: 'false', __confirm: true },
  });
  assert.equal(removed.result.isError, undefined, removed.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/members/remove');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { uuid: 'm1', remove_project_member: 'false' });

  const beforeTransfer = requests.length;
  const deniedTransfer = await client.request('tools/call', {
    name: 'jlc_ecad_transfer_team',
    arguments: { teamUuid: 't1', newOwnerUuid: 'u2' },
  });
  assert.equal(deniedTransfer.result.isError, true);
  assert.equal(requests.length, beforeTransfer);

  const transferred = await client.request('tools/call', {
    name: 'jlc_ecad_transfer_team',
    arguments: { teamUuid: 't1', newOwnerUuid: 'u2', __confirm: true },
  });
  assert.equal(transferred.result.isError, undefined, transferred.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/transfer');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { uuid: 'u2' });

  const beforeDelete = requests.length;
  const deniedDelete = await client.request('tools/call', {
    name: 'jlc_ecad_delete_team',
    arguments: { teamUuid: 't1' },
  });
  assert.equal(deniedDelete.result.isError, true);
  assert.equal(requests.length, beforeDelete);

  const deleted = await client.request('tools/call', {
    name: 'jlc_ecad_delete_team',
    arguments: { teamUuid: 't1', __confirm: true },
  });
  assert.equal(deleted.result.isError, undefined, deleted.result.content[0].text);
  assert.equal(requests.at(-1).url, '/api/editor/teams/t1/delete');
  assert.equal(requests.at(-1).body, '{}');

  await client.close();
}

// 19) Web-only user profile, agreement, logs, and search tools.
{
  const client = makeClient({ JLC_ECAD_COOKIE: 'VEN-SESSION=valid' });
  await client.request('initialize', initialize);
  client.notify('notifications/initialized', {});

  const agreement = await client.request('tools/call', {
    name: 'jlc_ecad_accept_user_agreement',
    arguments: {},
  });
  assert.equal(agreement.result.isError, undefined, agreement.result.content[0].text);
  assert.match(agreement.result.content[0].text, /agreed/);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/user/agreement');
  assert.equal(requests.at(-1).body, '{}');

  const logs = await client.request('tools/call', {
    name: 'jlc_ecad_get_user_logs',
    arguments: { page: 1, pageSize: 10, sort: 'desc' },
  });
  assert.equal(logs.result.isError, undefined, logs.result.content[0].text);
  assert.match(logs.result.content[0].text, /log-1/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/user/logs?page=1&pageSize=10&sort=desc');

  const search = await client.request('tools/call', {
    name: 'jlc_ecad_search_users',
    arguments: { q: 42, limit: 5 },
  });
  assert.equal(search.result.isError, undefined, search.result.content[0].text);
  assert.match(search.result.content[0].text, /user-2/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/user/search?q=42&limit=5');

  const updated = await client.request('tools/call', {
    name: 'jlc_ecad_update_user',
    arguments: { nickname: 'Demo', avatar: 'avatar.png' },
  });
  assert.equal(updated.result.isError, undefined, updated.result.content[0].text);
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).url, '/api/editor/user/update');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { nickname: 'Demo', avatar: 'avatar.png' });

  const byUuid = await client.request('tools/call', {
    name: 'jlc_ecad_get_user_by_uuid',
    arguments: { uuid: 'u/2' },
  });
  assert.equal(byUuid.result.isError, undefined, byUuid.result.content[0].text);
  assert.match(byUuid.result.content[0].text, /u\/2/);
  assert.equal(requests.at(-1).method, 'GET');
  assert.equal(requests.at(-1).url, '/api/editor/user/u%2F2');

  await client.close();
}

mock.close();
console.log(`smoke test passed (${requests.length} API requests)`);
