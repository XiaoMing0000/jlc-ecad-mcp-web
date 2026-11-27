#!/usr/bin/env node
/**
 * Audit every tool exposed by the MCP server.
 *
 * Default mode is static only. Pass --live to harvest real IDs and call
 * read-only tools against the API with the saved session. Mutating and
 * destructive tools are never called.
 *
 * Usage:
 *   npx tsx scripts/audit-tools.ts            # static report
 *   npx tsx scripts/audit-tools.ts --live     # static + read-only live probes
 *
 * The report is written to docs/TOOL-AUDIT.md.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRequest } from '../src/api/client.js';
import { ECAD_TOOLS } from '../src/tools/index.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = `${REPO_ROOT}dist/index.js`;
const OUTPUT = `${REPO_ROOT}docs/TOOL-AUDIT.md`;
const LIVE = process.argv.includes('--live');
const HR = '---';

const CATALOG = new Map(ECAD_TOOLS.map((tool) => [tool.name, tool]));

// Hand-written tools that are safe to call without changing data.
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

const HAND_WRITTEN_MUTATING = [
  'jlc_ecad_login',
  'jlc_ecad_logout',
  'jlc_ecad_accept_user_agreement',
  'jlc_ecad_update_user',
  'jlc_ecad_order_part_bom',
  'jlc_ecad_add_part_production',
  'jlc_ecad_update_part_production',
  'jlc_ecad_delete_part_production',
  'jlc_ecad_upload_macro_data',
  'jlc_ecad_join_beta_whitelist',
  'jlc_ecad_create_category',
  'jlc_ecad_update_category',
  'jlc_ecad_delete_category',
  'jlc_ecad_create_team',
  'jlc_ecad_update_team',
  'jlc_ecad_delete_team',
  'jlc_ecad_add_team_member',
  'jlc_ecad_remove_team_member',
  'jlc_ecad_transfer_team',
  'jlc_ecad_update_team_member_role',
  'jlc_ecad_update_team_member_remark',
];

const MUTATING_NAME =
  /(^|_)(add|create|update|delete|remove|save|apply|upload|transfer|whitelist|agreement|logout|order|join|accept|snapshot|chunk)(_|$)/;
const SAFE_NAME = /(list|detail|exists|by_name|categories|logs|search|info|status|rights|qrcode|filter|tree|check|read|other_teams)/;
const INVALID_PROPERTY_KEY = /[^a-zA-Z0-9_.-]/;
const OPTIONAL_ARG_KEYS =
  /^(page|pageSize|ownerUuid|owner_uuid|ownerUuids|type|accessory|keyword|search|catalog|param|sort|startTime|endTime|q|limit)$/;

interface JsonRpcClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  close(): void;
}

interface HarvestIds {
  userUuid?: string;
  projectUuid?: string;
  branchUuid?: string;
  projectHistoryUuid?: string;
  formUuid?: string;
  layerUuid?: string;
  layerName?: string;
  libraryUuid?: string;
  symbolUuid?: string;
  symbolHistoryUuid?: string;
  macroUuid?: string;
  macroName?: string;
  plotFrameUuid?: string;
  teamUuid?: string;
  categoryUuid?: string;
  partUuid?: string;
  productCatalogId?: number;
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
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr.resume();

  return {
    request(method, params, timeoutMs = 30_000) {
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

function clean(text: string, limit = 220): string {
  const masked = text
    .replace(/[0-9a-f]{32}/gi, '<uuid>')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/"(username|nickname|owner_uuid|avatar|email|phone)":\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .replace(/"(name)":\s*"[^"]{1,80}"/gi, '"$1":"<redacted>"');
  return masked.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, limit);
}

function walkSchema(schema: any, visit: (schema: any, path: string) => void, path = ''): void {
  if (!schema || typeof schema !== 'object') return;
  visit(schema, path);
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    walkSchema(value, visit, `${path}.${key}`);
  }
  if (schema.items) walkSchema(schema.items, visit, `${path}[]`);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach((item: any, index: number) => walkSchema(item, visit, `${path}.${key}[${index}]`));
    }
  }
}

function idFor(name: string, toolName: string, ids: HarvestIds): string | undefined {
  if (/^(ownerUuid|owner_uuid|userUuid|user_uuid|memberUuid|ownerUuids)$/.test(name)) return ids.userUuid;
  if (name === 'projectUuid') return ids.projectUuid ?? ids.userUuid;
  if (name === 'branchUuid') return ids.branchUuid ?? ids.projectUuid ?? ids.userUuid;
  if (name === 'formUuid') return ids.formUuid ?? ids.userUuid;
  if (name === 'partUuid') return ids.partUuid ?? ids.userUuid;
  if (name === 'drillUuid') return ids.partUuid ?? ids.userUuid;
  if (name === 'teamUuid') return ids.teamUuid ?? ids.userUuid;
  if (name === 'newOwnerUuid') return ids.userUuid;
  if (name === 'categoryUuid' || name === 'parent_uuid' || name === 'parentUuid') {
    return ids.categoryUuid ?? ids.userUuid;
  }
  if (name === 'layer') return ids.layerName ?? 'test';
  if (name === 'name' && toolName === 'macro_macro_detail_by_name') return ids.macroName ?? 'test';
  if (name === 'historyUuid') {
    if (toolName.startsWith('form_')) return ids.formUuid ?? ids.userUuid;
    if (toolName.startsWith('symbol_')) return ids.symbolHistoryUuid ?? ids.symbolUuid ?? ids.userUuid;
    if (toolName.startsWith('project_')) return ids.projectHistoryUuid ?? ids.branchUuid ?? ids.projectUuid ?? ids.userUuid;
    if (toolName.startsWith('plot_frame_')) return ids.plotFrameUuid ?? ids.userUuid;
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

function pickValue(name: string, schema: any, toolName: string, ids: HarvestIds): unknown {
  const id = idFor(name, toolName, ids);
  if (id !== undefined) {
    const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
    return type === 'array' ? [id] : id;
  }
  if (!schema || typeof schema !== 'object') return 'test';
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return pickValue(name, schema.anyOf[0], toolName, ids);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return pickValue(name, schema.oneOf[0], toolName, ids);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'array') {
    const count = Math.max(1, Number(schema.minItems) || 1);
    return Array.from({ length: Math.min(count, 2) }, () => pickValue(name, schema.items ?? {}, toolName, ids));
  }
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') {
    if (/^(startTime|endTime)$/i.test(name)) return Date.now();
    if (/^pageSize$/i.test(name)) return 10;
    if (/^(pageNum|page)$/i.test(name)) return 1;
    return 1;
  }
  if (type === 'object') return {};
  if (type === 'string') {
    if (/^(sort|order)$/i.test(name)) return 'desc';
    if (/(email)/i.test(name)) return 'audit@example.com';
    if (/(url)/i.test(name)) return 'https://example.com';
    if (/(path)/i.test(name)) return '';
    if (/(role)/i.test(name)) return 'member';
    if (/(filename)/i.test(name)) return 'audit.txt';
    if (/(catalog)/i.test(name) && ids.productCatalogId) return String(ids.productCatalogId);
    if (/(keyword|search|query|name|title|q)$/i.test(name)) return 'test';
    if (/^type$/i.test(name)) return '6';
    return 'test';
  }
  return 'test';
}

function buildArgs(tool: any, ids: HarvestIds): Record<string, unknown> {
  const schema = tool.inputSchema ?? {};
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const args: Record<string, unknown> = {};
  const names = new Set(required);
  for (const name of Object.keys(schema.properties ?? {})) {
    if (OPTIONAL_ARG_KEYS.test(name)) names.add(name);
  }
  for (const name of names) {
    args[name] = pickValue(name, schema.properties?.[name] ?? {}, tool.name, ids);
  }
  return args;
}

function isLiveCandidate(tool: any): boolean {
  const catalogTool = CATALOG.get(tool.name);
  if (!catalogTool) return LIVE_SAFE_HAND_WRITTEN.has(tool.name);
  if (catalogTool.danger) return false;
  if (MUTATING_NAME.test(tool.name)) return false;
  if (catalogTool.method === 'GET') return true;
  return SAFE_NAME.test(tool.name);
}

function skipReason(tool: any): string {
  if (!CATALOG.has(tool.name)) {
    if (tool.name === 'jlc_ecad_login') return 'starts the login flow';
    return HAND_WRITTEN_MUTATING.includes(tool.name) ? 'mutating hand-written tool' : 'not classified as read-only';
  }
  const catalogTool = CATALOG.get(tool.name)!;
  if (catalogTool.danger) return 'destructive tool (`__confirm` gated)';
  if (MUTATING_NAME.test(tool.name)) return 'mutating endpoint';
  return 'not classified as read-only';
}

function classify(message: any): { status: string; detail: string } {
  if (!message) return { status: 'NO_RESPONSE', detail: 'no JSON-RPC response' };
  if (message.__timeout) return { status: 'TIMEOUT', detail: 'no response within 30s' };
  if (message.error) return { status: 'RPC_ERROR', detail: JSON.stringify(message.error) };
  const result = message.result ?? {};
  const text = Array.isArray(result.content)
    ? result.content.map((block: any) => (block.type === 'text' ? block.text : `<${block.type}>`)).join('\n')
    : '';
  if (!result.isError) return { status: 'OK', detail: '' };
  if (/Not logged in|\(HTTP 401\)|code.?401|"code":\s*401/i.test(text)) return { status: 'AUTH', detail: text };
  if (/HTTP (?:4|5)\d\d/.test(text)) return { status: 'HTTP_ERROR', detail: text };
  if (/timed out/i.test(text)) return { status: 'TIMEOUT', detail: text };
  if (/Failed to reach|fetch failed/i.test(text)) return { status: 'UNREACHABLE', detail: text };
  if (/validation error|Invalid arguments/i.test(text)) return { status: 'VALIDATION', detail: text };
  return { status: 'API_ERROR', detail: text };
}

interface HarvestLogEntry {
  item: string;
  status: string;
  detail: string;
}

async function harvest(ids: HarvestIds): Promise<HarvestLogEntry[]> {
  const log: HarvestLogEntry[] = [];

  const fetchData = async (
    item: string,
    path: string,
    options: { method?: string; query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<any> => {
    try {
      const response = await apiRequest({
        method: (options.method as any) ?? 'GET',
        path,
        query: options.query as any,
        body: options.body,
        retryTool: 'tool-audit',
      });
      const data = response.data as any;
      log.push({ item, status: 'OK', detail: `HTTP ${response.httpStatus}` });
      return data;
    } catch (error: any) {
      log.push({ item, status: 'ERR', detail: clean(String(error?.message ?? error), 140) });
      return undefined;
    }
  };

  const markEmpty = (item: string, detail: string): void => {
    log.push({ item, status: 'EMPTY', detail });
  };

  const user = await fetchData('user', '/api/editor/user');
  ids.userUuid = user?.result?.uuid;

  const projects = await fetchData('project list', '/api/editor/projects', { query: { page: 1, pageSize: 10 } });
  ids.projectUuid = projects?.result?.lists?.[0]?.uuid ?? projects?.result?.data?.[0]?.uuid;
  if (ids.projectUuid) {
    const detail = await fetchData('project detail', `/api/editor/projects/${ids.projectUuid}`);
    ids.branchUuid = detail?.result?.branch_uuid ?? detail?.result?.branchUuid;
  }
  if (ids.projectUuid && ids.branchUuid) {
    const branches = await fetchData('project branches', `/api/editor/projects/${ids.projectUuid}/branches`);
    ids.branchUuid = branches?.result?.[0]?.uuid ?? branches?.result?.lists?.[0]?.uuid ?? ids.branchUuid;
    const branchDetail = await fetchData('branch detail', `/api/editor/projects/${ids.projectUuid}/branches/${ids.branchUuid}`);
    ids.projectHistoryUuid = branchDetail?.result?.history_uuid ?? branchDetail?.result?.historyUuid;
  }
  if (!ids.projectUuid) markEmpty('project test data', 'no projects available');

  if (ids.userUuid) {
    for (const type of [2, 6, 18, 26, 27]) {
      const forms = await fetchData('form list', '/api/editor/forms/list', {
        query: { ownerUuid: ids.userUuid, type, page: 1, pageSize: 100 },
      });
      ids.formUuid = forms?.result?.list?.[0]?.uuid ?? forms?.result?.lists?.[0]?.uuid;
      if (ids.formUuid) break;
    }
    if (!ids.formUuid) markEmpty('form test data', 'no forms available');
  }

  if (ids.userUuid) {
    const libraries = await fetchData('library list', '/api/editor/libraries/symbols', {
      query: { ownerUuid: ids.userUuid, page: 1, pageSize: 10 },
    });
    ids.libraryUuid = libraries?.result?.data?.[0]?.uuid ?? libraries?.result?.list?.[0]?.uuid;
  }

  if (ids.libraryUuid) {
    const symbols = await fetchData('symbol list', '/api/editor/symbols', {
      query: { ownerUuid: ids.libraryUuid, page: 1, pageSize: 10 },
    });
    ids.symbolUuid = symbols?.result?.data?.[0]?.uuid;
    if (ids.symbolUuid) {
      const symbolDetail = await fetchData('symbol detail', `/api/editor/symbols/${ids.symbolUuid}`);
      ids.symbolHistoryUuid = symbolDetail?.result?.history_uuid ?? symbolDetail?.result?.historyUuid;
    }
  }
  if (!ids.libraryUuid) markEmpty('library/symbol test data', 'no symbol libraries available');

  if (ids.userUuid) {
    const macros = await fetchData('macro list', `/api/editor/macro/${ids.userUuid}`);
    const macro = macros?.result?.[0] ?? macros?.[0];
    ids.macroUuid = macro?.uuid;
    ids.macroName = macro?.name;
  }

  if (ids.userUuid) {
    const frames = await fetchData('plot frame list', '/api/editor/plotFrames', {
      query: { ownerUuid: ids.userUuid, page: 1, pageSize: 10 },
    });
    ids.plotFrameUuid = frames?.result?.data?.[0]?.uuid ?? frames?.result?.list?.[0]?.uuid;
    if (!ids.plotFrameUuid) markEmpty('plot frame test data', 'no plot frames available');
  }

  if (ids.userUuid) {
    const layers = await fetchData('layer list', `/api/editor/layer/${ids.userUuid}`);
    const layer = layers?.result?.[0] ?? layers?.[0];
    ids.layerUuid = layer?.uuid;
    ids.layerName = layer?.layer ?? layer?.name;
  }

  const teams = await fetchData('team list', '/api/editor/teams', { query: { page: '1', pageSize: '10' } });
  ids.teamUuid = teams?.result?.lists?.[0]?.uuid;
  if (!ids.teamUuid) markEmpty('team test data', 'no teams available');

  if (ids.userUuid) {
    const categories = await fetchData('category list', '/api/editor/categories', {
      query: { user_uuid: ids.userUuid, 'type[]': 6 },
    });
    ids.categoryUuid = categories?.result?.[0]?.uuid;
    if (!ids.categoryUuid) markEmpty('category test data', 'no categories available');
  }

  if (ids.userUuid) {
    // Field values come from the editor bundle (ecad.js); category must contain at least one [attrId, value] pair.
    const parts = await fetchData('part list', '/api/editor/parts/list', {
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
    ids.partUuid = parts?.result?.list?.[0]?.uuid;
    if (!ids.partUuid) markEmpty('part test data', 'no parts available for this account');
  }

  const tree = await fetchData('product tree', '/api/editor/product/tree');
  const catalogId = tree?.data?.[0]?.catalogId ?? tree?.result?.[0]?.catalogId;
  if (typeof catalogId === 'number') {
    ids.productCatalogId = catalogId;
  }

  return log;
}

async function manualProbes(ids: HarvestIds): Promise<HarvestLogEntry[]> {
  const log: HarvestLogEntry[] = [];
  const probe = async (
    item: string,
    path: string,
    options: { method?: string; query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<any> => {
    try {
      const response = await apiRequest({
        method: (options.method as any) ?? 'GET',
        path,
        query: options.query as any,
        body: options.body,
        retryTool: 'tool-audit',
      });
      const data = response.data as any;
      const shape = Array.isArray(data)
        ? `array(${data.length})`
        : data && typeof data === 'object'
          ? `keys: ${Object.keys(data).slice(0, 8).join(',')}`
          : String(data).slice(0, 60);
      log.push({ item, status: `OK ${response.httpStatus}`, detail: clean(shape, 100) });
      return response.data;
    } catch (error: any) {
      log.push({ item, status: 'ERR', detail: clean(String(error?.message ?? error), 160) });
      return undefined;
    }
  };

  const catalog = ids.productCatalogId ?? 88;
  const productQuery = { pageNum: 1, pageSize: 10, catalog, param: '' };
  await probe('product/list (catalog numeric, 4 params)', '/api/editor/product/list', { query: productQuery });
  await probe('product/filter (catalog numeric, 4 params)', '/api/editor/product/filter', { query: productQuery });
  await probe('product/search (POST)', '/api/editor/product/search', {
    method: 'POST',
    body: { pageSize: 10, pageNum: 1, keyword: 'test' },
  });
  await probe('product/list (POST)', '/api/editor/product/list', { method: 'POST', body: productQuery });

  if (ids.userUuid) {
    await probe('categories user_uuid+type[]=6 (current tool)', '/api/editor/categories', {
      query: { user_uuid: ids.userUuid, 'type[]': 6 },
    });
  }

  if (ids.teamUuid) {
    await probe('teamInfo POST (current tool)', `/api/editor/teams/${ids.teamUuid}/teamInfo`, {
      method: 'POST',
      body: {},
    });
    await probe('teamInfo GET (frontend-compatible)', `/api/editor/teams/${ids.teamUuid}/teamInfo`);
  }

  if (ids.userUuid) {
    const partsBody = {
      ownerUuid: ids.userUuid,
      type: 1,
      category: [['22138', '1']],
      attrIds: ['22024', '22001', '22004', '22009'],
      keyword: '',
      page: 1,
      pageSize: 100,
    };
    await probe('parts/list (frontend shape)', '/api/editor/parts/list', { method: 'POST', body: partsBody });
    await probe('parts/getCategory2 (frontend shape)', '/api/editor/parts/getCategory2', {
      method: 'POST',
      body: { ownerUuid: ids.userUuid, category: ['22001'], accessory: 1, type: 1 },
    });
  }

  if (ids.partUuid) {
    await probe('parts/production GET', '/api/editor/parts/production', { query: { partUuid: ids.partUuid } });
  }

  await probe('eda/components search (path="", uuids=[])', '/api/editor/eda/components/searchByIds', {
    method: 'POST',
    body: { path: '', uuids: [] },
  });
  await probe('eda/components search (path="/", uuids=[])', '/api/editor/eda/components/searchByIds', {
    method: 'POST',
    body: { path: '/', uuids: [] },
  });

  return log;
}

async function main(): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`Build first: ${SERVER_ENTRY} is missing (run pnpm run build).`);
  }

  const client = startServer();
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tool-audit', version: '1' },
  });
  client.notify('notifications/initialized', {});
  const listedResponse = await client.request('tools/list', {});
  const tools: any[] = listedResponse.result?.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const staticFindings = {
    invalidPropertyKeys: [] as string[],
    missingPathParams: [] as string[],
    optionalPathParams: [] as string[],
    mutatingButNotDanger: [] as string[],
    dangerButReadLike: [] as string[],
    duplicateEndpoints: [] as string[],
    handWrittenWithoutConfirm: [] as string[],
    cjkTools: [] as string[],
    fileWording: [] as string[],
  };

  for (const tool of tools) {
    walkSchema(tool.inputSchema, (schema, path) => {
      for (const key of Object.keys(schema.properties ?? {})) {
        if (INVALID_PROPERTY_KEY.test(key)) staticFindings.invalidPropertyKeys.push(`${tool.name}${path}.${key}`);
      }
    });
    const serialized = JSON.stringify(tool);
    if (/[一-鿿]/.test(serialized)) staticFindings.cjkTools.push(tool.name);
    if (/文件|目录|后缀|磁盘|Documents\//.test(serialized)) staticFindings.fileWording.push(tool.name);
  }

  for (const [name, catalogTool] of CATALOG) {
    const tool = byName.get(name);
    if (!tool) continue;
    const properties = tool.inputSchema?.properties ?? {};
    const required = new Set<string>(tool.inputSchema?.required ?? []);
    for (const match of catalogTool.path.matchAll(/:([A-Za-z_][\w-]*)/g)) {
      const param = match[1];
      if (!(param in properties)) {
        staticFindings.missingPathParams.push(`${name}: :${param} not in schema (${catalogTool.method} ${catalogTool.path})`);
      } else if (!required.has(param)) {
        staticFindings.optionalPathParams.push(`${name}: :${param} is optional in schema (${catalogTool.method} ${catalogTool.path})`);
      }
    }
    if (!catalogTool.danger && MUTATING_NAME.test(name)) {
      staticFindings.mutatingButNotDanger.push(`${name} (${catalogTool.method} ${catalogTool.path})`);
    }
    if (catalogTool.danger && !MUTATING_NAME.test(name) && /(^|_)(list|detail|exists|search)(_|$)/.test(name)) {
      staticFindings.dangerButReadLike.push(`${name} (${catalogTool.method} ${catalogTool.path})`);
    }
  }

  const endpointGroups = new Map<string, string[]>();
  for (const [name, tool] of CATALOG) {
    const key = `${tool.method} ${tool.path}`;
    const names = endpointGroups.get(key) ?? [];
    names.push(name);
    endpointGroups.set(key, names);
  }
  for (const [endpoint, names] of endpointGroups) {
    if (names.length > 1) staticFindings.duplicateEndpoints.push(`${endpoint} → ${names.join(', ')}`);
  }

  for (const name of HAND_WRITTEN_MUTATING) {
    if (name === 'jlc_ecad_login' || name === 'jlc_ecad_logout') continue;
    const tool = byName.get(name);
    if (!tool) continue;
    if (!tool.inputSchema?.properties?.__confirm) staticFindings.handWrittenWithoutConfirm.push(name);
  }

  const ids: HarvestIds = {};
  let harvestLog: HarvestLogEntry[] = [];
  let manualLog: HarvestLogEntry[] = [];
  const liveResults = new Map<string, { status: string; detail: string; args: string; ms: number }>();
  let liveNote = '仅静态分析';

  if (LIVE) {
    harvestLog = await harvest(ids);
    if (!ids.userUuid) {
      liveNote = '只读实调跳过：没有有效登录会话';
    } else {
      liveNote = '静态分析 + 只读接口真实调用';
      manualLog = await manualProbes(ids);
      for (const tool of tools) {
        if (!isLiveCandidate(tool)) continue;
        const args = buildArgs(tool, ids);
        const startedAt = Date.now();
        const message = await client.request('tools/call', { name: tool.name, arguments: args }, 30_000);
        const ms = Date.now() - startedAt;
        const { status, detail } = classify(message);
        liveResults.set(tool.name, { status, detail, args: JSON.stringify(args), ms });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  }

  client.close();

  const handWritten = tools.filter((tool) => !CATALOG.has(tool.name));
  const liveCounts = new Map<string, number>();
  for (const { status } of liveResults.values()) liveCounts.set(status, (liveCounts.get(status) ?? 0) + 1);

  const lines: string[] = [];
  lines.push('# JLC ECAD MCP 工具校验报告');
  lines.push('');
  lines.push(`- 日期：${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 工具总数：${tools.length}（迁移 ${CATALOG.size} + 手写 ${handWritten.length}）`);
  lines.push(`- 模式：${liveNote}`);
  lines.push('- 真实调用只覆盖只读工具；所有 `danger` 工具和名字含写操作动词的工具都会被跳过，绝不触碰写/删接口。输出已对 UUID 和 URL 脱敏。');
  lines.push('');
  lines.push('## 校验计划');
  lines.push('');
  lines.push('1. 准备：确认构建产物、登录会话、导出全部工具清单。');
  lines.push('2. 静态校验：schema 合法性、路径参数、`danger`/`readOnly` 标注、重复接口、描述问题。');
  lines.push('3. 采集真实 ID（只读）：用户、工程/分支、表单、层、符号库、符号、宏、图框、团队、分类、产品目录。');
  lines.push('4. 逐域只读实调：使用真实 ID 复测只读工具；写/删工具只做静态检查。');
  lines.push('5. 失败项定向排查：尝试正确的参数类型或 HTTP 方法（仍只读）。');
  lines.push('6. 产出报告：问题清单、全部工具状态、复跑方式。');
  lines.push('');
  lines.push('复跑方式：');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm run build');
  lines.push('npx tsx scripts/audit-tools.ts          # 仅静态分析');
  lines.push('npx tsx scripts/audit-tools.ts --live   # 只读真实调用（使用已保存会话）');
  lines.push('```');
  lines.push('');

  lines.push('## 总览');
  lines.push('');
  lines.push('| 项目 | 数量 |');
  lines.push(`| ${HR} | ${HR} |`);
  lines.push(`| 工具总数 | ${tools.length} |`);
  lines.push(`| 迁移工具 | ${CATALOG.size} |`);
  lines.push(`| 手写工具 | ${handWritten.length} |`);
  lines.push(`| 迁移工具中标记为危险 | ${[...CATALOG.values()].filter((tool) => tool.danger).length} |`);
  if (LIVE) {
    for (const status of ['OK', 'API_ERROR', 'HTTP_ERROR', 'AUTH', 'UNREACHABLE', 'TIMEOUT', 'VALIDATION', 'RPC_ERROR', 'NO_RESPONSE']) {
      if (liveCounts.has(status)) lines.push(`| 只读探测 ${status} | ${liveCounts.get(status)} |`);
    }
    lines.push(`| 未探测（写/删/登录） | ${tools.length - liveResults.size} |`);
  }
  lines.push('');

  if (LIVE) {
    lines.push('## 真实 ID 采集');
    lines.push('');
    lines.push('| 步骤 | 状态 | 详情 |');
    lines.push(`| ${HR} | ${HR} | ${HR} |`);
    for (const entry of harvestLog) lines.push(`| ${entry.item} | ${entry.status} | ${entry.detail} |`);
    lines.push('');
    lines.push('采集到的 ID 只用于后续只读探测，报告中不展示具体值。');
    lines.push('');
  }

  lines.push('## 需要优先修复的问题');
  lines.push('');
  lines.push('以下结论结合了静态检查、真实只读调用和定向复测（仅只读接口）：');
  lines.push('');
  lines.push('| 工具 | 问题 | 结论 / 下次调整建议 |');
  lines.push(`| ${HR} | ${HR} | ${HR} |`);
  lines.push(
    '| `form_get_form_list` | 参数名不合法，且线上参数不同 | 属性名 `formExts[]` 不匹配客户端命名规则，会被丢弃；前端 bundle 使用 `GET /forms/list?ownerUuid=&type=&page=&pageSize=`，即 **`type`（数字）**，不是 `formExts[]`。建议把 schema 换成 `type` 数字，同时解决合法性问题。 |',
  );
  lines.push(
    '| `jlc_ecad_list_products`、`jlc_ecad_get_product_filters` | 参数集合与类型不符 | 前端只用 `{catalog, pageSize, pageNum, param}`：`catalog` 是数字目录 ID，`param` 是过滤表达式字符串；当前工具多传 `keyword`/`piceSort`/`stockSort` 并允许非数字 `catalog`（传 `test` 会 400）。建议改为 4 个参数，`catalog` 用数字。 |',
  );
  lines.push(
    '| `part_list_parts` | 参数与 schema 不符 | 前端 body 为 `{ownerUuid, type, category, keyword, page, pageSize, attrIds, accessory}`；**`category` 必须是非空的 [属性 ID, 属性值] 对数组**（如 `[["22138","1"]]`），`attrIds` 是属性 ID 数组。空数组会 422。`part_get_part_list` 已改为 `POST /parts/list` 并使用同样的 body。 |',
  );
  lines.push(
    '| `part_get_part_categories` | `category` 语义错误 | 前端调用 `/parts/getCategory2` 时 body 是 `{ownerUuid, category: [属性ID...], accessory, type}`，`category` 是属性 ID 数组，不是“对”数组；当前 schema 描述相反，容易传错导致 422。 |',
  );
  lines.push(
    '| `jlc_ecad_add_part_production`、`jlc_ecad_update_part_production` | 字段/方法错误 | 前端：新增是 `POST {ownerUuid, partUuid, data}`（当前缺 `ownerUuid`），更新是 **`PUT`** `{partUuid, data}`（当前用 POST）。GET/DELETE 与前端一致。 |',
  );
  lines.push(
    '| `part_detail_part`、`jlc_ecad_get_part_production` | 无测试数据 | 当前账号没有任何部件（parts/list 返回 0 条），无法用真实 partUuid 复测详情与生产选项卡；接口约定已与前端核对，待有数据后复测。 |',
  );
  lines.push(
    '| `form_create_form_history` | 请求体类型不同 | 前端用 `POST /forms/{uuid}/histories` + `Content-Type: stream` 原始数据；线上可能不接受桌面端的 JSON `dataStr`。建议改为 `__rawBodyBase64` / stream。 |',
  );
  lines.push(
    '| `system_attribute_info` | 返回与描述不符 | 线上返回 `{uuid}`，不是版本/运行模式信息；仅本地可用的 `system_*`、`config_index`、`eplan_macro_read` 已从工具目录排除。 |',
  );
  lines.push(
    '| `form_apply_form_history_snapshot`、`part_add_accessories`、`part_add_drill_cut`、`part_add_templates`、`user_preference` | 写接口被标成只读 | `danger: false` 会导出 `readOnlyHint: true`。建议在生成器里按接口名/路径补充 danger 判定（例如任何 POST/PUT/DELETE 写接口默认 danger）。 |',
  );
  lines.push('| `jlc_ecad_get_user` | 描述暴露本机路径 | 描述里带本机 `<配置目录>/session.json` 路径；建议改成占位符。 |');
  lines.push(
    '| `project_history_get_project_history_list` | 需要分支的 `history_uuid` | 用分支详情返回的 `history_uuid` 复测成功（200）；之前用 branch uuid 才返回 500。建议在文档中说明该参数来源。 |',
  );
  lines.push(
    '| `jlc_ecad_search_components` | `path` 不能为空 | 前端只是透传对象；复测发现 `path=""` 返回 422，`path="/"` 返回 200（空列表）。建议默认 `path="/"` 或校验非空。 |',
  );
  lines.push('| 无测试数据 | forms / plotFrames / parts 为空 | 表单、图框、部件相关详情/历史工具无法做真实 ID 复测，只验证了列表与接口约定。 |');
  lines.push('');
  lines.push('## 前端 bundle 对照结论');
  lines.push('');
  lines.push('以下结论来自线上编辑器 bundle（`https://modules.lceda.cn/ecad/2.5.33.6a3c0008/ecad.js`）中的实际调用代码，可作为下次调整的直接依据：');
  lines.push('');
  lines.push('| 功能 | 线上调用 | 参数 |');
  lines.push(`| ${HR} | ${HR} | ${HR} |`);
  lines.push('| 产品列表 | `GET /api/editor/product/list` | `{catalog(数字), pageSize, pageNum, param}` |');
  lines.push('| 产品筛选 | `GET /api/editor/product/filter` | `{catalog(数字), pageSize, pageNum, param}` |');
  lines.push('| 产品搜索 | `POST /api/editor/product/search` | `{pageSize, pageNum, keyword}` |');
  lines.push("| 分类列表 | `GET /api/editor/categories` | `{user_uuid, 'type[]': 6}`（键名是 `type[]`） |");
  lines.push('| 部件列表 | `POST /api/editor/parts/list` | `{ownerUuid, type, category(非空对数组), keyword, page, pageSize, attrIds, accessory}` |');
  lines.push('| 部件分类 | `POST /api/editor/parts/getCategory2` | `{ownerUuid, category(属性 ID 数组), accessory, type}` |');
  lines.push(
    '| 部件生产选项卡 | `GET|POST|PUT|DELETE /api/editor/parts/production` | GET `{partUuid}`；POST `{ownerUuid, partUuid, data}`；PUT `{partUuid, data}`；DELETE `{partUuid, uuids}` |',
  );
  lines.push('| 表单列表 | `GET /api/editor/forms/list` | `{ownerUuid, type(数字), page, pageSize}` |');
  lines.push('| 表单详情 | `GET /api/editor/forms` | `{uuid}` |');
  lines.push('| 表单历史 | `GET /api/editor/forms/{uuid}/histories/{historyUuid}` | 路径参数 |');
  lines.push('| 团队 | `GET /api/editor/teams`、`GET /api/editor/teams/otherTeams` | `{pageSize, page}` |');
  lines.push('| EDA 搜索 | `POST /api/editor/eda/{devices,components}/searchByIds` | 对象透传（`path` 语义仍未确认） |');
  lines.push('');

  lines.push('## 重复/重叠工具');
  lines.push('');
  lines.push('| 接口 | 迁移工具 | 手写工具 | 说明 |');
  lines.push(`| ${HR} | ${HR} | ${HR} | ${HR} |`);
  lines.push('| `GET /api/editor/user` | `user_info` | `jlc_ecad_get_user` | 同一接口；建议只保留一个。 |');
  lines.push(
    '| `GET /api/editor/teams` | `team_team_list` | `jlc_ecad_list_teams` | 迁移版 `from` + 字符串分页；手写版 `form` + 数字分页，需确认线上参数。 |',
  );
  lines.push('| `GET /api/editor/teams/otherTeams` | `team_other_teams` | `jlc_ecad_get_other_teams` | 完全重复。 |');
  lines.push('');

  const section = (title: string, items: string[], note = ''): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    lines.push('');
    if (note) lines.push(note, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };

  section('MCP 客户端会拒绝的参数名', staticFindings.invalidPropertyKeys, '属性名必须匹配 `^[a-zA-Z0-9_.-]{1,64}$`，否则部分客户端会丢弃整个工具。');
  section('路径参数未写入 schema', staticFindings.missingPathParams);
  section('路径参数在 schema 中是可选的', staticFindings.optionalPathParams, 'McpServer 会放行，执行器在运行时才报错。');
  section(
    '迁移目录中“写接口但未标危险”的工具',
    staticFindings.mutatingButNotDanger,
    '`danger: false` 会导出 `readOnlyHint: true`，客户端可能不确认就写数据。',
  );
  section('迁移目录中“删除接口但像只读”的工具', staticFindings.dangerButReadLike);
  section('迁移目录中的重复接口', staticFindings.duplicateEndpoints);
  section(
    '手写写操作未使用 `__confirm`',
    staticFindings.handWrittenWithoutConfirm,
    '这些工具会修改线上数据；请确认是否都需要用户二次确认（删除/下单/转移类已加）。',
  );
  section('仍然包含中文文案的工具', staticFindings.cjkTools);
  section('仍然提及本地文件/目录的工具', staticFindings.fileWording);

  if (manualLog.length > 0) {
    lines.push('## 定向复测（只读）');
    lines.push('');
    lines.push('| 探测项 | 状态 | 详情 |');
    lines.push(`| ${HR} | ${HR} | ${HR} |`);
    for (const entry of manualLog) lines.push(`| ${entry.item} | ${entry.status} | ${entry.detail} |`);
    lines.push('');
  }

  lines.push('## 全部工具状态');
  lines.push('');
  lines.push(
    '`OK` = 只读调用成功；`API_ERROR` = 接口可达但返回业务错误（多为真实/占位 UUID 不匹配）；`HTTP_ERROR` = HTTP 4xx/5xx；`SKIPPED` = 写/删/登录类，未调用。',
  );
  lines.push('');
  lines.push('| 工具 | 来源 | 接口 | 危险 | 结果 | 详情 |');
  lines.push(`| ${HR} | ${HR} | ${HR} | ${HR} | ${HR} | ${HR} |`);
  for (const tool of tools) {
    const catalogTool = CATALOG.get(tool.name);
    const source = catalogTool ? '迁移' : '手写';
    const endpoint = catalogTool ? `${catalogTool.method} ${catalogTool.path}` : '—';
    const danger = catalogTool ? (catalogTool.danger ? '是' : '否') : tool.annotations?.destructiveHint ? '是' : '否';
    const live = liveResults.get(tool.name);
    const result = live ? live.status : LIVE ? 'SKIPPED' : '—';
    const detail = live ? clean(live.detail) : LIVE ? clean(skipReason(tool), 120) : '';
    lines.push(`| \`${tool.name}\` | ${source} | ${endpoint === '—' ? '—' : `\`${endpoint}\``} | ${danger} | ${result} | ${detail || '—'} |`);
  }
  lines.push('');

  if (liveResults.size > 0) {
    const problems = [...liveResults.entries()].filter(([, value]) => value.status !== 'OK');
    lines.push('## 只读探测未通过的工具');
    lines.push('');
    if (problems.length === 0) {
      lines.push('所有被探测的只读工具均返回成功。');
      lines.push('');
    } else {
      lines.push('| 工具 | 状态 | 探测参数（已脱敏） | 详情 |');
      lines.push(`| ${HR} | ${HR} | ${HR} | ${HR} |`);
      for (const [name, value] of problems) {
        lines.push(`| \`${name}\` | ${value.status} | \`${clean(value.args, 160)}\` | ${clean(value.detail)} |`);
      }
      lines.push('');
      lines.push(
        '`API_ERROR` 通常是接口可达、但参数/ID 不匹配（如 `DATA_NOT_FOUND`、`REQUEST_PARAM_ILLEGAL`）；需要结合“真实 ID 采集”和“定向复测”判断是否为工具缺陷。',
      );
      lines.push('');
    }
  }

  lines.push('## 下次调整建议');
  lines.push('');
  lines.push('1. P0：`form_get_form_list` 的 `formExts[]` 改为 `type`（数字）。这同时修复“参数名不合法导致工具被客户端丢弃”的问题。');
  lines.push(
    '2. P0：产品列表工具改为前端参数：`/product/list`、`/product/filter` 只用 `{catalog(数字), pageSize, pageNum, param}`（`jlc_ecad_list_products_post` 已改为 `POST /product/search {pageSize, pageNum, keyword}`）。',
  );
  lines.push('3. P0：`jlc_ecad_search_components` 默认 `path="/"` 或校验非空。');
  lines.push(
    '4. P0：修正部件工具参数：`category` 必须是非空 [属性 ID, 属性值] 数组、`attrIds` 是属性 ID 数组；`getCategory2` 的 `category` 是属性 ID 数组；新增生产选项卡补 `ownerUuid`，更新改用 `PUT`。',
  );
  lines.push('5. P0：修正写接口的 `danger`/`readOnlyHint` 标注。');
  lines.push(
    '6. P1：处理重复工具（`user_info` / `jlc_ecad_get_user`、团队列表与 otherTeams），并把 `jlc_ecad_get_user` 描述里的本机 session 路径换成占位符。',
  );
  lines.push('7. P1：用真实数据复测表单、图框、部件相关工具；当前账号没有这些数据，只验证了列表接口和约定。');
  lines.push('8. P2：把本次的 bundle 对照结论同步到 `docs/PLAN.md` / `CLAUDE.md`，避免下次重新逆向。');
  lines.push('');

  writeFileSync(OUTPUT, lines.join('\n'));
  console.log(`Audit written to ${OUTPUT}`);
  console.log(`Tools: ${tools.length}; live probes: ${liveResults.size}; harvested: ${harvestLog.filter((e) => e.status === 'OK').length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
