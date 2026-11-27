#!/usr/bin/env node
/**
 * End-to-end usability test for every tool exposed by the MCP server.
 *
 * Read-only tools are called with harvested real IDs. Write tools are tested
 * through disposable resources created by this script (create → read/update →
 * delete), so existing account data is never modified. Destructive tools are
 * always called with `__confirm: true` only against resources created here.
 *
 * A few outward-facing / irreversible tools are intentionally not executed:
 * `jlc_ecad_order_part_bom` (places a real purchase order) and
 * `jlc_ecad_logout` (would invalidate the session needed by the rest of the
 * run). Their confirmation gate is still verified.
 *
 * Usage:
 *   pnpm run build
 *   npx tsx scripts/test-all-tools.ts
 *
 * Output:
 *   docs/tool-test-results/<run-id>/report.md
 *   docs/tool-test-results/<run-id>/report.json
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRequest } from '../src/api/client.js';
import type { EcadToolDefinition } from '../src/ecad/types.js';
import { ECAD_TOOLS } from '../src/tools/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = `${REPO_ROOT}dist/index.js`;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = `${REPO_ROOT}docs/tool-test-results/${RUN_ID}`;
const CALL_TIMEOUT_MS = 30_000;
const PAUSE_MS = 120;
const HR = '---';

const CATALOG = new Map<string, EcadToolDefinition>(ECAD_TOOLS.map((tool) => [tool.name, tool]));

type Status = 'OK' | 'GATE_OK' | 'FAIL' | 'BLOCKED' | 'SKIPPED' | 'NOT_RUN';

interface ToolRecord {
  name: string;
  source: 'imported' | 'hand-written';
  endpoint: string;
  danger: boolean;
  status: Status;
  category: string;
  detail: string;
  note: string;
  ms: number;
  calls: number;
  gate: 'OK' | 'FAIL' | 'NOT_RUN';
}

interface CallOutcome {
  status: 'OK' | 'GATE_OK' | 'FAIL';
  detail: string;
  text: string;
  ms: number;
  errorKind?: string;
}

interface CallLogEntry {
  name: string;
  args: string;
  status: string;
  detail: string;
  ms: number;
}

interface TempResource {
  kind: string;
  uuid?: string;
  name?: string;
  removed: boolean;
}

interface HarvestIds {
  userUuid?: string;
  projectUuid?: string;
  branchUuid?: string;
  projectHistoryUuid?: string;
  formUuid?: string;
  formHistoryUuid?: string;
  layerUuid?: string;
  layerName?: string;
  libraryUuid?: string;
  symbolUuid?: string;
  symbolHistoryUuid?: string;
  macroUuid?: string;
  macroName?: string;
  plotFrameUuid?: string;
  plotFrameHistoryUuid?: string;
  teamUuid?: string;
  categoryUuid?: string;
  partUuid?: string;
  partName?: string;
  drillUuid?: string;
  accessoryUuid?: string;
  preferenceHistoryUuid?: string;
  productCatalogId?: number;
  user?: any;
}

// ---------------------------------------------------------------------------
// MCP stdio client
// ---------------------------------------------------------------------------

interface JsonRpcClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  close(): void;
}

function startServer(): JsonRpcClient {
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr.resume();

  return {
    request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ __timeout: true });
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    close() {
      child.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(text: string, limit = 320): string {
  const masked = text
    .replace(/[0-9a-f]{32}/gi, '<uuid>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/"(username|nickname|owner_uuid|ownerUuid|avatar|email|phone|token|cookie)":\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .replace(/"(name|title)":\s*"[^"]{1,120}"/gi, '"$1":"<redacted>"');
  return masked.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, limit);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarize(text: string): string {
  const json = parseJson(text);
  if (Array.isArray(json)) return `array(${json.length})`;
  if (json && typeof json === 'object') {
    if (json.success === false) return `success=false code=${json.code ?? '?'}`;
    const keys = Object.keys(json).slice(0, 8).join(',');
    const payload = json.result ?? json.data;
    if (Array.isArray(payload)) return `result=array(${payload.length})`;
    if (payload && typeof payload === 'object') {
      return `result={${Object.keys(payload).slice(0, 8).join(',')}}`;
    }
    return `keys=${keys}`;
  }
  return clean(text, 180);
}

function deepFindUuid(value: any, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 8) return undefined;
  if (typeof value.uuid === 'string' && /^[0-9a-f]{16,64}$/i.test(value.uuid)) return value.uuid;
  for (const item of Object.values(value)) {
    const found = deepFindUuid(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function deepFindKey(value: any, key: string, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 8) return undefined;
  if (value[key] !== undefined) return value[key];
  for (const item of Object.values(value)) {
    const found = deepFindKey(item, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function deepFindArray(value: any, depth = 0): any[] | undefined {
  if (!value || typeof value !== 'object' || depth > 8) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && /^(lists?|data|result|records?|items)$/i.test(key)) return item;
  }
  for (const item of Object.values(value)) {
    const found = deepFindArray(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findRecordUuid(text: string): string | undefined {
  const json = parseJson(text);
  return deepFindUuid(json);
}

function tmpName(prefix: string): string {
  return `mcp-audit-${RUN_ID.slice(-6)}-${prefix}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const clientRef: { current?: JsonRpcClient } = {};
const tools: any[] = [];
const records = new Map<string, ToolRecord>();
const callLog: CallLogEntry[] = [];
const tempResources: TempResource[] = [];
const tempUuids = new Set<string>();
const tempNames = new Set<string>();
const cleanupTasks: Array<{ label: string; run: () => Promise<void> }> = [];
const leftovers: string[] = [];
let cleanupRan = false;

const ids: HarvestIds = {};
const harvestLog: Array<{ item: string; status: string; detail: string }> = [];
let tempLibraryUuid: string | undefined;

function registerTool(tool: any): void {
  const catalogTool = CATALOG.get(tool.name);
  records.set(tool.name, {
    name: tool.name,
    source: catalogTool ? 'imported' : 'hand-written',
    endpoint: catalogTool ? `${catalogTool.method} ${catalogTool.path}` : '—',
    danger: catalogTool ? catalogTool.danger : tool.annotations?.destructiveHint === true,
    status: 'NOT_RUN',
    category: '',
    detail: '',
    note: '',
    ms: 0,
    calls: 0,
    gate: 'NOT_RUN',
  });
}

function remember(kind: string, uuid: string | undefined, name?: string): void {
  if (!uuid) return;
  tempUuids.add(uuid);
  if (name) tempNames.add(name);
  tempResources.push({ kind, uuid, name, removed: false });
}

function markRemoved(uuidOrName: string | undefined): void {
  if (!uuidOrName) return;
  for (const resource of tempResources) {
    if (resource.uuid === uuidOrName || resource.name === uuidOrName) resource.removed = true;
  }
}

function record(name: string, outcome: CallOutcome, category: string, note = ''): ToolRecord | undefined {
  const existing = records.get(name);
  if (!existing) return undefined;
  existing.status = outcome.status;
  existing.detail = outcome.detail;
  existing.ms = outcome.ms;
  existing.calls += 1;
  existing.category = category;
  if (note) existing.note = note;
  return existing;
}

function recordBlocked(name: string, reason: string, category = 'prerequisite'): void {
  const existing = records.get(name);
  if (!existing) return;
  if (existing.status === 'OK' || existing.status === 'FAIL') return;
  existing.status = 'BLOCKED';
  existing.detail = clean(reason, 220);
  existing.category = category;
}

function recordSkipped(name: string, reason: string): void {
  const existing = records.get(name);
  if (!existing) return;
  if (existing.status === 'OK' || existing.status === 'FAIL' || existing.status === 'BLOCKED') return;
  existing.status = 'SKIPPED';
  existing.detail = clean(reason, 220);
  existing.category = 'skipped';
}

async function callTool(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<CallOutcome> {
  const startedAt = Date.now();
  const message = await clientRef.current!.request('tools/call', { name, arguments: args }, timeoutMs);
  const ms = Date.now() - startedAt;
  let outcome: CallOutcome;

  if (!message) {
    outcome = { status: 'FAIL', detail: 'no JSON-RPC response', text: '', ms, errorKind: 'NO_RESPONSE' };
  } else if (message.__timeout) {
    outcome = { status: 'FAIL', detail: `no response within ${timeoutMs}ms`, text: '', ms, errorKind: 'TIMEOUT' };
  } else if (message.error) {
    outcome = { status: 'FAIL', detail: JSON.stringify(message.error), text: '', ms, errorKind: 'RPC_ERROR' };
  } else {
    const result = message.result ?? {};
    const text = Array.isArray(result.content)
      ? result.content.map((block: any) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('\n')
      : '';
    if (!result.isError) {
      if (/requires explicit user confirmation|is destructive\. Ask the user for confirmation/i.test(text)) {
        outcome = { status: 'GATE_OK', detail: 'confirmation gate responded as expected', text, ms, errorKind: 'GATE' };
      } else {
        outcome = { status: 'OK', detail: summarize(text), text, ms };
      }
    } else {
      // Destructive confirmation is returned with isError: true; it is the
      // expected response to a call without __confirm, not a failure.
      if (/is destructive\. Ask the user for confirmation/i.test(text)) {
        outcome = { status: 'GATE_OK', detail: 'confirmation gate responded as expected', text, ms, errorKind: 'GATE' };
      } else {
        let errorKind = 'API_ERROR';
        if (/Not logged in|HTTP 401|code.?401/i.test(text)) errorKind = 'AUTH';
        else if (/HTTP (?:4|5)\d\d/.test(text)) errorKind = 'HTTP_ERROR';
        else if (/timed out/i.test(text)) errorKind = 'TIMEOUT';
        else if (/Failed to reach|fetch failed/i.test(text)) errorKind = 'UNREACHABLE';
        else if (/validation error|Invalid arguments/i.test(text)) errorKind = 'VALIDATION';
        else if (/Missing required path parameter/i.test(text)) errorKind = 'VALIDATION';
        outcome = { status: 'FAIL', detail: clean(text, 380), text, ms, errorKind };
      }
    }
  }

  callLog.push({ name, args: clean(JSON.stringify(args), 300), status: outcome.status, detail: outcome.detail, ms });
  await sleep(PAUSE_MS);
  return outcome;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  category: string,
  options: { timeoutMs?: number; note?: string } = {},
): Promise<CallOutcome> {
  // Lifecycle tests only ever target resources created by this run. Destructive
  // tools therefore always carry the confirmation flag; the gate itself is
  // verified separately by gatePass(), which calls callTool() directly.
  const entry = records.get(name);
  const effectiveArgs = entry?.danger && args.__confirm === undefined ? { ...args, __confirm: true } : args;
  const outcome = await callTool(name, effectiveArgs, options.timeoutMs);
  if (entry) {
    entry.status = outcome.status;
    entry.detail = outcome.detail;
    entry.ms = outcome.ms;
    entry.calls += 1;
    entry.category = category;
    if (options.note) entry.note = options.note;
  }
  return outcome;
}

/// Safe delete/update guard: only IDs or names created by this run may be used.
function assertTemp(uuidOrName: string | undefined): boolean {
  if (!uuidOrName) return false;
  return tempUuids.has(uuidOrName) || tempNames.has(uuidOrName);
}

/**
 * Some editor endpoints write history/snapshot data as a raw stream rather than
 * JSON. Try the declared JSON call first, then the raw-body form the frontend
 * uses. Both calls target only resources created by this run.
 */
async function runWithRawFallback(
  name: string,
  args: Record<string, unknown>,
  raw: string,
  category: string,
  note: string,
  contentType = 'application/json',
): Promise<CallOutcome> {
  const first = await runTool(name, args, category, { note });
  if (first.status === 'OK') return first;
  return runTool(
    name,
    {
      ...args,
      __rawBodyBase64: Buffer.from(raw).toString('base64'),
      __contentType: contentType,
    },
    category,
    { note: `${note} · raw-body fallback` },
  );
}

// ---------------------------------------------------------------------------
// Harvest (read-only)
// ---------------------------------------------------------------------------

async function probe(item: string, path: string, options: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}): Promise<any> {
  try {
    const response = await apiRequest({
      method: (options.method as any) ?? 'GET',
      path,
      query: options.query as any,
      body: options.body,
      retryTool: 'tool-test',
    });
    harvestLog.push({ item, status: 'OK', detail: `HTTP ${response.httpStatus}` });
    return response.data as any;
  } catch (error: any) {
    harvestLog.push({ item, status: 'ERR', detail: clean(String(error?.message ?? error), 160) });
    return undefined;
  }
}

async function harvest(): Promise<void> {
  const user = await probe('user', '/api/editor/user');
  ids.user = user?.result;
  ids.userUuid = user?.result?.uuid;
  ids.preferenceHistoryUuid = user?.result?.preference_history_uuid;

  const projects = await probe('project list', '/api/editor/projects', { query: { page: 1, pageSize: 10 } });
  ids.projectUuid = projects?.result?.lists?.[0]?.uuid ?? projects?.result?.data?.[0]?.uuid;
  if (ids.projectUuid) {
    const detail = await probe('project detail', `/api/editor/projects/${ids.projectUuid}`);
    ids.branchUuid = detail?.result?.branch_uuid ?? detail?.result?.branchUuid;
    if (ids.branchUuid) {
      const branches = await probe('project branches', `/api/editor/projects/${ids.projectUuid}/branches`);
      const branch = branches?.result?.lists?.[0] ?? branches?.result?.[0];
      ids.branchUuid = branch?.uuid ?? ids.branchUuid;
      const branchDetail = await probe('branch detail', `/api/editor/projects/${ids.projectUuid}/branches/${ids.branchUuid}`);
      ids.projectHistoryUuid = branchDetail?.result?.history_uuid ?? branchDetail?.result?.historyUuid;
    }
  }

  if (ids.userUuid) {
    for (const type of [2, 6, 18, 26, 27]) {
      const forms = await probe('form list', '/api/editor/forms/list', {
        query: { ownerUuid: ids.userUuid, type, page: 1, pageSize: 100 },
      });
      const form = forms?.result?.list?.[0] ?? forms?.result?.lists?.[0];
      if (form?.uuid) {
        ids.formUuid = form.uuid;
        ids.formHistoryUuid = form.history_uuid ?? form.historyUuid;
        break;
      }
    }
  }

  if (ids.userUuid) {
    const libraries = await probe('library list', '/api/editor/libraries/symbols', {
      query: { ownerUuid: ids.userUuid, page: 1, pageSize: 10 },
    });
    const library = libraries?.result?.data?.[0] ?? libraries?.result?.list?.[0];
    ids.libraryUuid = library?.uuid;
    if (ids.libraryUuid) {
      const symbols = await probe('symbol list', '/api/editor/symbols', {
        query: { ownerUuid: ids.libraryUuid, page: 1, pageSize: 10 },
      });
      const symbol = symbols?.result?.data?.[0] ?? symbols?.result?.list?.[0];
      ids.symbolUuid = symbol?.uuid;
      if (ids.symbolUuid) {
        const symbolDetail = await probe('symbol detail', `/api/editor/symbols/${ids.symbolUuid}`);
        ids.symbolHistoryUuid = symbolDetail?.result?.history_uuid ?? symbolDetail?.result?.historyUuid;
      }
    }
  }

  if (ids.userUuid) {
    const macros = await probe('macro list', `/api/editor/macro/${ids.userUuid}`);
    const macro = macros?.result?.[0] ?? macros?.[0];
    ids.macroUuid = macro?.uuid;
    ids.macroName = macro?.name;
  }

  if (ids.userUuid) {
    const frames = await probe('plot frame list', '/api/editor/plotFrames', {
      query: { ownerUuid: ids.userUuid, page: 1, pageSize: 10 },
    });
    const frame = frames?.result?.data?.[0] ?? frames?.result?.list?.[0];
    ids.plotFrameUuid = frame?.uuid;
  }

  if (ids.userUuid) {
    const layers = await probe('layer list', `/api/editor/layer/${ids.userUuid}`);
    const layer = layers?.result?.[0] ?? layers?.[0];
    ids.layerUuid = layer?.uuid;
    ids.layerName = layer?.layer ?? layer?.name;
  }

  const teams = await probe('team list', '/api/editor/teams', { query: { page: '1', pageSize: '10' } });
  ids.teamUuid = teams?.result?.lists?.[0]?.uuid;

  if (ids.userUuid) {
    const categories = await probe('category list', '/api/editor/categories', {
      query: { user_uuid: ids.userUuid, 'type[]': 6 },
    });
    ids.categoryUuid = categories?.result?.[0]?.uuid;
  }

  if (ids.userUuid) {
    const parts = await probe('part list', '/api/editor/parts/list', {
      method: 'POST',
      body: {
        ownerUuid: ids.userUuid,
        type: 1,
        category: [['22138', '1']],
        attrIds: ['22024', '22001', '22004', '22009'],
        keyword: '',
        page: 1,
        pageSize: 100,
      },
    });
    const part = parts?.result?.list?.[0] ?? parts?.result?.data?.[0];
    ids.partUuid = part?.uuid;
    ids.partName = part?.name;
  }

  const tree = await probe('product tree', '/api/editor/product/tree');
  const catalogId = deepFindKey(tree, 'catalogId');
  if (typeof catalogId === 'number') ids.productCatalogId = catalogId;
}

// ---------------------------------------------------------------------------
// Read-only argument generation
// ---------------------------------------------------------------------------

const OPTIONAL_ARG_KEYS =
  /^(page|pageSize|ownerUuid|owner_uuid|ownerUuids|type|accessory|keyword|search|catalog|param|sort|startTime|endTime|q|limit)$/;

function idFor(name: string, toolName: string): string | undefined {
  if (/^(ownerUuid|owner_uuid|userUuid|user_uuid|memberUuid|ownerUuids)$/.test(name)) return ids.userUuid;
  if (name === 'projectUuid') return ids.projectUuid ?? ids.userUuid;
  if (name === 'branchUuid') return ids.branchUuid ?? ids.projectUuid ?? ids.userUuid;
  if (name === 'formUuid') return ids.formUuid ?? ids.userUuid;
  if (name === 'partUuid') return ids.partUuid ?? ids.userUuid;
  if (name === 'drillUuid') return ids.drillUuid ?? ids.partUuid ?? ids.userUuid;
  if (name === 'teamUuid') return ids.teamUuid ?? ids.userUuid;
  if (name === 'newOwnerUuid') return ids.userUuid;
  if (name === 'categoryUuid' || name === 'parent_uuid' || name === 'parentUuid') {
    return ids.categoryUuid ?? ids.userUuid;
  }
  if (name === 'layer') return ids.layerName ?? tmpName('layer');
  if (name === 'name' && toolName === 'macro_macro_detail_by_name') return ids.macroName ?? tmpName('macro');
  if (name === 'historyUuid') {
    if (toolName.startsWith('form_')) return ids.formHistoryUuid ?? ids.formUuid ?? ids.userUuid;
    if (toolName.startsWith('symbol_')) return ids.symbolHistoryUuid ?? ids.symbolUuid ?? ids.userUuid;
    if (toolName.startsWith('project_')) return ids.projectHistoryUuid ?? ids.branchUuid ?? ids.projectUuid ?? ids.userUuid;
    if (toolName.startsWith('plot_frame_')) return ids.plotFrameHistoryUuid ?? ids.plotFrameUuid ?? ids.userUuid;
    if (toolName.startsWith('user_preference')) return ids.preferenceHistoryUuid ?? ids.userUuid;
    return ids.userUuid;
  }
  if (name === 'uuid' || name === 'uuids') {
    if (toolName.startsWith('form_')) return ids.formUuid ?? ids.userUuid;
    if (toolName.startsWith('layer_')) return ids.layerUuid ?? ids.userUuid;
    if (toolName.startsWith('library_')) return ids.libraryUuid ?? ids.userUuid;
    if (toolName.startsWith('macro_')) return ids.macroUuid ?? ids.userUuid;
    if (toolName.startsWith('plot_frame_')) return ids.plotFrameUuid ?? ids.userUuid;
    if (toolName.startsWith('project_')) return ids.projectUuid ?? ids.userUuid;
    if (toolName.startsWith('symbol_')) return ids.symbolUuid ?? ids.userUuid;
    if (toolName.startsWith('part_')) return ids.partUuid ?? ids.userUuid;
    if (toolName.startsWith('user_')) return ids.userUuid;
    if (toolName === 'jlc_ecad_get_part_production') return ids.partUuid ?? ids.userUuid;
    return ids.userUuid;
  }
  return undefined;
}

function pickValue(name: string, schema: any, toolName: string): unknown {
  const id = idFor(name, toolName);
  if (id !== undefined) {
    const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
    return type === 'array' ? [id] : id;
  }
  if (!schema || typeof schema !== 'object') return 'test';
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return pickValue(name, schema.anyOf[0], toolName);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return pickValue(name, schema.oneOf[0], toolName);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'array') {
    const count = Math.max(1, Number(schema.minItems) || 1);
    return Array.from({ length: Math.min(count, 2) }, () => pickValue(name, schema.items ?? {}, toolName));
  }
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') {
    if (/^(startTime|endTime)$/i.test(name)) return Date.now();
    if (/^pageSize$/i.test(name)) return 10;
    if (/^(pageNum|page)$/i.test(name)) return 1;
    return 1;
  }
  if (type === 'object') {
    const object: Record<string, unknown> = {};
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      object[key] = pickValue(key, schema.properties?.[key] ?? {}, toolName);
    }
    return object;
  }
  if (type === 'string') {
    if (/^(sort|order)$/i.test(name)) return 'desc';
    if (/email/i.test(name)) return 'audit@example.com';
    if (/url/i.test(name)) return 'https://example.com';
    if (/path/i.test(name)) return '/';
    if (/role/i.test(name)) return 'member';
    if (/filename/i.test(name)) return 'audit.json';
    if (/catalog/i.test(name) && ids.productCatalogId) return String(ids.productCatalogId);
    if (/^(keyword|search|query|name|title|q|type)$/i.test(name)) return 'test';
    return 'test';
  }
  return 'test';
}

function buildArgs(tool: any): Record<string, unknown> {
  const schema = tool.inputSchema ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const args: Record<string, unknown> = {};
  const names = new Set(required);
  for (const name of Object.keys(schema.properties ?? {})) {
    if (OPTIONAL_ARG_KEYS.test(name)) names.add(name);
  }
  for (const name of names) args[name] = pickValue(name, schema.properties?.[name] ?? {}, tool.name);
  return args;
}

function buildArgsFor(tool: any): Record<string, unknown> {
  const name = tool.name;
  const user = ids.userUuid;
  switch (name) {
    case 'jlc_ecad_get_user_logs':
      return { page: 1, pageSize: 10, startTime: Date.now() - 30 * 86_400_000, endTime: Date.now(), sort: 'desc' };
    case 'jlc_ecad_search_users':
      // The hand-written schema types `q` as an integer; keep it numeric so
      // the tool accepts the call, then observe what the API does with it.
      return { q: 1, limit: 10 };
    case 'jlc_ecad_get_user_by_uuid':
      return { uuid: user };
    case 'jlc_ecad_search_components':
      return { path: '/', uuids: [] };
    case 'jlc_ecad_search_devices':
      return { uuids: [] };
    case 'jlc_ecad_search_public_parts':
      return { keyword: 'resistor', type: 1, page: 1, pageSize: 10 };
    case 'jlc_ecad_get_product_filters':
    case 'jlc_ecad_list_products':
      return {
        pageNum: 1,
        pageSize: 10,
        catalog: String(ids.productCatalogId ?? 88),
        param: '',
        keyword: '',
        piceSort: '',
        stockSort: '',
      };
    case 'jlc_ecad_list_products_post':
      return { pageNum: 1, pageSize: 10, keyword: '' };
    case 'jlc_ecad_list_categories':
      return { user_uuid: user, type: [6] };
    case 'jlc_ecad_list_teams':
      return { page: 1, pageSize: 10, type: '0', form: '0' };
    case 'jlc_ecad_get_team_logs':
      return { teamUuid: ids.teamUuid ?? user, search: '', startTime: Date.now() - 30 * 86_400_000, endTime: Date.now(), sort: 'desc' };
    case 'jlc_ecad_get_team_info':
      return { teamUuid: ids.teamUuid ?? user };
    case 'jlc_ecad_get_part_production':
      return { partUuid: ids.partUuid ?? user };
    case 'form_get_form_list':
      return { ownerUuid: user, 'formExts[]': [6], page: 1, pageSize: 10 };
    case 'form_get_form_detail':
      return { uuid: ids.formUuid ?? user, ownerUuid: user, type: 6 };
    case 'form_check_form_name':
      return { name: tmpName('form-check'), ownerUuid: user, type: 6 };
    case 'form_search_form_history_list':
      return { formUuid: ids.formUuid ?? user, historyUuid: ids.formHistoryUuid ?? user };
    case 'part_list_parts':
      return {
        ownerUuid: user,
        type: 1,
        category: [['22138', '1']],
        attrIds: ['22024', '22001', '22004', '22009'],
        keyword: '',
        page: 1,
        pageSize: 10,
        accessory: 0,
      };
    case 'part_get_part_categories':
      return { ownerUuid: user, category: ['22001'], accessory: 1, type: 1 };
    case 'part_get_part_list':
      return {
        ownerUuid: user,
        type: 1,
        category: [['22138', '1']],
        attrIds: ['22024', '22001', '22004', '22009'],
        keyword: '',
        page: 1,
        pageSize: 10,
        accessory: 0,
      };
    case 'part_get_part_by_name':
      return { name: ids.partName ?? tmpName('part-read'), ownerUuid: user, type: 1, variable: 1, minVariable: false };
    case 'part_data_exists':
      return { owner_uuid: user, name: ids.partName ?? tmpName('part-read'), type: 1, variable: 1 };
    case 'part_detail_part':
      return { uuid: ids.partUuid ?? user };
    case 'part_list_accessories':
      return { partUuid: ids.partUuid ?? user };
    case 'part_list_templates':
      return { partUuid: ids.partUuid ?? user };
    case 'part_list_drill_cut':
      return { drillUuid: ids.drillUuid ?? user };
    case 'macro_macro_detail_by_name':
      return { name: ids.macroName ?? tmpName('macro-read'), ownerUuid: user };
    case 'macro_macro_exists':
      return { uuids: [ids.macroUuid ?? user], ownerUuid: user };
    case 'macro_macro_list_by_owner':
      return { ownerUuid: user };
    case 'layer_layer_detail_by_name':
      return { layer: ids.layerName ?? tmpName('layer-read'), ownerUuid: user };
    case 'plot_frame_plot_frame_list':
      return { ownerUuid: user, page: 1, pageSize: 10 };
    case 'plot_frame_plot_frame_detail':
      return { uuid: ids.plotFrameUuid ?? user };
    case 'plot_frame_search_plot_frame_history_list':
      return { uuid: ids.plotFrameUuid ?? user, historyUuid: ids.plotFrameHistoryUuid ?? user };
    case 'project_history_get_project_history_list':
      return { projectUuid: ids.projectUuid ?? user, branchUuid: ids.branchUuid ?? user, historyUuid: ids.projectHistoryUuid ?? user };
    case 'symbol_symbol_list':
      return { ownerUuid: ids.libraryUuid ?? user, page: 1, pageSize: 10 };
    case 'symbol_symbol_detail':
      return { uuid: ids.symbolUuid ?? user };
    case 'symbol_search_symbol_history_list':
      return { uuid: ids.symbolUuid ?? user, historyUuid: ids.symbolHistoryUuid ?? user };
    case 'user_preference_search_history':
    case 'user_preference_search_history_2':
      return { userUuid: user, historyUuid: ids.preferenceHistoryUuid ?? user };
    case 'team_team_list':
      return { from: '0', page: '1', pageSize: '10' };
    default:
      return buildArgs(tool);
  }
}

const MUTATING_NAME =
  /(^|_)(add|create|update|delete|remove|save|apply|upload|transfer|whitelist|agreement|logout|order|join|accept|snapshot|chunk)(_|$)/;
const SAFE_NAME = /(list|detail|exists|by_name|categories|logs|search|info|status|rights|qrcode|filter|tree|check|read|other_teams)/;

const LIVE_SAFE_HAND_WRITTEN = new Set([
  'jlc_ecad_get_user',
  'jlc_ecad_search_components',
  'jlc_ecad_search_devices',
  'jlc_ecad_get_product_filters',
  'jlc_ecad_list_products',
  'jlc_ecad_list_products_post',
  'jlc_ecad_get_product_tree',
  'jlc_ecad_get_official_account_qrcode',
  'jlc_ecad_get_designer_rights',
  'jlc_ecad_get_member_rights',
  'jlc_ecad_get_beta_status',
  'jlc_ecad_list_categories',
  'jlc_ecad_list_teams',
  'jlc_ecad_get_user_logs',
  'jlc_ecad_search_users',
  'jlc_ecad_get_user_by_uuid',
  'jlc_ecad_get_part_production',
  'jlc_ecad_get_team_logs',
  'jlc_ecad_get_other_teams',
  'jlc_ecad_get_team_info',
  'jlc_ecad_search_public_parts',
]);

function isReadOnlyCandidate(tool: any): boolean {
  const catalogTool = CATALOG.get(tool.name);
  if (!catalogTool) return LIVE_SAFE_HAND_WRITTEN.has(tool.name);
  if (catalogTool.danger) return false;
  if (MUTATING_NAME.test(tool.name)) return false;
  if (catalogTool.method === 'GET') return true;
  return SAFE_NAME.test(tool.name);
}

// ---------------------------------------------------------------------------
// Lifecycle tests (disposable resources only)
// ---------------------------------------------------------------------------

async function testCategory(): Promise<void> {
  if (!ids.userUuid) {
    recordBlocked('jlc_ecad_create_category', 'no user UUID from /api/editor/user');
    recordBlocked('jlc_ecad_update_category', 'no user UUID');
    recordBlocked('jlc_ecad_delete_category', 'no user UUID');
    return;
  }
  const name = tmpName('category');
  const created = await runTool('jlc_ecad_create_category', { name, type: 6, user_uuid: ids.userUuid, order_no: 1000 }, 'create');
  const uuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!uuid) {
    recordBlocked('jlc_ecad_update_category', 'create_category did not return a UUID');
    recordBlocked('jlc_ecad_delete_category', 'create_category did not return a UUID');
    return;
  }
  remember('category', uuid, name);
  ids.categoryUuid = uuid;
  await runTool('jlc_ecad_update_category', { uuid, name: `${name}-u`, order_no: 1001 }, 'update');
  cleanupTasks.push({
    label: `category ${name}`,
    run: async () => {
      if (!assertTemp(uuid)) return;
      const out = await runTool('jlc_ecad_delete_category', { uuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(uuid);
    },
  });
}

async function testTeam(): Promise<void> {
  if (!ids.userUuid) {
    for (const name of [
      'jlc_ecad_create_team',
      'jlc_ecad_update_team',
      'jlc_ecad_add_team_member',
      'jlc_ecad_remove_team_member',
      'jlc_ecad_transfer_team',
      'jlc_ecad_update_team_member_role',
      'jlc_ecad_update_team_member_remark',
      'jlc_ecad_delete_team',
    ]) {
      recordBlocked(name, 'no user UUID');
    }
    return;
  }
  const username = tmpName('team');
  const created = await runTool(
    'jlc_ecad_create_team',
    { username, members: [], nickname: username, introduction: 'temporary team created by the MCP tool test' },
    'create',
  );
  const teamUuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!teamUuid) {
    for (const name of [
      'jlc_ecad_update_team',
      'jlc_ecad_add_team_member',
      'jlc_ecad_remove_team_member',
      'jlc_ecad_transfer_team',
      'jlc_ecad_update_team_member_role',
      'jlc_ecad_update_team_member_remark',
      'jlc_ecad_delete_team',
    ]) {
      recordBlocked(name, 'create_team did not return a UUID');
    }
    return;
  }
  remember('team', teamUuid, username);
  ids.teamUuid = teamUuid;

  await runTool('jlc_ecad_update_team', { teamUuid, nickname: `${username}-u` }, 'update');

  const add = await runTool('jlc_ecad_add_team_member', { teamUuid, memberUuid: ids.userUuid }, 'member');
  const memberAdded = add.status === 'OK';
  if (!memberAdded) {
    const entry = records.get('jlc_ecad_add_team_member');
    if (entry) {
      entry.status = 'BLOCKED';
      entry.detail = 'adding the current user to the temporary team is rejected (code 1000001); needs a second account';
    }
  }
  if (memberAdded) {
    await runTool('jlc_ecad_update_team_member_role', { teamUuid, memberUuid: ids.userUuid, role: 'member' }, 'member');
    await runTool('jlc_ecad_update_team_member_remark', { teamUuid, memberUuid: ids.userUuid, remark: 'mcp audit' }, 'member');
  } else {
    recordBlocked('jlc_ecad_update_team_member_role', 'could not add the current user to the temporary team');
    recordBlocked('jlc_ecad_update_team_member_remark', 'could not add the current user to the temporary team');
  }

  await runTool('jlc_ecad_transfer_team', { teamUuid, newOwnerUuid: ids.userUuid, __confirm: true }, 'transfer', {
    note: 'transfers the temporary team to the same user',
  });

  if (memberAdded) {
    await runTool('jlc_ecad_remove_team_member', { teamUuid, memberUuid: ids.userUuid, remove_project_member: 'false', __confirm: true }, 'member');
  } else {
    recordBlocked('jlc_ecad_remove_team_member', 'current user was not added to the temporary team');
  }

  cleanupTasks.push({
    label: `team ${username}`,
    run: async () => {
      if (!assertTemp(teamUuid)) return;
      const out = await runTool('jlc_ecad_delete_team', { teamUuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(teamUuid);
    },
  });
}

async function testUser(): Promise<void> {
  const user = ids.user ?? {};
  const updated = await runTool('jlc_ecad_update_user', { nickname: user.nickname ?? 'mcp-audit', avatar: user.avatar ?? '' }, 'update', {
    note: 'writes the current nickname/avatar back unchanged',
  });
  if (updated.status !== 'OK') {
    // Keep the failure, but do not attempt other account mutations.
  }
  if (user.privacyAgreed === true) {
    await runTool('jlc_ecad_accept_user_agreement', {}, 'update', {
      note: 'the agreement was already accepted; this is a no-op re-accept',
    });
  } else {
    recordSkipped('jlc_ecad_accept_user_agreement', 'the user agreement is not accepted; accepting it is a legal action');
  }
}

async function testLogin(): Promise<void> {
  const gate = await callTool('jlc_ecad_login', {});
  const real = gate.status === 'GATE_OK' ? await callTool('jlc_ecad_login', { confirm: true }) : gate;
  record('jlc_ecad_login', real, 'auth');
  const existing = records.get('jlc_ecad_login');
  if (existing) existing.gate = gate.status === 'GATE_OK' ? 'OK' : 'FAIL';
  recordSkipped('jlc_ecad_logout', 'would invalidate the session used by the remaining tests');
}

async function testBeta(): Promise<void> {
  await runTool('jlc_ecad_get_beta_status', {}, 'read');
  if (ids.user?.betaVersion) {
    await runTool('jlc_ecad_join_beta_whitelist', {}, 'update', {
      note: 'the account is already in the beta program; this is a no-op re-join',
    });
  } else {
    recordSkipped('jlc_ecad_join_beta_whitelist', 'joining the beta program changes account status and is not reversible here');
  }
}

async function testParts(): Promise<void> {
  if (!ids.userUuid) {
    return;
  }
  const partName = tmpName('part');
  const attributeShapes: Array<Record<string, unknown>> = [
    { '22001': { value: partName }, '22024': { value: '1' } },
    { '22001': { value: partName }, '22024': { value: '1' }, '22138': { value: '1' } },
    { '22001': { value: partName }, '22024': { value: '1' }, '22004': { value: '' }, '22009': { value: '' } },
    { '22001': { value: partName } },
    { '22024': { value: '1' } },
    {},
  ];
  let partUuid: string | undefined;
  let lastCreate: CallOutcome | undefined;
  for (const attributes of attributeShapes) {
    lastCreate = await callTool('part_create_part', {
      owner_uuid: ids.userUuid,
      type: 1,
      accessory: 0,
      isVariable: false,
      attributes,
      __confirm: true,
    });
    partUuid = lastCreate.status === 'OK' ? findRecordUuid(lastCreate.text) : undefined;
    if (partUuid) break;
  }
  if (lastCreate) {
    record('part_create_part', lastCreate, 'create', partUuid ? '' : 'tried type-1 attribute maps with the required 22001/22024 keys first');
  }
  if (!partUuid) {
    for (const name of [
      'part_update_part',
      'part_update_part_attr',
      'part_delete_part_attr',
      'part_add_accessories',
      'part_list_accessories',
      'part_update_accessories',
      'part_delete_accessories',
      'part_add_templates',
      'part_list_templates',
      'part_update_templates',
      'part_delete_templates',
      'part_add_drill_cut',
      'part_list_drill_cut',
      'part_update_drill_cut',
      'part_delete_drill_cut',
      'part_detail_part',
      'part_get_part_by_name',
      'part_data_exists',
      'part_delete_parts',
      'part_delete_part_by_name',
      'jlc_ecad_add_part_production',
      'jlc_ecad_update_part_production',
      'jlc_ecad_delete_part_production',
      'jlc_ecad_get_part_production',
    ]) {
      recordBlocked(name, 'could not create a temporary part');
    }
    // Still exercise the read-only part queries with real request shapes.
    await runTool(
      'part_list_parts',
      {
        ownerUuid: ids.userUuid,
        type: 1,
        category: [['22138', '1']],
        attrIds: ['22024', '22001', '22004', '22009'],
        keyword: '',
        page: 1,
        pageSize: 10,
        accessory: 0,
      },
      'read',
      { note: 'frontend-compatible parameter shape' },
    );
    await runTool('part_get_part_categories', { ownerUuid: ids.userUuid, category: ['22001'], accessory: 1, type: 1 }, 'read');
    await runTool(
      'part_get_part_list',
      {
        ownerUuid: ids.userUuid,
        type: 1,
        category: [['22138', '1']],
        attrIds: ['22024', '22001', '22004', '22009'],
        keyword: '',
        page: 1,
        pageSize: 10,
        accessory: 0,
      },
      'read',
    );
    await runTool('part_get_part_by_name', { name: partName, ownerUuid: ids.userUuid, type: 1 }, 'read');
    await runTool('part_data_exists', { owner_uuid: ids.userUuid, name: partName, type: 1 }, 'read');
    return;
  }

  remember('part', partUuid, partName);
  ids.partUuid = partUuid;
  ids.partName = partName;

  // Register parent deletions first so that, after the LIFO reverse, they run
  // after the child cleanup (production tabs, cuts, accessories, templates).
  // The variables are captured by reference and filled in later.
  let drillUuidForCleanup: string | undefined;
  let secondUuidForCleanup: string | undefined;
  let secondNameForCleanup: string | undefined = `${partName}-byname`;
  cleanupTasks.push({
    label: `main part ${partName}`,
    run: async () => {
      if (!assertTemp(partUuid)) return;
      const out = await runTool('part_delete_parts', { uuids: [partUuid], __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(partUuid);
    },
  });
  cleanupTasks.push({
    label: `drill part ${partName}`,
    run: async () => {
      if (!drillUuidForCleanup || !assertTemp(drillUuidForCleanup)) return;
      const out = await runTool('part_delete_parts', { uuids: [drillUuidForCleanup], __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(drillUuidForCleanup);
    },
  });
  cleanupTasks.push({
    label: `part by name ${secondNameForCleanup}`,
    run: async () => {
      if (!secondUuidForCleanup || !assertTemp(secondUuidForCleanup)) return;
      if (!secondNameForCleanup) {
        recordBlocked('part_delete_part_by_name', 'the created part did not expose a retrievable name');
        const out = await runTool('part_delete_parts', { uuids: [secondUuidForCleanup], __confirm: true }, 'delete');
        if (out.status === 'OK') markRemoved(secondUuidForCleanup);
        return;
      }
      const out = await runTool(
        'part_delete_part_by_name',
        { name: secondNameForCleanup, ownerUuid: ids.userUuid, type: 1, variable: 1, __confirm: true },
        'delete',
      );
      if (out.status === 'OK') markRemoved(secondUuidForCleanup);
    },
  });

  // Drill-layout part (type 3).
  let drillUuid: string | undefined;
  const drillCreate = await callTool('part_create_part', {
    owner_uuid: ids.userUuid,
    type: 3,
    attributes: { '22931': { value: '1' } },
    __confirm: true,
  });
  if (drillCreate.status === 'OK') {
    drillUuid = findRecordUuid(drillCreate.text);
    if (drillUuid) {
      drillUuidForCleanup = drillUuid;
      remember('part-drill', drillUuid, `${partName}-drill`);
      ids.drillUuid = drillUuid;
      const added = await runTool('part_add_drill_cut', { drillUuid, data: [{ sort: 1, drillType: 'round', positionX: 0, positionY: 0 }] }, 'create');
      const listed = await runTool('part_list_drill_cut', { drillUuid }, 'read');
      const cutUuid = listed.status === 'OK' ? findRecordUuid(listed.text) : undefined;
      if (added.status === 'OK' && cutUuid) {
        await runTool('part_update_drill_cut', { drillUuid, data: [{ uuid: cutUuid, sort: 2 }] }, 'update');
      } else if (added.status !== 'OK') {
        recordBlocked('part_update_drill_cut', 'add_drill_cut did not create a cut');
      } else {
        recordBlocked('part_update_drill_cut', 'add_drill_cut succeeded but the created cut UUID was not readable');
      }
      cleanupTasks.push({
        label: `drill cuts ${partName}`,
        run: async () => {
          if (!assertTemp(drillUuid)) return;
          const out = await runTool('part_delete_drill_cut', { drillUuid, __confirm: true }, 'delete');
          if (out.status === 'OK') markRemoved(`${drillUuid}-cuts`);
        },
      });
    }
  } else {
    recordBlocked('part_add_drill_cut', 'could not create a drill-layout part');
    recordBlocked('part_list_drill_cut', 'could not create a drill-layout part');
    recordBlocked('part_update_drill_cut', 'could not create a drill-layout part');
    recordBlocked('part_delete_drill_cut', 'could not create a drill-layout part');
  }

  // Accessories on the temporary part.
  const addAccessories = await runTool('part_add_accessories', { partUuid, data: [{ sort: 1, allow: 1, oldName: partName }] }, 'create');
  const accList = await runTool('part_list_accessories', { partUuid }, 'read');
  const accessoryUuid = accList.status === 'OK' ? findRecordUuid(accList.text) : undefined;
  if (addAccessories.status === 'OK' && accessoryUuid) {
    await runTool('part_update_accessories', { partUuid, data: [{ uuid: accessoryUuid, sort: 2, allow: 0 }] }, 'update');
  } else if (addAccessories.status !== 'OK') {
    recordBlocked('part_update_accessories', 'add_accessories did not create a record');
  } else {
    recordBlocked('part_update_accessories', 'add_accessories succeeded but the created record UUID was not readable');
  }
  cleanupTasks.push({
    label: `accessories ${partName}`,
    run: async () => {
      if (!assertTemp(partUuid)) return;
      const out = await runTool('part_delete_accessories', { partUuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(`${partUuid}-accessories`);
    },
  });

  // Templates on the temporary part.
  const addTemplates = await runTool('part_add_templates', { partUuid, data: [{ definition: { audit: true }, sort: 1 }] }, 'create');
  const tplList = await runTool('part_list_templates', { partUuid }, 'read');
  const templateUuid = tplList.status === 'OK' ? findRecordUuid(tplList.text) : undefined;
  if (addTemplates.status === 'OK' && templateUuid) {
    await runTool('part_update_templates', { partUuid, data: [{ uuid: templateUuid, definition: { audit: 2 }, sort: 2 }] }, 'update');
  } else if (addTemplates.status !== 'OK') {
    recordBlocked('part_update_templates', 'add_templates did not create a record');
  } else {
    recordBlocked('part_update_templates', 'add_templates succeeded but the created record UUID was not readable');
  }
  cleanupTasks.push({
    label: `templates ${partName}`,
    run: async () => {
      if (!assertTemp(partUuid)) return;
      const out = await runTool('part_delete_templates', { partUuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(`${partUuid}-templates`);
    },
  });

  // Attributes and part header.
  await runTool('part_update_part', { uuid: partUuid, accessory: 0 }, 'update');
  await runTool('part_update_part_attr', { uuid: partUuid, type: 1, attributes: { '22024': { value: 'audit' } } }, 'update');
  await runTool('part_delete_part_attr', { uuid: partUuid, type: 1, attrIds: ['22024'], __confirm: true }, 'delete', {
    note: 'removes an attribute set earlier on the temporary part',
  });

  // Read tools against the temporary part.
  await runTool('part_detail_part', { uuid: partUuid }, 'read');
  await runTool('part_get_part_by_name', { name: partName, ownerUuid: ids.userUuid, type: 1 }, 'read');
  await runTool('part_data_exists', { owner_uuid: ids.userUuid, name: partName, type: 1 }, 'read');
  await runTool(
    'part_get_part_list',
    {
      ownerUuid: ids.userUuid,
      type: 1,
      category: [['22138', '1']],
      attrIds: ['22024', '22001', '22004', '22009'],
      keyword: '',
      page: 1,
      pageSize: 10,
      accessory: 0,
    },
    'read',
  );
  await runTool(
    'part_list_parts',
    {
      ownerUuid: ids.userUuid,
      type: 1,
      category: [['22138', '1']],
      attrIds: ['22024', '22001', '22004', '22009'],
      keyword: '',
      page: 1,
      pageSize: 10,
      accessory: 0,
    },
    'read',
  );
  await runTool('part_get_part_categories', { ownerUuid: ids.userUuid, category: ['22001'], accessory: 1, type: 1 }, 'read');

  // Production tabs.
  const addProd = await runTool('jlc_ecad_add_part_production', { partUuid, data: [{ name: 'audit', offsetX: 0, offsetY: 0, sort: 1 }] }, 'create');
  const prodList = await runTool('jlc_ecad_get_part_production', { partUuid }, 'read');
  const productionUuid = prodList.status === 'OK' ? findRecordUuid(prodList.text) : undefined;
  if (addProd.status === 'OK' && productionUuid) {
    await runTool(
      'jlc_ecad_update_part_production',
      { partUuid, data: [{ uuid: productionUuid, name: 'audit-2', offsetX: 1, offsetY: 1, sort: 2 }] },
      'update',
    );
    cleanupTasks.push({
      label: `production tabs ${partName}`,
      run: async () => {
        if (!assertTemp(partUuid)) return;
        const out = await runTool('jlc_ecad_delete_part_production', { partUuid, uuids: [productionUuid], __confirm: true }, 'delete');
        if (out.status === 'OK') markRemoved(productionUuid);
      },
    });
  } else if (addProd.status !== 'OK') {
    recordBlocked('jlc_ecad_update_part_production', 'add_part_production did not create a record');
    recordBlocked('jlc_ecad_delete_part_production', 'add_part_production did not create a record');
  } else if (!productionUuid) {
    recordBlocked('jlc_ecad_update_part_production', 'add_part_production succeeded but the tab UUID was not readable');
    recordBlocked('jlc_ecad_delete_part_production', 'add_part_production succeeded but the tab UUID was not readable');
  }

  // A second part, deleted by name, exercises part_delete_part_by_name.
  const secondCreate = await callTool('part_create_part', {
    owner_uuid: ids.userUuid,
    type: 1,
    attributes: { '22001': { value: `${partName}-byname` }, '22024': { value: '1' } },
    __confirm: true,
  });
  if (secondCreate.status === 'OK') {
    secondUuidForCleanup = findRecordUuid(secondCreate.text);
    if (secondUuidForCleanup) {
      remember('part', secondUuidForCleanup, `${partName}-byname`);
      const detail = await callTool('part_detail_part', { uuid: secondUuidForCleanup });
      const discovered = deepFindKey(parseJson(detail.text), 'name');
      if (typeof discovered === 'string' && discovered.length > 0) {
        secondNameForCleanup = discovered;
        tempNames.add(discovered);
      } else {
        secondNameForCleanup = undefined;
      }
    }
  }
  if (!secondUuidForCleanup) {
    recordBlocked('part_delete_part_by_name', 'could not create a second temporary part');
  }
}

async function testForms(): Promise<void> {
  if (!ids.userUuid) return;
  const formName = tmpName('form');
  let formUuid: string | undefined;
  let lastCreate: CallOutcome | undefined;
  for (const type of [6, 1, 2]) {
    lastCreate = await callTool('form_create_form', {
      ownerUuid: ids.userUuid,
      name: `${formName}-${type}`,
      type,
      attributes: {},
      __confirm: true,
    });
    formUuid = lastCreate.status === 'OK' ? findRecordUuid(lastCreate.text) : undefined;
    if (formUuid) break;
  }
  if (lastCreate) record('form_create_form', lastCreate, 'create', formUuid ? '' : 'tried form types 6, 1, 2');
  if (!formUuid) {
    for (const name of [
      'form_update_form',
      'form_create_form_history',
      'form_create_form_history_snapshot',
      'form_apply_form_history_snapshot',
      'form_delete_form',
      'form_get_form_detail',
      'form_search_form_history_list',
    ]) {
      recordBlocked(name, 'could not create a temporary form');
    }
    return;
  }
  remember('form', formUuid, formName);
  ids.formUuid = formUuid;

  await runTool('form_update_form', { uuid: formUuid, ownerUuid: ids.userUuid, name: `${formName}-u`, attributes: {} }, 'update');
  await runTool('form_get_form_detail', { uuid: formUuid, ownerUuid: ids.userUuid, type: 6 }, 'read');

  const history = await runWithRawFallback(
    'form_create_form_history',
    { formUuid, dataStr: '{"audit":true}' },
    '{"audit":true}',
    'create',
    'form history payload',
  );
  const historyUuid = history.status === 'OK' ? findRecordUuid(history.text) : undefined;
  if (historyUuid) {
    ids.formHistoryUuid = historyUuid;
    await runWithRawFallback(
      'form_create_form_history_snapshot',
      { formUuid, historyUuid, dataStr: '{"audit":true}' },
      '{"audit":true}',
      'create',
      'form history snapshot',
    );
    await runTool('form_search_form_history_list', { formUuid, historyUuid }, 'read');
  } else {
    recordBlocked('form_create_form_history_snapshot', 'create_form_history did not return a history UUID');
    recordBlocked('form_search_form_history_list', 'create_form_history did not return a history UUID');
  }
  await runWithRawFallback('form_apply_form_history_snapshot', { formUuid }, '', 'update', 'apply form history snapshot');

  const declaredList = await callTool('form_get_form_list', {
    ownerUuid: ids.userUuid,
    'formExts[]': [6],
    page: 1,
    pageSize: 10,
  });
  if (declaredList.status === 'OK') {
    record('form_get_form_list', declaredList, 'read');
  } else {
    // The editor frontend sends `type` (number); the imported schema exposes
    // the illegal property name `formExts[]`, which some MCP clients drop.
    const workaround = await callTool('form_get_form_list', {
      ownerUuid: ids.userUuid,
      type: 6,
      page: 1,
      pageSize: 10,
    });
    if (workaround.status === 'OK') {
      record('form_get_form_list', workaround, 'read', `declared formExts[] fails (${clean(declaredList.detail, 100)}); sending type=6 works`);
    } else {
      record('form_get_form_list', declaredList, 'read');
    }
  }

  cleanupTasks.push({
    label: `forms ${formName}`,
    run: async () => {
      const targets = [formUuid].filter((value): value is string => Boolean(value) && assertTemp(value));
      if (targets.length === 0) return;
      for (const target of targets) {
        const out = await runTool('form_delete_form', { ownerUuid: ids.userUuid, uuid: target, __confirm: true }, 'delete');
        if (out.status === 'OK') {
          markRemoved(target);
          continue;
        }
        const working = await deleteFormFallback(target);
        if (working) {
          markRemoved(target);
          appendDetail('form_delete_form', `working alternative: ${working}`);
        }
      }
      await sweepAuditForms();
    },
  });
}

/** The imported form delete sends a JSON body; probe the frontend-compatible variants. */
async function deleteFormFallback(uuid: string): Promise<string | undefined> {
  if (!ids.userUuid) return undefined;
  const variants: Array<{ label: string; options: any }> = [
    {
      label: 'DELETE /api/editor/forms?ownerUuid=…&uuids[]=…',
      options: {
        method: 'DELETE',
        path: '/api/editor/forms',
        query: { ownerUuid: ids.userUuid, 'uuids[]': [uuid] },
      },
    },
    {
      label: 'DELETE /api/editor/forms?ownerUuid=…&uuid=…',
      options: { method: 'DELETE', path: '/api/editor/forms', query: { ownerUuid: ids.userUuid, uuid } },
    },
    {
      label: 'DELETE /api/editor/forms/{uuid}',
      options: { method: 'DELETE', path: `/api/editor/forms/${uuid}`, query: { ownerUuid: ids.userUuid } },
    },
    {
      label: 'DELETE /api/editor/forms body {uuid}',
      options: { method: 'DELETE', path: '/api/editor/forms', body: { ownerUuid: ids.userUuid, uuid } },
    },
    {
      label: 'POST /api/editor/forms/delete',
      options: {
        method: 'POST',
        path: '/api/editor/forms/delete',
        body: { ownerUuid: ids.userUuid, uuids: [uuid] },
      },
    },
  ];
  for (const variant of variants) {
    try {
      await apiRequest({ ...variant.options, retryTool: 'tool-test-cleanup' });
      return variant.label;
    } catch {
      // try the next variant
    }
  }
  return undefined;
}

/** Remove `mcp-audit-*` forms left behind by earlier runs. */
async function sweepAuditForms(): Promise<void> {
  if (!ids.userUuid) return;
  for (const type of [2, 6, 18, 26, 27]) {
    try {
      const response = await apiRequest({
        method: 'GET',
        path: '/api/editor/forms/list',
        query: { ownerUuid: ids.userUuid, type, page: 1, pageSize: 100 },
        retryTool: 'tool-test-cleanup',
      });
      const list = deepFindArray(response.data);
      if (!Array.isArray(list)) continue;
      for (const form of list) {
        if (typeof form?.name !== 'string' || !form.name.startsWith('mcp-audit-')) continue;
        if (!form.uuid || tempUuids.has(form.uuid)) continue;
        await deleteFormFallback(form.uuid);
      }
    } catch {
      // best-effort sweep
    }
  }
}

async function testLayers(): Promise<void> {
  if (!ids.userUuid) return;
  const layerName = tmpName('layer');

  // Match the real record shape when possible; the numeric probe shape was
  // rejected with 422, so try the existing record as a template as well.
  let template: Record<string, unknown> | undefined;
  try {
    const response = await apiRequest({
      method: 'GET',
      path: `/api/editor/layer/${ids.userUuid}`,
      retryTool: 'tool-test',
    });
    const list = (response.data as any)?.result;
    if (Array.isArray(list) && list[0] && typeof list[0] === 'object') {
      const copy: Record<string, unknown> = { ...list[0] };
      for (const key of ['uuid', 'id', 'created_at', 'updated_at', 'owner_uuid', 'ownerUuid']) delete copy[key];
      template = copy;
    }
  } catch {
    // no template available
  }

  const base = {
    ownerUuid: ids.userUuid,
    layer: layerName,
    description: 'mcp audit temporary layer',
    color: '#FF0000',
  };
  const variants: Array<{ label: string; args: Record<string, unknown> }> = [
    { label: 'numeric fields', args: { ...base, visible: 1, print: 1, locked: 0, lineStyle: 1, lineWidth: 1, fontSize: 10, isStandardLayer: 0 } },
    {
      label: 'boolean fields',
      args: { ...base, visible: true, print: true, locked: false, lineStyle: 1, lineWidth: 1, fontSize: 10, isStandardLayer: false },
    },
    {
      label: 'string fields',
      args: { ...base, visible: '1', print: '1', locked: '0', lineStyle: '1', lineWidth: '1', fontSize: '10', isStandardLayer: '0' },
    },
    { label: 'minimal body', args: { ownerUuid: ids.userUuid, layer: layerName } },
  ];
  if (template) variants.push({ label: 'existing record as template', args: { ...template, ownerUuid: ids.userUuid, layer: layerName } });

  let created: CallOutcome | undefined;
  let usedLabel = '';
  for (const variant of variants) {
    created = await callTool('layer_create_layer', { ...variant.args, __confirm: true });
    if (created.status === 'OK') {
      usedLabel = variant.label;
      break;
    }
  }
  const uuid = created?.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (created)
    record('layer_create_layer', created, 'create', uuid ? `working shape: ${usedLabel}` : 'tried numeric/boolean/string/minimal/template bodies');
  if (!uuid) {
    recordBlocked('layer_update_layer', 'create_layer did not return a UUID');
    recordBlocked('layer_delete_layer', 'create_layer did not return a UUID');
    return;
  }
  remember('layer', uuid, layerName);
  ids.layerUuid = uuid;
  ids.layerName = layerName;
  await runTool('layer_layer_detail', { uuid }, 'read');
  await runTool('layer_layer_detail_by_name', { layer: layerName, ownerUuid: ids.userUuid }, 'read');
  await runTool('layer_layer_list_by_owner', { ownerUuid: ids.userUuid }, 'read');

  const updateVariants: Array<Record<string, unknown>> = [
    {
      uuid,
      ownerUuid: ids.userUuid,
      layer: `${layerName}-u`,
      description: 'mcp audit (updated)',
      color: '#00FF00',
      visible: 1,
      print: 1,
      locked: 0,
      lineStyle: 1,
      lineWidth: 1,
      fontSize: 10,
    },
    {
      uuid,
      ownerUuid: ids.userUuid,
      layer: `${layerName}-u`,
      description: 'mcp audit (updated)',
      color: '#00FF00',
      visible: true,
      print: true,
      locked: false,
    },
    { uuid, ownerUuid: ids.userUuid, layer: `${layerName}-u` },
  ];
  if (template) updateVariants.push({ ...template, uuid, ownerUuid: ids.userUuid, layer: `${layerName}-u` });
  let updated: CallOutcome | undefined;
  for (const args of updateVariants) {
    updated = await callTool('layer_update_layer', { ...args, __confirm: true });
    if (updated.status === 'OK') break;
  }
  if (updated) record('layer_update_layer', updated, 'update');

  cleanupTasks.push({
    label: `layer ${layerName}`,
    run: async () => {
      if (!assertTemp(uuid)) return;
      const out = await runTool('layer_delete_layer', { uuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(uuid);
    },
  });
}

async function testLibraries(): Promise<void> {
  if (!ids.userUuid) return;
  const name = tmpName('library');
  const created = await runTool('library_create_library', { name, attributes: {}, ownerUuid: ids.userUuid }, 'create');
  const uuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!uuid) {
    recordBlocked('library_update_library', 'create_library did not return a UUID');
    recordBlocked('library_delete_libraries', 'create_library did not return a UUID');
    return;
  }
  remember('library', uuid, name);
  tempLibraryUuid = uuid;
  ids.libraryUuid = uuid;
  await runTool('library_detail_library', { uuid }, 'read');
  await runTool('library_get_library_list', { ownerUuid: ids.userUuid, page: 1, pageSize: 20 }, 'read');
  await runTool('library_update_library', { uuid, name, attributes: { audit: true } }, 'update', {
    note: 'renaming is not supported by the endpoint; the name is resent unchanged',
  });
  cleanupTasks.push({
    label: `library ${name}`,
    run: async () => {
      if (!assertTemp(uuid)) return;
      const out = await runTool('library_delete_libraries', { uuid, __confirm: true }, 'delete');
      if (out.status === 'OK') {
        markRemoved(uuid);
        for (const resource of tempResources) {
          if (resource.kind === 'symbol' && resource.uuid) resource.removed = true;
        }
        return;
      }
      const working = await deleteLibraryFallback(uuid);
      if (working) {
        markRemoved(uuid);
        for (const resource of tempResources) {
          if (resource.kind === 'symbol' && resource.uuid) resource.removed = true;
        }
        const entry = records.get('library_delete_libraries');
        if (entry) entry.detail = `${entry.detail} · working alternative: ${working}`;
      }
      await sweepAuditLibraries();
    },
  });
}

/**
 * The tool deletes through DELETE /api/editor/libraries/symbols/:uuid. If that
 * fails, probe the other likely variants so the temporary library is still
 * removed and the working endpoint can be reported.
 */
async function deleteLibraryFallback(uuid: string): Promise<string | undefined> {
  const variants: Array<{ label: string; options: any }> = [
    {
      label: 'DELETE /api/editor/libraries/symbols/:uuid',
      options: { method: 'DELETE', path: `/api/editor/libraries/symbols/${uuid}` },
    },
    {
      label: 'DELETE /api/editor/libraries {uuids:[uuid]}',
      options: { method: 'DELETE', path: '/api/editor/libraries', body: { uuids: [uuid] } },
    },
    {
      label: 'DELETE /api/editor/libraries?uuids[]=uuid',
      options: { method: 'DELETE', path: '/api/editor/libraries', query: { 'uuids[]': [uuid] } },
    },
    {
      label: 'DELETE /api/editor/libraries?uuid=uuid',
      options: { method: 'DELETE', path: '/api/editor/libraries', query: { uuid } },
    },
  ];
  for (const variant of variants) {
    try {
      await apiRequest({ ...variant.options, retryTool: 'tool-test-cleanup' });
      return variant.label;
    } catch {
      // try the next variant
    }
  }
  return undefined;
}

/** Remove `mcp-audit-*` libraries left behind by earlier interrupted runs. */
async function sweepAuditLibraries(): Promise<void> {
  if (!ids.userUuid) return;
  try {
    const response = await apiRequest({
      method: 'GET',
      path: '/api/editor/libraries/symbols',
      query: { ownerUuid: ids.userUuid, page: 1, pageSize: 200 },
      retryTool: 'tool-test-cleanup',
    });
    const data = response.data as any;
    const list = data?.result?.data ?? data?.result?.list ?? data?.result ?? data?.data ?? [];
    if (!Array.isArray(list)) return;
    for (const library of list) {
      if (typeof library?.name !== 'string' || !library.name.startsWith('mcp-audit-')) continue;
      if (library.uuid === tempLibraryUuid) continue;
      await deleteLibraryFallback(library.uuid);
    }
  } catch {
    // best-effort sweep
  }
}

async function testMacros(): Promise<void> {
  if (!ids.userUuid) return;
  const name = tmpName('macro');
  const created = await runTool('macro_create_macro', { ownerUuid: ids.userUuid, name, type: 1, description: 'mcp audit temporary macro' }, 'create');
  const uuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!uuid) {
    for (const tool of [
      'macro_update_macro',
      'macro_save_as_macro',
      'macro_delete_macro',
      'jlc_ecad_upload_macro_data',
      'macro_macro_detail',
      'macro_macro_detail_by_name',
      'macro_macro_exists',
      'macro_macro_list_by_owner',
    ]) {
      recordBlocked(tool, 'create_macro did not return a UUID');
    }
    return;
  }
  remember('macro', uuid, name);
  ids.macroUuid = uuid;
  ids.macroName = name;

  const detail = await runTool('macro_macro_detail', { uuid }, 'read');
  const variables = detail.status === 'OK' ? deepFindKey(parseJson(detail.text), 'variables') : undefined;
  const macroDataUuid = Array.isArray(variables)
    ? (variables.find((variable: any) => variable?.type === 1 && typeof variable?.uuid === 'string')?.uuid ??
      variables.find((variable: any) => typeof variable?.uuid === 'string')?.uuid)
    : undefined;
  await runTool('macro_macro_detail_by_name', { name, ownerUuid: ids.userUuid }, 'read');
  await runTool('macro_macro_exists', { uuids: [uuid], ownerUuid: ids.userUuid }, 'read');
  await runTool('macro_macro_list_by_owner', { ownerUuid: ids.userUuid }, 'read');
  await runTool('macro_update_macro', { uuid, name: `${name}-u`, description: 'mcp audit (updated)' }, 'update');
  await runTool(
    'jlc_ecad_upload_macro_data',
    {
      uuid,
      ...(typeof macroDataUuid === 'string' ? { macroDataUuid } : { type: 1 }),
      dataBase64: Buffer.from('mcp audit macro payload').toString('base64'),
      contentType: 'stream',
    },
    'write',
    {
      note:
        typeof macroDataUuid === 'string'
          ? 'uses the macro detail variables[].uuid as macroDataUuid'
          : 'macro detail exposed no data UUID; the tool resolves macroDataUuid from the macro detail',
    },
  );

  const saveAs = await runTool(
    'macro_save_as_macro',
    {
      uuid,
      name: `${name}-copy`,
      ownerUuid: ids.userUuid,
      data: [{ type: 1, description: 'mcp audit', dataStr: 'audit' }],
    },
    'create',
  );
  const copyUuid = saveAs.status === 'OK' ? findRecordUuid(saveAs.text) : undefined;
  if (copyUuid) remember('macro', copyUuid, `${name}-copy`);

  cleanupTasks.push({
    label: `macros ${name}`,
    run: async () => {
      for (const current of [copyUuid, uuid]) {
        if (!current || !assertTemp(current)) continue;
        const out = await runTool('macro_delete_macro', { uuid: current, __confirm: true }, 'delete');
        if (out.status === 'OK') markRemoved(current);
      }
    },
  });
}

async function testPlotFrames(): Promise<void> {
  if (!ids.userUuid) return;
  const name = tmpName('plotframe');
  const created = await runTool('plot_frame_create_plot_frame', { ownerUuid: ids.userUuid, name, attributes: {}, dataStr: '{}' }, 'create');
  const uuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!uuid) {
    for (const tool of [
      'plot_frame_update_plot_frame',
      'plot_frame_delete_plot_frame',
      'plot_frame_plot_frame_detail',
      'plot_frame_create_plot_frame_history',
      'plot_frame_create_plot_frame_history_snapshot',
      'plot_frame_create_plot_frame_history_snapshot_2',
      'plot_frame_search_plot_frame_history_list',
    ]) {
      recordBlocked(tool, 'create_plot_frame did not return a UUID');
    }
    return;
  }
  remember('plot-frame', uuid, name);
  ids.plotFrameUuid = uuid;

  await runTool('plot_frame_plot_frame_detail', { uuid }, 'read');
  await runTool('plot_frame_update_plot_frame', { uuid, name: `${name}-u`, attributes: { audit: true } }, 'update');

  const history = await runWithRawFallback(
    'plot_frame_create_plot_frame_history',
    { uuid, dataStr: '{}' },
    '{}',
    'create',
    'plot frame history payload',
  );
  const historyUuid = history.status === 'OK' ? findRecordUuid(history.text) : undefined;
  if (historyUuid) {
    ids.plotFrameHistoryUuid = historyUuid;
    await runWithRawFallback(
      'plot_frame_create_plot_frame_history_snapshot',
      { uuid, historyUuid, dataStr: '{}' },
      '{}',
      'create',
      'plot frame snapshot (JSON)',
    );
    await runWithRawFallback(
      'plot_frame_create_plot_frame_history_snapshot_2',
      { uuid, historyUuid, dataStr: '{}' },
      '{}',
      'create',
      'plot frame snapshot (path history)',
    );
    await runTool('plot_frame_search_plot_frame_history_list', { uuid, historyUuid }, 'read');
  } else {
    for (const tool of [
      'plot_frame_create_plot_frame_history_snapshot',
      'plot_frame_create_plot_frame_history_snapshot_2',
      'plot_frame_search_plot_frame_history_list',
    ]) {
      recordBlocked(tool, 'create_plot_frame_history did not return a history UUID');
    }
  }

  cleanupTasks.push({
    label: `plot frame ${name}`,
    run: async () => {
      if (!assertTemp(uuid)) return;
      const out = await runTool('plot_frame_delete_plot_frame', { uuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(uuid);
    },
  });
}

async function testProjects(): Promise<void> {
  if (!ids.userUuid) return;
  const name = tmpName('project');
  const created = await runTool(
    'project_create_project',
    { name, ownerUuid: ids.userUuid, content: 'mcp audit temporary project', mode: 1 },
    'create',
  );
  const projectUuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!projectUuid) {
    for (const tool of [
      'project_update_project',
      'project_update_project_2',
      'project_delete_project',
      'project_get_project_detail',
      'project_get_project_logs',
      'project_branch_get_project_branch_list',
      'project_branch_get_project_branch_detail',
      'project_history_create_project_history',
      'project_history_create_project_history_2',
      'project_history_create_project_metadata',
      'project_history_delete_project_metadata',
      'project_history_get_project_history_list',
      'project_history_upload_snapshot_chunk_in_parallel',
    ]) {
      recordBlocked(tool, 'create_project did not return a UUID');
    }
    return;
  }
  remember('project', projectUuid, name);
  ids.projectUuid = projectUuid;

  await runTool('project_get_project_detail', { projectUuid }, 'read');
  await runTool('project_get_project_logs', { uuid: projectUuid, page: '1', pageSize: '10' }, 'read');
  await runTool('project_project_list', { page: 1, pageSize: 10, owner_uuid: ids.userUuid }, 'read');
  await runTool('project_update_project', { projectUuid, name: `${name}-u`, content: 'mcp audit (updated)', mode: 1 }, 'update');
  await runTool('project_update_project_2', { projectUuid, name: `${name}-u2`, content: 'mcp audit (updated 2)', mode: 1 }, 'update');

  const branches = await runTool('project_branch_get_project_branch_list', { projectUuid }, 'read');
  const branchUuid = branches.status === 'OK' ? findRecordUuid(branches.text) : undefined;
  if (branchUuid && assertTemp(projectUuid)) {
    const branchDetail = await runTool('project_branch_get_project_branch_detail', { projectUuid, branchUuid }, 'read');
    const historyUuid = branchDetail.status === 'OK' ? deepFindKey(parseJson(branchDetail.text), 'history_uuid') : undefined;
    if (typeof historyUuid === 'string') {
      ids.projectHistoryUuid = historyUuid;
      await runTool('project_history_get_project_history_list', { projectUuid, branchUuid, historyUuid }, 'read');
    } else {
      recordBlocked('project_history_get_project_history_list', 'temporary project branch exposes no history_uuid');
    }

    await runWithRawFallback(
      'project_history_create_project_history_2',
      { projectUuid, branchUuid, dataStr: '{}' },
      '{}',
      'create',
      'project history payload',
    );
    await runTool('project_history_create_project_metadata', { projectUuid, branchUuid, filename: 'audit.json' }, 'create');
    await runTool('project_history_delete_project_metadata', { projectUuid, branchUuid, filename: 'audit.json', __confirm: true }, 'delete');
    await runWithRawFallback(
      'project_history_create_project_history',
      { projectUuid, branchUuid, zip: 'audit.zip' },
      'mcp-audit-zip',
      'create',
      'zip-path history upload',
      'application/zip',
    );
    await runTool(
      'project_history_upload_snapshot_chunk_in_parallel',
      {
        projectUuid,
        branchUuid,
        chunksUuid: 'mcp-audit-chunks',
        chunkNumber: '1',
        __rawBodyBase64: Buffer.from('mcp audit chunk').toString('base64'),
        __contentType: 'application/octet-stream',
        __confirm: true,
      },
      'write',
    );
  } else {
    for (const tool of [
      'project_branch_get_project_branch_detail',
      'project_history_create_project_history',
      'project_history_create_project_history_2',
      'project_history_create_project_metadata',
      'project_history_delete_project_metadata',
      'project_history_get_project_history_list',
      'project_history_upload_snapshot_chunk_in_parallel',
    ]) {
      recordBlocked(tool, 'temporary project has no branch');
    }
  }

  cleanupTasks.push({
    label: `project ${name}`,
    run: async () => {
      if (!assertTemp(projectUuid)) return;
      const out = await runTool('project_delete_project', { projectUuid, __confirm: true }, 'delete');
      if (out.status === 'OK') markRemoved(projectUuid);
    },
  });
}

async function testSymbols(): Promise<void> {
  if (!tempLibraryUuid) {
    for (const tool of [
      'symbol_create_symbol',
      'symbol_update_symbol',
      'symbol_delete_symbol',
      'symbol_delete_symbol_by_uuid',
      'symbol_symbol_detail',
      'symbol_symbol_list',
      'symbol_create_symbol_history',
      'symbol_create_symbol_history_snapshot',
      'symbol_search_symbol_history_list',
    ]) {
      recordBlocked(tool, 'no temporary symbol library; refusing to write into an existing library');
    }
    return;
  }
  const libraryUuid = tempLibraryUuid;
  const title = tmpName('symbol');
  const created = await runTool(
    'symbol_create_symbol',
    {
      title,
      type: '1',
      definition: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      point: 1,
      number: 1,
      attributes: {},
      connectionPointLogic: {},
      ownerUuid: libraryUuid,
    },
    'create',
    { note: 'created inside the temporary symbol library' },
  );
  const uuid = created.status === 'OK' ? findRecordUuid(created.text) : undefined;
  if (!uuid) {
    for (const tool of [
      'symbol_update_symbol',
      'symbol_delete_symbol',
      'symbol_delete_symbol_by_uuid',
      'symbol_symbol_detail',
      'symbol_symbol_list',
      'symbol_create_symbol_history',
      'symbol_create_symbol_history_snapshot',
      'symbol_search_symbol_history_list',
    ]) {
      recordBlocked(tool, 'create_symbol did not return a UUID');
    }
    return;
  }
  remember('symbol', uuid, title);
  ids.symbolUuid = uuid;

  await runTool('symbol_symbol_detail', { uuid }, 'read');
  await runTool('symbol_symbol_list', { ownerUuid: libraryUuid, page: 1, pageSize: 10 }, 'read');
  await runTool('symbol_update_symbol', { uuid, title: `${title}-u`, attributes: { audit: true } }, 'update');

  const history = await runWithRawFallback('symbol_create_symbol_history', { uuid, dataStr: '{}' }, '{}', 'create', 'symbol history payload');
  const historyUuid = history.status === 'OK' ? findRecordUuid(history.text) : undefined;
  if (historyUuid) {
    ids.symbolHistoryUuid = historyUuid;
    await runWithRawFallback('symbol_create_symbol_history_snapshot', { uuid, historyUuid, dataStr: '{}' }, '{}', 'create', 'symbol snapshot');
    await runTool('symbol_search_symbol_history_list', { uuid, historyUuid }, 'read');
  } else {
    recordBlocked('symbol_create_symbol_history_snapshot', 'create_symbol_history did not return a history UUID');
    recordBlocked('symbol_search_symbol_history_list', 'create_symbol_history did not return a history UUID');
  }

  // A second symbol, deleted in a batch by UUID.
  const batchCreate = await callTool('symbol_create_symbol', {
    title: `${title}-batch`,
    type: '1',
    definition: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    point: 1,
    number: 1,
    attributes: {},
    connectionPointLogic: {},
    ownerUuid: libraryUuid,
    __confirm: true,
  });
  const batchUuid = batchCreate.status === 'OK' ? findRecordUuid(batchCreate.text) : undefined;
  if (batchUuid) remember('symbol', batchUuid, `${title}-batch`);

  cleanupTasks.push({
    label: `symbols ${title}`,
    run: async () => {
      if (batchUuid && assertTemp(batchUuid)) {
        const out = await runTool('symbol_delete_symbol', { uuids: [batchUuid], __confirm: true }, 'delete');
        if (out.status === 'OK') {
          markRemoved(batchUuid);
        } else {
          const fallback = await runTool('symbol_delete_symbol_by_uuid', { uuid: batchUuid, __confirm: true }, 'delete');
          if (fallback.status === 'OK') {
            markRemoved(batchUuid);
            appendDetail('symbol_delete_symbol', 'working alternative: DELETE /api/editor/symbols/:uuid');
          }
        }
      } else {
        recordBlocked('symbol_delete_symbol', 'could not create a second temporary symbol');
      }
      if (assertTemp(uuid)) {
        const out = await runTool('symbol_delete_symbol_by_uuid', { uuid, __confirm: true }, 'delete');
        if (out.status === 'OK') markRemoved(uuid);
      }
    },
  });
}

async function testPreferences(): Promise<void> {
  if (!ids.userUuid) return;
  const current = ids.user?.preference ?? {};
  await runTool('user_preference', { preferences: current }, 'update', {
    note: 'writes the current preference object back unchanged',
  });

  const history2 = await runTool('user_preference_create_history', { userUuid: ids.userUuid, dataStr: JSON.stringify(current) }, 'create');
  const historyUuid2 = history2.status === 'OK' ? findRecordUuid(history2.text) : undefined;
  if (historyUuid2) {
    await runWithRawFallback(
      'user_preference_create_snapshot',
      { userUuid: ids.userUuid, historyUuid: historyUuid2, dataStr: JSON.stringify(current) },
      JSON.stringify(current),
      'create',
      'preference snapshot v2',
    );
    await runTool('user_preference_search_history', { userUuid: ids.userUuid, historyUuid: historyUuid2 }, 'read');
  } else {
    recordBlocked('user_preference_create_snapshot', 'v2 history creation did not return a history UUID');
    recordBlocked('user_preference_search_history', 'v2 history creation did not return a history UUID');
  }

  const history3 = await runTool('user_preference_create_history_2', { userUuid: ids.userUuid, dataStr: JSON.stringify(current) }, 'create');
  const historyUuid3 = history3.status === 'OK' ? findRecordUuid(history3.text) : undefined;
  if (historyUuid3) {
    await runWithRawFallback(
      'user_preference_create_snapshot_2',
      { userUuid: ids.userUuid, historyUuid: historyUuid3, dataStr: JSON.stringify(current) },
      JSON.stringify(current),
      'create',
      'preference snapshot v3',
    );
    await runTool('user_preference_search_history_2', { userUuid: ids.userUuid, historyUuid: historyUuid3 }, 'read');
  } else {
    recordBlocked('user_preference_create_snapshot_2', 'v3 history creation did not return a history UUID');
    recordBlocked('user_preference_search_history_2', 'v3 history creation did not return a history UUID');
  }
}

// ---------------------------------------------------------------------------
// Read-only pass and confirmation-gate pass
// ---------------------------------------------------------------------------

async function readOnlyPass(): Promise<void> {
  for (const tool of tools) {
    const existing = records.get(tool.name)!;
    if (existing.status !== 'NOT_RUN') continue;
    if (!isReadOnlyCandidate(tool)) continue;
    const args = buildArgsFor(tool);
    await runTool(tool.name, args, 'read');
  }
}

async function gatePass(): Promise<void> {
  for (const tool of tools) {
    const existing = records.get(tool.name)!;
    if (!existing.danger) continue;
    const args = buildArgsFor(tool);
    delete (args as any).__confirm;
    const outcome = await callTool(tool.name, args);
    existing.gate = outcome.status === 'GATE_OK' ? 'OK' : outcome.status === 'OK' ? 'FAIL' : 'FAIL';
    if (existing.gate === 'FAIL') {
      existing.note = `${existing.note ? existing.note + '; ' : ''}confirm gate did not trigger (${clean(outcome.detail, 200)})`;
    }
  }
}

function appendDetail(name: string, text: string): void {
  const entry = records.get(name);
  if (entry) entry.detail = `${entry.detail ? `${entry.detail} · ` : ''}${text}`;
}

// ---------------------------------------------------------------------------
// Cleanup and report
// ---------------------------------------------------------------------------

async function runCleanup(): Promise<void> {
  if (cleanupRan) return;
  cleanupRan = true;
  for (const task of cleanupTasks.reverse()) {
    try {
      await task.run();
    } catch (error: any) {
      leftovers.push(`${task.label}: cleanup threw ${clean(error?.message ?? String(error), 120)}`);
    }
    await sleep(PAUSE_MS);
  }
  for (const resource of tempResources) {
    if (!resource.removed) {
      leftovers.push(`${resource.kind} ${resource.uuid ?? resource.name ?? '?'} was not confirmed deleted`);
    }
  }
}

function staticFindings(): {
  invalidPropertyKeys: string[];
  missingPathParams: string[];
  optionalPathParams: string[];
  mutatingButNotDanger: string[];
} {
  const result = {
    invalidPropertyKeys: [] as string[],
    missingPathParams: [] as string[],
    optionalPathParams: [] as string[],
    mutatingButNotDanger: [] as string[],
  };
  const invalidKey = /[^a-zA-Z0-9_.-]/;
  const walk = (schema: any, toolName: string, path = ''): void => {
    if (!schema || typeof schema !== 'object') return;
    for (const key of Object.keys(schema.properties ?? {})) {
      if (invalidKey.test(key)) result.invalidPropertyKeys.push(`${toolName}${path}.${key}`);
      walk(schema.properties[key], toolName, `${path}.${key}`);
    }
    if (schema.items) walk(schema.items, toolName, `${path}[]`);
    for (const branch of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[branch])) {
        schema[branch].forEach((item: any, index: number) => walk(item, toolName, `${path}.${branch}[${index}]`));
      }
    }
  };
  for (const tool of tools) {
    walk(tool.inputSchema, tool.name);
    const catalogTool = CATALOG.get(tool.name);
    if (!catalogTool) continue;
    const required = new Set<string>(tool.inputSchema?.required ?? []);
    const properties = tool.inputSchema?.properties ?? {};
    for (const match of catalogTool.path.matchAll(/:([A-Za-z_][\w-]*)/g)) {
      const param = match[1];
      if (!(param in properties)) result.missingPathParams.push(`${tool.name}: :${param} (${catalogTool.method} ${catalogTool.path})`);
      else if (!required.has(param)) result.optionalPathParams.push(`${tool.name}: :${param} (${catalogTool.method} ${catalogTool.path})`);
    }
    if (!catalogTool.danger && MUTATING_NAME.test(tool.name)) {
      result.mutatingButNotDanger.push(`${tool.name} (${catalogTool.method} ${catalogTool.path})`);
    }
  }
  return result;
}

function statusIcon(status: Status): string {
  switch (status) {
    case 'OK':
      return '✅ OK';
    case 'GATE_OK':
      return '🔒 GATE';
    case 'FAIL':
      return '❌ FAIL';
    case 'BLOCKED':
      return '⏸ BLOCKED';
    case 'SKIPPED':
      return '⏭ SKIPPED';
    default:
      return '—';
  }
}

function buildReport(): { markdown: string; json: any } {
  const all = [...records.values()];
  const counts = new Map<Status, number>();
  for (const record of all) counts.set(record.status, (counts.get(record.status) ?? 0) + 1);

  const byPrefix = new Map<string, { total: number; ok: number; fail: number; blocked: number; skipped: number }>();
  for (const record of all) {
    const prefix = record.source === 'hand-written' ? 'hand-written' : record.name.split('_')[0];
    const bucket = byPrefix.get(prefix) ?? { total: 0, ok: 0, fail: 0, blocked: 0, skipped: 0 };
    bucket.total += 1;
    if (record.status === 'OK') bucket.ok += 1;
    else if (record.status === 'FAIL') bucket.fail += 1;
    else if (record.status === 'BLOCKED') bucket.blocked += 1;
    else bucket.skipped += 1;
    byPrefix.set(prefix, bucket);
  }

  const failures = all.filter((record) => record.status === 'FAIL');
  const blocked = all.filter((record) => record.status === 'BLOCKED');
  const skipped = all.filter((record) => record.status === 'SKIPPED');
  const written = all.filter((record) => record.category && !['read', 'auth', 'skipped', 'prerequisite'].includes(record.category));
  const staticIssues = staticFindings();

  const lines: string[] = [];
  lines.push('# JLC ECAD MCP 全量工具测试报告');
  lines.push('');
  lines.push(`- 运行 ID：\`${RUN_ID}\``);
  lines.push(`- 日期：${new Date().toISOString()}`);
  lines.push(
    `- 工具总数：${all.length}（迁移 ${all.filter((r) => r.source === 'imported').length} + 手写 ${all.filter((r) => r.source === 'hand-written').length}）`,
  );
  lines.push(`- 测试方式：MCP stdio 真实调用；只读工具用账号现有数据，写/删工具使用**本次运行创建的临时资源**，测试后删除。`);
  lines.push(`- 结果文件：\`docs/tool-test-results/${RUN_ID}/report.json\``);
  lines.push('');
  lines.push(
    '> 安全边界：`jlc_ecad_order_part_bom`（真实下单）和 `jlc_ecad_logout`（会使本次测试会话失效）没有执行，只验证了确认门禁；其余工具均已真实调用。',
  );
  lines.push('');

  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 数量 |');
  lines.push(`| ${HR} | ${HR} |`);
  lines.push(`| 工具总数 | ${all.length} |`);
  for (const status of ['OK', 'GATE_OK', 'FAIL', 'BLOCKED', 'SKIPPED', 'NOT_RUN'] as Status[]) {
    if (counts.has(status)) lines.push(`| ${statusIcon(status)} | ${counts.get(status)} |`);
  }
  lines.push(`| 真实写/删类调用 | ${written.length} |`);
  lines.push(`| 创建临时资源 | ${tempResources.length} |`);
  lines.push(`| 未确认清理 | ${leftovers.length} |`);
  lines.push(`| 确认门禁通过 | ${all.filter((r) => r.danger && r.gate === 'OK').length}/${all.filter((r) => r.danger).length} 危险工具 |`);
  lines.push('');
  lines.push(
    '状态说明：`OK` 调用成功；`GATE` 只验证了确认门禁；`FAIL` 调用失败（见详情）；`BLOCKED` 因前置资源创建失败而未执行；`SKIPPED` 出于安全原因未执行。',
  );
  lines.push('');

  lines.push('## 按域结果');
  lines.push('');
  lines.push('| 域 | 工具数 | OK | FAIL | BLOCKED | SKIPPED |');
  lines.push(`| ${HR} | ${HR} | ${HR} | ${HR} | ${HR} | ${HR} |`);
  for (const [prefix, bucket] of [...byPrefix].sort()) {
    lines.push(`| ${prefix} | ${bucket.total} | ${bucket.ok} | ${bucket.fail} | ${bucket.blocked} | ${bucket.skipped} |`);
  }
  lines.push('');

  lines.push('## 失败工具');
  lines.push('');
  if (failures.length === 0) {
    lines.push('没有失败项。');
  } else {
    lines.push('| 工具 | 接口 | 详情 |');
    lines.push(`| ${HR} | ${HR} | ${HR} |`);
    for (const record of failures) {
      lines.push(`| \`${record.name}\` | ${record.endpoint === '—' ? '—' : `\`${record.endpoint}\``} | ${clean(record.detail, 360)} |`);
    }
  }
  lines.push('');

  lines.push('## 阻塞工具');
  lines.push('');
  if (blocked.length === 0) {
    lines.push('没有阻塞项。');
  } else {
    lines.push('| 工具 | 原因 |');
    lines.push(`| ${HR} | ${HR} |`);
    for (const record of blocked) lines.push(`| \`${record.name}\` | ${clean(record.detail, 220)} |`);
  }
  lines.push('');

  lines.push('## 未执行工具');
  lines.push('');
  if (skipped.length === 0) {
    lines.push('没有跳过的工具。');
  } else {
    lines.push('| 工具 | 原因 |');
    lines.push(`| ${HR} | ${HR} |`);
    for (const record of skipped) lines.push(`| \`${record.name}\` | ${clean(record.detail, 220)} |`);
  }
  lines.push('');

  if (leftovers.length > 0) {
    lines.push('## 未清理的临时资源');
    lines.push('');
    for (const item of leftovers) lines.push(`- ${clean(item, 220)}`);
    lines.push('');
    lines.push('这些资源由本次测试创建；如果删除接口失败，请手动在编辑器中删除。');
    lines.push('');
  }

  lines.push('## 静态检查');
  lines.push('');
  lines.push(`- 非法参数名（部分客户端会丢弃整个工具）：${staticIssues.invalidPropertyKeys.length}`);
  for (const item of staticIssues.invalidPropertyKeys) lines.push(`  - \`${item}\``);
  lines.push(`- 路径参数未写入 schema：${staticIssues.missingPathParams.length}`);
  for (const item of staticIssues.missingPathParams) lines.push(`  - \`${item}\``);
  lines.push(`- 路径参数在 schema 中可选：${staticIssues.optionalPathParams.length}`);
  for (const item of staticIssues.optionalPathParams) lines.push(`  - \`${item}\``);
  lines.push(`- 写接口但未标 danger：${staticIssues.mutatingButNotDanger.length}`);
  for (const item of staticIssues.mutatingButNotDanger) lines.push(`  - \`${item}\``);
  lines.push('');

  lines.push('## 确认门禁');
  lines.push('');
  lines.push('危险工具在带 `__confirm: true` 调用前，先不带确认调用一次；只有返回确认提示才算门禁生效。');
  lines.push('');
  lines.push('| 工具 | 门禁 | 备注 |');
  lines.push(`| ${HR} | ${HR} | ${HR} |`);
  for (const record of all.filter((r) => r.danger)) {
    lines.push(
      `| \`${record.name}\` | ${record.gate === 'OK' ? '通过' : record.gate === 'FAIL' ? '失败' : '未测'} | ${clean(record.note, 160) || '—'} |`,
    );
  }
  lines.push('');

  lines.push('## 全部工具明细');
  lines.push('');
  lines.push('| 工具 | 来源 | 接口 | 危险 | 结果 | 分类 | 详情 |');
  lines.push(`| ${HR} | ${HR} | ${HR} | ${HR} | ${HR} | ${HR} | ${HR} |`);
  for (const record of all) {
    lines.push(
      `| \`${record.name}\` | ${record.source === 'imported' ? '迁移' : '手写'} | ${record.endpoint === '—' ? '—' : `\`${record.endpoint}\``} | ${record.danger ? '是' : '否'} | ${statusIcon(record.status)} | ${record.category || '—'} | ${clean(record.detail, 300) || '—'} |`,
    );
  }
  lines.push('');

  lines.push('## 复跑方式');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm run build');
  lines.push('npx tsx scripts/test-all-tools.ts');
  lines.push('```');
  lines.push('');
  lines.push(
    '脚本会：启动 `dist/index.js` 的 MCP stdio 服务 → 采集只读 ID → 创建临时资源 → 调用全部工具 → 验证确认门禁 → 删除临时资源 → 生成本报告。',
  );
  lines.push('');

  const markdown = lines.join('\n');
  const json = {
    runId: RUN_ID,
    generatedAt: new Date().toISOString(),
    server: SERVER_ENTRY,
    totals: Object.fromEntries(counts),
    toolCount: all.length,
    dangerCount: all.filter((r) => r.danger).length,
    gateOk: all.filter((r) => r.gate === 'OK').map((r) => r.name),
    writeCalls: written.length,
    harvest: harvestLog,
    tempResources,
    leftovers,
    staticIssues,
    tools: all,
    calls: callLog,
  };
  return { markdown, json };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) throw new Error(`Build first: ${SERVER_ENTRY} is missing (run pnpm run build).`);

  const client = startServer();
  clientRef.current = client;
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tool-test', version: '1' },
  });
  client.notify('notifications/initialized', {});

  const listed = await client.request('tools/list', {});
  for (const tool of listed.result?.tools ?? []) {
    tools.push(tool);
    registerTool(tool);
  }
  console.log(`Discovered ${tools.length} tools.`);
  if (tools.length === 0) throw new Error('tools/list returned no tools');

  await harvest();
  console.log(`Harvested user=${ids.userUuid ?? 'none'} project=${ids.projectUuid ?? 'none'}`);
  if (!ids.userUuid) {
    throw new Error('No valid session: /api/editor/user failed. Run `node dist/index.js login` first.');
  }

  const phases: Array<[string, () => Promise<void>]> = [
    ['category', testCategory],
    ['team', testTeam],
    ['parts', testParts],
    ['forms', testForms],
    ['layers', testLayers],
    ['libraries', testLibraries],
    ['macros', testMacros],
    ['plot frames', testPlotFrames],
    ['projects', testProjects],
    ['symbols', testSymbols],
    ['preferences', testPreferences],
    [
      'user/beta/login',
      async () => {
        await testUser();
        await testBeta();
        await testLogin();
      },
    ],
  ];

  for (const [label, run] of phases) {
    console.log(`Phase: ${label}`);
    try {
      await run();
    } catch (error: any) {
      console.error(`Phase ${label} threw: ${error?.message ?? error}`);
    }
  }

  console.log('Phase: read-only pass');
  await readOnlyPass();
  console.log('Phase: confirmation gates');
  await gatePass();
  console.log('Phase: cleanup');
  await runCleanup();

  for (const record of records.values()) {
    if (record.status === 'NOT_RUN') {
      record.status = 'SKIPPED';
      record.detail = record.detail || 'no safe automated test strategy';
      record.category = 'skipped';
    }
  }

  const report = buildReport();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/report.md`, report.markdown);
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report.json, null, 2));

  const counts = report.json.totals as Record<string, number>;
  console.log(`\nReport written to ${OUT_DIR}/report.md`);
  console.log(
    `Tools: ${tools.length}; OK=${counts.OK ?? 0}; FAIL=${counts.FAIL ?? 0}; BLOCKED=${counts.BLOCKED ?? 0}; SKIPPED=${counts.SKIPPED ?? 0}`,
  );
  client.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void runCleanup().finally(() => process.exit(130));
  });
}

main().catch(async (error) => {
  console.error(error);
  try {
    await runCleanup();
  } finally {
    process.exit(1);
  }
});
