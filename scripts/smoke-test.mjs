/**
 * End-to-end smoke test for the stdio MCP server.
 *
 * Starts a local mock of the JLC editor/cas endpoints, launches
 * dist/index.js as a child process, and verifies:
 *   1. the MCP handshake, tool listing, and logged-out 401 guidance,
 *   2. JLC_ECAD_COOKIE is forwarded,
 *   3. a session file with a "cookies" object is forwarded,
 *   4. a raw gzip response is decoded,
 *   5. the CLI `login` command succeeds with a valid current session (no Chrome),
 *   6. the MCP `jlc_ecad_login` tool does the same,
 *   7. the CLI `login` falls back to the editor cookie snapshot,
 *   8. the CLI `login` falls back to passport cookies + check-login,
 *   9. `login --cookie` saves the session under JLC_ECAD_HOME,
 *  10. `logout` removes current and legacy credential files.
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
  requests.push({ url: req.url, cookie });

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
  assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ['jlc_ecad_get_user', 'jlc_ecad_login'].sort());

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

// 5) CLI `login`: valid current session -> success without Chrome.
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

// 6) MCP `jlc_ecad_login`: valid current session -> no Chrome.
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

  const loginCall = await client.request('tools/call', { name: 'jlc_ecad_login', arguments: {} });
  assert.equal(loginCall.result.isError, undefined);
  assert.match(loginCall.result.content[0].text, /Already signed in/);

  const call = await callTool(client);
  assert.equal(call.result.isError, undefined, call.result.content[0].text);
  assert.match(requests.at(-1).cookie, /VEN-SESSION=valid/);
  await client.close();
}

// 7) CLI `login`: missing session -> editor cookie snapshot -> session saved.
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

// 8) CLI `login`: no saved session/editor cookies -> passport cookies + check-login.
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

// 9) `login --cookie` saves the session under JLC_ECAD_HOME.
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

// 10) `logout` removes current and legacy credential files.
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

mock.close();
console.log(`smoke test passed (${requests.length} API requests)`);
