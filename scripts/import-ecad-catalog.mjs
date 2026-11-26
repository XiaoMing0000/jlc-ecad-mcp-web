#!/usr/bin/env node
/**
 * Import the JLC ECAD desktop app's MCP tool catalog into this project.
 *
 * The desktop server (resources/app/server.js) defines its tools as an array of
 * `b(name, config, f(controller, "method"))` entries. This script evaluates that
 * catalog in a sandbox, maps each handler to the HTTP verbs registered by the
 * local Express routes, converts each JSON Schema into a Zod schema, and writes
 * one TypeScript file per domain.
 *
 * Usage:
 *   node scripts/import-ecad-catalog.mjs [path/to/server.js]
 *
 * The generated files are committed; the importer is only needed when updating
 * the catalog from a newer JLC ECAD release.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = process.argv[2] ?? process.env.JLC_ECAD_APP_SERVER ?? '/opt/apps/jlc-ecad/resources/app/server.js';
const outputDir = join(repoRoot, 'src', 'tools');

const source = readFileSync(sourcePath, 'utf8');
const lines = source.split('\n');

function lineIndex(prefix, from = 0) {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index].startsWith(prefix)) {
      return index;
    }
  }
  return -1;
}

const catalogStart = lineIndex('var fx = [');
const aggregateStart = lineIndex('var Bx = [', catalogStart + 1);
if (catalogStart < 0 || aggregateStart < 0) {
  throw new Error('Could not find the MCP catalog (var fx / var Bx) in the source file.');
}

let catalogEnd = -1;
for (let index = aggregateStart; index < lines.length; index += 1) {
  if (lines[index].trim() === '];') {
    catalogEnd = index;
    break;
  }
}
if (catalogEnd < 0) {
  throw new Error('Could not find the end of the MCP catalog (var Bx).');
}

const block = lines.slice(catalogStart, catalogEnd + 1).join('\n');
const controllerNames = [...new Set([...block.matchAll(/f\(\s*([A-Za-z_$][\w$]*)\s*,\s*"([^"]+)"/g)].map((match) => match[1]))];
const declarations = controllerNames.map((name) => `var ${name} = { __name: ${JSON.stringify(name)} };`).join('\n');
const prelude = `
var JT = { type: 'object', properties: {}, additionalProperties: true };
var ZT = { type: 'object', additionalProperties: true };
function b(name, config, handler) { return { name, config, handler }; }
function f(controller, method) { return { controller: controller && controller.__name || 'unknown', method }; }
${declarations}
`;
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${prelude}\n${block}\nthis.__catalog = Bx;`, sandbox, { timeout: 10_000 });
const catalog = sandbox.__catalog;
if (!Array.isArray(catalog) || catalog.length === 0) {
  throw new Error('The MCP catalog was not an array of tools.');
}

const routePattern = /\.(get|post|put|delete|patch)\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*,\s*f\(\s*(\w+)\s*,\s*"([^"]+)"\s*\)/g;
const routesByHandler = new Map();
for (const match of source.matchAll(routePattern)) {
  const verb = match[1].toUpperCase();
  const routePath = match[2] ?? match[3] ?? match[4] ?? '';
  const key = `${match[5]}.${match[6]}`;
  const routes = routesByHandler.get(key) ?? [];
  routes.push({ verb, path: routePath });
  routesByHandler.set(key, routes);
}

const assumedGet = new Set(['client_get_config', 'config_index', 'system_attribute_get_preference', 'system_attribute_get_proxy_url']);

function chooseMethod(tool, routes) {
  if (assumedGet.has(tool.name)) {
    return 'GET';
  }

  const verbs = [...new Set(routes.map((route) => route.verb))];
  if (verbs.length === 0) {
    return 'GET';
  }
  if (verbs.length === 1) {
    return verbs[0];
  }

  // project_update_project and project_update_project_2 both register POST /update
  // and PUT on the collection/path-parameter route. Pick by the catalog path.
  const exact = routes.find((route) => route.path !== '' && tool.config.path.endsWith(route.path));
  if (exact) {
    return exact.verb;
  }
  if (routes.some((route) => route.path === '')) {
    return 'PUT';
  }
  return verbs[0];
}

const rows = catalog.map((tool) => {
  const key = `${tool.handler.controller}.${tool.handler.method}`;
  const routes = routesByHandler.get(key) ?? [];
  return {
    name: tool.name,
    description: tool.config.description ?? '',
    path: tool.config.path,
    method: chooseMethod(tool, routes),
    danger: Boolean(tool.config.danger),
    inputSchema: tool.config.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
  };
});

const extraNotes = {
  project_history_upload_snapshot_chunk_in_parallel:
    '\n\nMCP note: pass the chunk bytes as __rawBodyBase64 (a base64 string). The request is sent with Content-Type: application/octet-stream.',
};

for (const row of rows) {
  if (extraNotes[row.name]) {
    row.description += extraNotes[row.name];
  }
}

function domainOf(path) {
  const parts = path.split('/').filter(Boolean);
  let domain = parts[2] ?? '';
  if (domain === 'v2' || domain === 'v3') {
    domain = `${parts[2]}/${parts[3]}`;
  }
  return domain;
}

// client_* tools are implemented by the desktop app's local server, so they
// cannot be called through this MCP server and are not generated.
const excludedDomains = new Set(['client']);

const includedRows = rows.filter((row) => !excludedDomains.has(domainOf(row.path)));

// The desktop catalog describes local files and directories. The web API works
// with owners and UUIDs instead, so those details are removed from the text
// shown to MCP clients.
const LEGACY_EXTENSIONS = /`?\.(?:efdNN|efNN|symd|sym|slb|ecsl|esmd|esm|epl|epld|ema|ems|eud)`?/g;
const CLIENT_ONLY = /本地|离线|单用户模式|客户端本地/;
const FILESYSTEM_LEFT = /文件|目录|文件夹|后缀|磁盘/;
const CONCRETE_PATH = /Documents\/|user\/libs|config\.json|userPreferenceDataPath|<filename>|<title>|<name>/;

function normalizeWording(text) {
  return (
    text
      // Suffix/file-name requirements and parentheticals that list file names.
      .replace(/（以[^）]*结尾）|（不含后缀）|（用作文件名）|（目录不存在时自动创建）/g, '')
      .replace(/（[^）]*\.[A-Za-z][^）]*）/g, '')
      .replace(LEGACY_EXTENSIONS, '')
      .replace(/，仅支持[^，。]*后缀/g, '')
      .replace(/，如 \.[^）]*/g, '')
      .replace(/指定后缀的/g, '')
      .replace(/后缀列表/g, '类型列表')
      // Ownership / UUID wording.
      .replace(/完整索引文件路径/g, '完整 UUID')
      .replace(/符号库所在父目录路径/g, '符号库归属 UUID')
      .replace(/归属目录路径/g, '归属 UUID（个人或团队）')
      .replace(/钻孔排列样式部件文件路径/g, '钻孔排列样式部件 UUID')
      .replace(/部件文件路径/g, '部件 UUID')
      .replace(/索引文件名/g, '名称')
      .replace(/索引文件路径/g, 'UUID')
      .replace(/索引文件/g, '记录')
      .replace(/数据文件/g, '数据')
      .replace(/数据路径/g, '数据 UUID')
      .replace(/文件夹/g, '归属')
      .replace(/目录/g, '归属')
      .replace(/绝对路径/g, 'UUID')
      .replace(/文件路径/g, 'UUID')
      .replace(/宏文件内容/g, '宏内容')
      .replace(/文件/g, '数据')
      .replace(/重命名数据/g, '重命名')
      .replace(/写入/g, '保存')
      .replace(/跳过该数据/g, '跳过该记录')
      .replace(/记录错误日志/g, '输出错误日志')
      .replace(/工程索引(?=读取)/g, '工程记录')
      .replace(/客户端会自动解码/g, '服务端会自动解码')
      .replace(/记录路径不存在/g, '记录不存在')
      .replace(/路径不存在/g, '记录不存在')
      .replace(/([一-龥])(UUID)/g, '$1 $2')
      .replace(/(UUID)([一-龥])/g, '$1 $2')
      .replace(/ {2,}/g, ' ')
      .replace(/([一-龥]) ([一-龥])/g, '$1$2')
      .replace(/\s+([，。；：、）])/g, '$1')
  );
}

function sanitizeDescription(text) {
  const separator = text.indexOf('\n\n');
  const title = normalizeWording(separator >= 0 ? text.slice(0, separator) : text);
  const body = separator >= 0 ? text.slice(separator + 2) : '';
  if (body === '') {
    return title;
  }

  const kept = [];
  for (const segment of body.split('</br>')) {
    const sentences = normalizeWording(segment)
      .split(/(?<=。)/)
      .filter((sentence) => sentence && !CLIENT_ONLY.test(sentence) && !FILESYSTEM_LEFT.test(sentence))
      .filter((sentence) => !CONCRETE_PATH.test(sentence));
    const joined = sentences.join('').trim();
    if (joined !== '') {
      kept.push(joined);
    }
  }
  return kept.length === 0 ? title : `${title}\n\n${kept.join('</br>')}`;
}

// The desktop catalog is written in Chinese and describes local files and
// directories. MCP clients get English descriptions instead, with ownership and
// UUID wording that matches the web API.
const englishToolDescriptions = {
  config_index: 'Get editor configuration\n\nReturn the list of enabled configuration items for the given `type`.',
  system_attribute_get_preference: 'Get system preferences\n\nReturn the system preferences as JSON. Takes no parameters.',
  system_attribute_get_proxy_url: 'Get online service URL\n\nReturn the configured `onlineService` URL. Takes no parameters.',
  system_attribute_info: 'Get system information\n\nReturn system information such as version and run mode. Takes no parameters.',
  eplan_macro_read: 'Read an EPLAN macro\n\nReturn the content of a single EPLAN macro.',
  erp_rights_designer:
    'Get designer copyright rights\n\nReturn designer copyright rights (`rightsType`, `versionClassification`, `remainingDays`). ' +
    'The response uses the ERP service raw `data` wrapper instead of the editor standard `result` wrapper.',
  form_apply_form_history_snapshot:
    'Apply for a form history snapshot\n\nCompatibility endpoint: validates `formUuid` and returns an empty object. ' +
    'Path parameters must be URL-encoded by the caller; the server decodes them.',
  form_check_form_name:
    'Check whether a form name exists\n\nCheck whether a form with the same name and type already exists under `ownerUuid`.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when `ownerUuid` is missing.',
  form_copy_form:
    'Copy a form\n\nCopy the source form `uuid` to `destUuid`; the target is overwritten without a duplicate-name check.</br>' +
    'Throws `DATA_NOT_FOUND` when the source form does not exist.</br>Returns the target form details; `name` is taken from the source form.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when required parameters are missing or malformed.',
  form_create_form:
    'Create a form\n\nCreate a form under `ownerUuid`.</br>Throws `REQUEST_PARAM_ILLEGAL` when `ownerUuid` is missing.</br>' +
    'Returns the new form details; `history_uuid` is the data UUID.',
  form_create_form_history:
    'Create form history record\n\nData is saved with `POST /api/editor/forms/:formUuid/snapshot/:historyUuid`.</br>' +
    'Path parameters must be URL-encoded by the caller; the server decodes them. Throws `REQUEST_PARAM_ILLEGAL` when malformed.',
  form_create_form_history_snapshot:
    'Create a form history snapshot\n\nPath parameters must be URL-encoded by the caller; the server decodes them. ' +
    '`historyUuid` is validated only; the save target is determined by `formUuid`.</br>Always returns an empty object.',
  form_delete_form:
    'Delete forms\n\nHard-delete forms, removing both the record and its data.</br>' +
    'Provide either `uuid` (single) or `uuids` (array); `uuid` takes precedence, and nothing is deleted when both are absent.</br>' +
    '`ownerUuid` is validated only; records are located by `uuid`/`uuids`.</br>Throws `DATA_NOT_FOUND` when a record does not exist.',
  form_get_form_detail:
    'Get form details\n\nLook up a form by `uuid`, which is required.</br>' +
    'When `type` is provided it is checked and a mismatch throws `DATA_NOT_FOUND`; when `name` is provided it is used as the returned `name`, otherwise the stored name is used. ' +
    '`ownerUuid` is accepted but not used for the lookup.</br>Throws `DATA_NOT_FOUND` when the record is missing or cannot be parsed.',
  form_get_form_list:
    'List forms\n\nReturn the forms under `ownerUuid`, newest first, paginated with `page` (default 1) and `pageSize` (default 100).</br>' +
    'A record that fails to parse is skipped and logged without interrupting the scan.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when `ownerUuid` is missing and `DATA_NOT_FOUND` when the owner does not exist.',
  form_search_form_history_list:
    'List form history records\n\nSingle-node model: throws `DATA_NOT_FOUND` when the form record does not exist.</br>' +
    'Returns an empty array when data is missing, otherwise a single record whose `dataStrUrl` is the data download URL (`GET /api/editor/ecadData/:dataPath`).</br>' +
    'Path parameters must be URL-encoded by the caller; the server decodes them.',
  form_update_form:
    'Update a form\n\nUpdate the form name, attributes, and other fields by `uuid`.</br>Throws `DATA_NOT_FOUND` when the form does not exist.</br>' +
    'When `name` changes, the record and its data are renamed together; an existing target name throws `DUPLICATE_DATA`, and a failed rename throws `ILLEGAL_NAME`.</br>' +
    '`ownerUuid` is validated only; the form is located by `uuid`.</br>Returns the updated form details.',
  layer_create_layer:
    'Create a layer\n\nCreate a layer under `ownerUuid` and return its basic information.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  layer_delete_layer:
    'Delete a layer\n\nDelete a layer by `uuid`.</br>`uuid` is the layer UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  layer_layer_detail:
    'Get layer details\n\nReturn layer details by `uuid`.</br>`uuid` is the layer UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  layer_layer_detail_by_name:
    'Get layer details by name\n\nLook up layer details by `ownerUuid` and the layer name `layer`.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  layer_layer_list_by_owner:
    'List layers of an owner\n\nReturn the layers of `ownerUuid`.</br>`ownerUuid` is the owner UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  layer_update_layer:
    'Update a layer\n\nUpdate layer attributes by `uuid`.</br>`uuid` is the layer UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  library_create_library: 'Create a symbol library\n\nCreate a symbol library named `name` under `ownerUuid`.',
  library_delete_libraries:
    'Delete symbol libraries in bulk\n\nDelete each symbol library in `uuids`; missing records are skipped (idempotent) and an empty object is returned when done.',
  library_detail_library:
    'Get symbol library details\n\nRead the record referenced by `uuid` and return its metadata; throws `DUPLICATE_DATA` when it does not exist.</br>' +
    '`uuid` is the symbol library UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  library_get_library_list:
    'List symbol libraries\n\nReturn the symbol library metadata directly under `ownerUuid`, paginated; a library that fails to parse is skipped and logged.',
  library_update_library:
    'Update a symbol library\n\nOverwrite only when `attributes` is non-empty, refresh `updated_at`, and rewrite the record; renaming is not supported. ' +
    'Throws `DUPLICATE_DATA` when the record does not exist.</br>`uuid` is the symbol library UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  macro_create_macro:
    'Create a macro\n\nCreate a new macro, optionally with a category and description.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  macro_delete_macro:
    'Delete a macro\n\nDelete the macro by `uuid`.</br>`uuid` is sent in the request body, not as a path parameter.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  macro_macro_detail: 'Get macro details\n\nReturn macro details by `uuid`.</br>Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  macro_macro_detail_by_name:
    'Get a macro by name\n\nLook up a macro by name and owner UUID.</br>Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  macro_macro_exists:
    'Check whether macros exist in bulk\n\nCheck a list of UUIDs for the given owner.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  macro_macro_list_by_owner:
    'List macros\n\nReturn the macros of the given owner, optionally filtered by category.</br>' +
    '`ownerUuid` is the owner UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  macro_save_as_macro:
    'Save as a new macro\n\nSave macro data as a new macro.</br>Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  macro_update_macro:
    'Update a macro\n\nUpdate the macro name, category, description, and related fields.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  part_add_accessories:
    'Add part accessories\n\nAppend accessory references to a part; referencing the part itself is forbidden, and a duplicate reference throws `DUPLICATE_DATA`.',
  part_add_drill_cut: 'Add drill-layout cuts\n\n`drillUuid` must reference a drill-layout part (`type` 3).',
  part_add_templates: 'Add part function templates\n\nA non-empty `macroUuid` must reference an existing macro, otherwise `FORBIDDEN` is thrown.',
  part_create_part: 'Create a part\n\nCreate part data under `owner_uuid` with the given `type`; `attributes` must not be empty.',
  part_data_exists: 'Check whether a part exists\n\nDecide by `name` + `type` (+ `variable`) whether the part data exists and return a boolean.',
  part_delete_accessories:
    'Delete part accessories\n\nWhen `uuids` is provided only those records are deleted; otherwise all accessories of the part are cleared.',
  part_delete_drill_cut:
    'Delete drill-layout cuts\n\nWhen `uuids` is provided only those cuts are deleted; otherwise all cuts of the drill part are cleared.',
  part_delete_part_attr: 'Delete part attributes\n\nName attributes cannot be deleted; `attrIds` must contain at least one ID.',
  part_delete_part_by_name:
    'Delete a part by name\n\nDelete the part matching the number and type under the given owner; when `variable` is provided only that variable is deleted.',
  part_delete_parts: 'Delete parts in bulk\n\nDelete each part in `uuids`; missing records are skipped (idempotent).',
  part_delete_templates:
    'Delete part function templates\n\nWhen `uuids` is provided only those templates are deleted; otherwise all templates of the part are cleared.',
  part_detail_part: 'Get part details\n\nRead part metadata and attributes by part UUID.',
  part_get_part_by_name:
    'Get a part by name\n\nFind a part by number, type, and owner; when `minVariable` is true the record with the smallest variable is returned.',
  part_get_part_categories:
    'Get parts by category level\n\nReturn the parts of the owner, type, and accessory state; `attributes` contains only the attribute IDs selected by `category`.',
  part_get_part_list: 'List parts of an owner\n\nReturn the parts under `owner_uuid`, newest first, paginated.',
  part_list_accessories: 'List part accessories\n\nReturn the accessory references of the part.',
  part_list_drill_cut: 'List drill-layout cuts\n\n`drillUuid` must reference a drill-layout part (`type` 3).',
  part_list_parts: 'List parts with filters\n\n`category` is an array of [attribute ID, attribute value]; `keyword` fuzzy-matches the part number.',
  part_list_templates: 'List part function templates\n\nReturn the part templates ordered by `sort` ascending.',
  part_update_accessories: 'Update part accessories\n\nUpdate sort order, required flag, reference, and static name by accessory record UUID.',
  part_update_drill_cut: 'Update drill-layout cuts\n\nUpdate fields by cut UUID; `drillUuid` must reference a drill-layout part (`type` 3).',
  part_update_part: 'Update a part\n\nCurrently only `accessory` (0/1) can be changed; `updated_at` is refreshed.',
  part_update_part_attr:
    'Update part attributes\n\nUpdate an attribute when it exists, otherwise create it; changing a name or variable attribute renames it in sync.',
  part_update_templates:
    'Update part function templates\n\nUpdate symbol, macro, definition, and sort by template UUID; records with unknown UUIDs are skipped.',
  plot_frame_create_plot_frame:
    'Create a plot frame\n\nCreate a plot frame under `ownerUuid`.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  plot_frame_create_plot_frame_history:
    'Create plot frame history\n\nCreate a history record for a plot frame; the body may be JSON (`dataStr`) or a raw stream.</br>' +
    '`uuid` is the plot frame UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  plot_frame_create_plot_frame_history_snapshot:
    'Create a plot frame history snapshot\n\nCreate a snapshot for the given history record; throws `REQUEST_PARAM_ILLEGAL` when `historyUuid` is missing.',
  plot_frame_create_plot_frame_history_snapshot_2:
    'Create a plot frame history snapshot\n\nCreate a snapshot for a plot frame history record; the body may be JSON (`dataStr`) or a raw stream.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  plot_frame_delete_plot_frame:
    'Delete a plot frame\n\nDelete a plot frame by `uuid`.</br>`uuid` is the plot frame UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  plot_frame_plot_frame_detail:
    'Get plot frame details\n\nReturn plot frame details by `uuid`.</br>`uuid` is the plot frame UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  plot_frame_plot_frame_list:
    'List plot frames\n\nReturn the plot frames of `ownerUuid` with pagination.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or have the wrong type.',
  plot_frame_search_plot_frame_history_list:
    'List plot frame history\n\nReturn the history records of the plot frame.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  plot_frame_update_plot_frame:
    'Update a plot frame\n\nUpdate the plot frame name and attributes by `uuid`.</br>`uuid` is the plot frame UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing.',
  project_branch_get_project_branch_detail:
    'Branch details\n\nReturn branch details by `branchUuid`.</br>Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Migration is pending; currently returns empty data.',
  project_branch_get_project_branch_list:
    'Branch list\n\nReturn the branches of a project.</br>Path parameters must be URL-encoded by the caller and the server decodes them.',
  project_create_project:
    'Create a project\n\n`name` is required and one of `ownerUuid`/`owner_uuid` must be provided. ' +
    'An existing project with the same name throws `DUPLICATE_DATA` unless `replace: true` is passed.</br>The response matches the project details endpoint.',
  project_delete_project: 'Delete a project\n\nDelete the project.',
  project_get_example_projects: 'List example projects\n\nReturn the example projects.',
  project_get_project_detail:
    'Get project details\n\nReturn project details by `projectUuid`.</br>Path parameters must be URL-encoded by the caller and the server decodes them.',
  project_get_project_logs:
    'Get project operation logs\n\nReturn project operation logs.</br>`uuid` is the project UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  project_project_list:
    'List projects\n\nReturn the projects owned by `ownerUuids`, newest first, in the same shape as the project details endpoint.</br>' +
    '`ownerUuids` accepts an array (`ownerUuids[]`) or a single `ownerUuid`/`owner_uuid`; when omitted the current user projects are used.</br>' +
    'Pagination is applied only when both `page` and `pageSize` are provided (`page` starts at 1); otherwise all results are returned without `page`/`pageSize` and with `totalPage` fixed to 1.</br>' +
    'Unknown owners yield an empty list; a project that fails to parse is skipped.',
  project_update_project:
    'Update project information\n\nUpdate the description (`content`), edit mode (`mode`), and name (`name`).</br>' +
    'Three equivalent routes share this endpoint: `PUT /:projectUuid`, `POST /:projectUuid/update`, and `PUT /projects` (no path parameter on the root route).</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `DATA_NOT_FOUND` when the project does not exist, and `REQUEST_PARAM_ILLEGAL` when parameters are missing or malformed.</br>' +
    'The response matches the project details endpoint, including `permissions` (all project permissions) and `rule_uuid` (fixed `1`).',
  project_update_project_2:
    'Update project information\n\nUpdate the description (`content`), edit mode (`mode`), and name (`name`).</br>' +
    'Three equivalent routes share this endpoint: `PUT /:projectUuid`, `POST /:projectUuid/update`, and `PUT /projects` (no path parameter on the root route).</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `DATA_NOT_FOUND` when the project does not exist, and `REQUEST_PARAM_ILLEGAL` when parameters are missing or malformed.</br>' +
    'The response matches the project details endpoint, including `permissions` (all project permissions) and `rule_uuid` (fixed `1`).',
  project_history_create_project_history:
    'Create project branch history (zip alias route)\n\nEquivalent to the `/histories` endpoint and shares the same logic.',
  project_history_create_project_history_2:
    'Create history record\n\nCreate a history record for a branch; the body may be JSON (`dataStr`) or a raw stream.</br>' +
    '`/histories/zip` is a frontend compression alias for this endpoint.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `DATA_NOT_FOUND` when the project does not exist, and `REQUEST_PARAM_ILLEGAL` when the branch path does not match the project path.',
  project_history_create_project_metadata:
    'Create project metadata\n\nCreate metadata for a project branch.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `DATA_NOT_FOUND` when the project does not exist, and `REQUEST_PARAM_ILLEGAL` when the branch path does not match the project path.',
  project_history_delete_project_metadata:
    'Delete project metadata\n\nDelete metadata from a project branch.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `DATA_NOT_FOUND` when the project does not exist, and `REQUEST_PARAM_ILLEGAL` when the branch path does not match the project path.',
  project_history_get_project_history_list:
    'Get history records\n\nReturn the history records of a branch.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `DATA_NOT_FOUND` when the project, branch, or history record does not exist.',
  project_history_upload_snapshot_chunk_in_parallel:
    'Create a project snapshot\n\nThe client route requires hard-coded `chunksUuid` and `chunkNumber` values; the request uses `Content-Type: application/octet-stream`.',
  symbol_create_symbol:
    'Create a symbol\n\nCreate a symbol named `title` under the `ownerUuid` symbol library and write its metadata; ' +
    'throws `DATA_NOT_FOUND` when the library is missing and `DUPLICATE_DATA` when the symbol already exists.',
  symbol_create_symbol_history:
    'Create symbol history record\n\nCreate a history record for a symbol; the body may be JSON (`dataStr`) or a raw stream.</br>' +
    '`uuid` is the symbol UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  symbol_create_symbol_history_snapshot:
    'Create a symbol history snapshot\n\nCreate a snapshot for a symbol history record; the body may be JSON (`dataStr`) or a raw stream.</br>' +
    '`uuid` is the symbol UUID and `historyUuid` is the history record UUID; path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or malformed, and `DATA_NOT_FOUND` when the symbol does not exist.',
  symbol_delete_symbol:
    'Delete symbols in bulk\n\nDelete each symbol named in `titles` from the `ownerUuid` symbol library; throws `DATA_NOT_FOUND` when the library does not exist.',
  symbol_delete_symbol_by_uuid:
    'Delete a symbol\n\nDelete a symbol by `uuid`.</br>`uuid` is the symbol UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  symbol_search_symbol_history_list:
    'List symbol history records\n\nReturn the history records of a symbol.</br>' +
    '`uuid` is the symbol UUID and `historyUuid` is the history record UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  symbol_symbol_detail:
    'Get symbol details\n\nRead the symbol record referenced by `uuid`; throws `DATA_NOT_FOUND` when the symbol library or symbol does not exist.',
  symbol_symbol_list:
    'List symbols\n\nReturn the symbols of the `ownerUuid` symbol library, paginated; throws `DATA_NOT_FOUND` when the library does not exist. ' +
    'A symbol that fails to parse is skipped and logged.',
  symbol_update_symbol:
    'Update a symbol\n\nApply a partial update from the supplied fields; an existing target name throws `DUPLICATE_DATA`, a failed rename throws `ILLEGAL_NAME`, and a missing symbol throws `DATA_NOT_FOUND`.</br>' +
    '`uuid` is the symbol UUID; path parameters must be URL-encoded by the caller and the server decodes them.',
  team_other_teams:
    'Get related teams\n\nTeams the user joined, teams the user has not joined whose project members include the user, and other personal projects with the user as a member.',
  team_team_list: 'List teams',
  user_info:
    'Get current user information\n\nReturn the signed-in user and preferences. Preference sync: use `preference_history_uuid` as `:historyUuid` with ' +
    '`GET /api/editor/v2/preference/:userUuid/histories/:historyUuid` to read the preference history chain, download the data from `dataStrUrl` ' +
    '(`/api/editor/ecadData/...`), and save with `POST /api/editor/v2/preference/:userUuid/histories` (body `dataStr`).',
  user_preference:
    'Save user preferences\n\nOverwrite the saved user preferences. Throws `REQUEST_PARAM_ILLEGAL` when `preferences` is missing or not an object.</br>Always returns `true`.',
  user_preference_create_history:
    'Create a user preference history record\n\nCreate a user preference history record; `dataStr` accepts a JSON string or a raw stream.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when `dataStr` is missing.',
  user_preference_create_history_2:
    'Create a user preference history record (v3)\n\nEquivalent to the v2 endpoint; `dataStr` is required and the returned node contains only `uuid`.',
  user_preference_create_snapshot:
    'Create a user preference snapshot\n\nCreate a snapshot; the body may be JSON (`dataStr`) or a raw stream, and `dataStr` is optional.</br>' +
    'Path parameters must be URL-encoded by the caller and the server decodes them.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or malformed.',
  user_preference_create_snapshot_2: 'Create a user preference snapshot (v3)\n\nEquivalent to the v2 endpoint; `dataStr` is optional.',
  user_preference_search_history:
    'Search user preference history\n\nSearch the preference history at the given node and its ancestor chain.</br>' +
    'Throws `REQUEST_PARAM_ILLEGAL` when parameters are missing or malformed.',
  user_preference_search_history_2:
    'Search user preference history (v3)\n\nEquivalent to the v2 endpoint; returns the given node and its ancestor chain.',
};

// Keyed by the normalized Chinese property description.
const englishPropertyDescriptions = {
  '偏好历史数据（JSON 字符串）': 'Preference history data (JSON string)',
  '偏好设置对象，整体覆盖保存（如语言等偏好项）': 'Preferences object, saved as a full overwrite (for example language)',
  '分类 UUID': 'Category UUID',
  '分类条件（[属性 ID, 属性值]）列表': 'Category conditions as [attribute ID, attribute value] pairs',
  '切口 UUID 列表；不传则清空全部': 'Cut UUIDs; omit to clear all cuts',
  切口数据列表: 'Cut data list',
  功能模板数据列表: 'Function template data list',
  历史数据: 'History data',
  '历史记录 UUID': 'History UUID',
  变量编号: 'Variable number',
  '变量编号，默认 1': 'Variable number; defaults to 1',
  '图框 UUID': 'Plot frame UUID',
  图框名称: 'Plot frame name',
  图框属性: 'Plot frame attributes',
  图框数据: 'Plot frame data',
  字号: 'Font size',
  '宏 UUID': 'Macro UUID',
  '宏 uuid': 'Macro UUID',
  '宏 uuid 列表': 'Macro UUID list',
  宏名称: 'Macro name',
  宏描述: 'Macro description',
  '宏数据 uuid': 'Macro data UUID',
  '宏数据列表，每项为 { type, description?, dataStr? }': 'Macro data list; each item is `{ type, description?, dataStr? }`',
  宏类型: 'Macro type',
  层名称: 'Layer name',
  '属性 ID 列表': 'Attribute ID list',
  '工程归属列表（归属 UUID（个人或团队）），不传时扫描默认工程归属':
    'Project owners (owner UUIDs for users or teams); when omitted, the default project owner is used',
  工程描述: 'Project description',
  工程数据: 'Project data',
  引脚数量或定位点: 'Pin count or anchor point',
  '归属 UUID': 'Owner UUID',
  '归属 UUID（个人或团队）': 'Owner UUID (user or team)',
  '归属 UUID（仅校验，不参与定位）': 'Owner UUID (validated only; not used for lookup)',
  '归属 UUID，默认当前用户': 'Owner UUID; defaults to the current user',
  快照数据: 'Snapshot data',
  '快照数据（JSON 字符串），可缺省': 'Snapshot data (JSON string); optional',
  '快照数据（缺省时取原始请求流）': 'Snapshot data; when omitted the raw request stream is used',
  '所有者 UUID': 'Owner UUID',
  '所有者 UUID（必填）': 'Owner UUID (required)',
  '所有者 UUID，与 ownerUuid 必填其一': 'Owner UUID; one of this and `ownerUuid` is required',
  '所有者 UUID，与 owner_uuid 必填其一': 'Owner UUID; one of this and `owner_uuid` is required',
  描述: 'Description',
  文本编辑器类型: 'Text editor type',
  新宏名称: 'New macro name',
  '新工程名，与当前工程名不同时触发重命名': 'New project name; a different value renames the project',
  '新符号名（改名）': 'New symbol name (rename)',
  是否取变量最小的记录: 'Whether to pick the record with the smallest variable',
  是否可见: 'Whether visible',
  '是否多变量，默认 false': 'Whether the part is multi-variant; defaults to false',
  是否打印: 'Whether printed',
  是否标准层: 'Whether a standard layer',
  '是否覆盖已存在的同名工程，默认 false': 'Whether to overwrite an existing project with the same name; defaults to false',
  是否锁定: 'Whether locked',
  '模板 UUID 列表；不传则清空全部': 'Template UUIDs; omit to clear all templates',
  每页数量: 'Page size',
  '每页数量（默认 10）': 'Page size (default 10)',
  '每页数量（默认 200）': 'Page size (default 200)',
  '每页数量，与 page 同时传递时才分页': 'Page size; pagination applies only when passed together with `page`',
  '每页数量，默认 20': 'Page size; defaults to 20',
  '每页数量，默认 50': 'Page size; defaults to 50',
  '源宏 UUID': 'Source macro UUID',
  '源表单 UUID': 'Source form UUID',
  '用户 UUID': 'User UUID',
  '目标表单 UUID': 'Target form UUID',
  符号定义内容: 'Symbol definition content',
  '符号定义（SVG/JSON 等内容）': 'Symbol definition (SVG/JSON content)',
  '符号库 UUID': 'Symbol library UUID',
  '符号库 UUID 列表（至少 1 个）': 'Symbol library UUIDs (at least 1)',
  符号库名称: 'Symbol library name',
  '符号库名称（暂不支持修改）': 'Symbol library name (renaming is not supported)',
  '符号库归属 UUID': 'Symbol library owner UUID',
  符号数据: 'Symbol data',
  符号标题: 'Symbol title',
  '符号标题列表（至少 1 个）': 'Symbol titles (at least 1)',
  符号类型: 'Symbol type',
  线型: 'Line style',
  线宽: 'Line width',
  编号: 'Number',
  编辑器数据: 'Editor data',
  编辑模式: 'Edit mode',
  自定义属性: 'Custom attributes',
  '自定义属性（必填）': 'Custom attributes (required)',
  '表单 UUID': 'Form UUID',
  '表单 UUID 列表（与 uuid 二选一，至少 1 个）': 'Form UUIDs (provide either this or `uuid`; at least 1)',
  '表单 UUID（与 uuids 二选一，优先使用）': 'Form UUID (provide either this or `uuids`; this takes precedence)',
  表单名称: 'Form name',
  '表单名称，传入时触发重命名': 'Form name; a different value renames the form',
  表单属性: 'Form attributes',
  '表单数据（兼容接收，本地不持久化）': 'Form data (accepted but not persisted)',
  '表单类型（数字）': 'Form type (number)',
  '表单记录类型列表（同名 key 重复传递，自动去重）': 'Form type list (repeated key; duplicates are removed)',
  '返回的 attributes 仅包含这些属性 ID': 'Only these attribute IDs are included in the returned `attributes`',
  '连接点逻辑，缺省为空对象': 'Connection-point logic; defaults to an empty object',
  '部件 UUID': 'Part UUID',
  '部件 UUID 列表': 'Part UUID list',
  '部件属性，键为属性 ID，值为 { value }': 'Part attributes; keys are attribute IDs and values are `{ value }`',
  部件类型: 'Part type',
  '部件类型，默认 1': 'Part type; defaults to 1',
  '部件类型：1 部件 / 2 附件 / 3 钻孔 / 4 供应商 / 5 3D 模型': 'Part type: 1 part / 2 accessory / 3 drill / 4 supplier / 5 3D model',
  部件编号: 'Part number',
  部件编号搜索关键字: 'Part number search keyword',
  '配置分组类型，对应 config/lceda-editorConfig.json 中配置项的 type': 'Configuration group type (the `type` of the configuration items)',
  '钻孔排列样式部件 UUID': 'Drill-layout part UUID',
  附件数据列表: 'Accessory data list',
  附件类型: 'Accessory type',
  '附件类型，默认 0': 'Accessory type; defaults to 0',
  '附件记录 UUID 列表；不传则清空全部': 'Accessory record UUIDs; omit to clear all accessories',
  '页码（从 1 开始，默认 1）': 'Page number (1-based; default 1)',
  '页码，与 pageSize 同时传入时分页': 'Page number; pagination applies only when passed together with `pageSize`',
  '页码，从 1 开始，与 pageSize 同时传递时才分页': 'Page number (1-based); pagination applies only when passed together with `pageSize`',
  '页码，默认 1': 'Page number; defaults to 1',
  项目名称: 'Project name',
  颜色: 'Color',
  宏数据类型: 'Macro data type',
  数据描述: 'Data description',
  宏数据内容: 'Macro data content',
  '附件部件 UUID': 'Accessory part UUID',
  '附件部件 UUID，可为空': 'Accessory part UUID; optional',
  排序值: 'Sort value',
  '是否需要该附件：0 否 / 1 是': 'Whether the accessory is required: 0 no / 1 yes',
  旧名称: 'Old name',
  '旧名称 1': 'Old name 1',
  旧变量编号: 'Old variable number',
  旧类型: 'Old type',
  钻孔类型: 'Drill type',
  子类型: 'Subtype',
  外形定义: 'Outline definition',
  'X 位置': 'X position',
  'Y 位置': 'Y position',
  '尺寸 1': 'Size 1',
  '尺寸 2': 'Size 2',
  '尺寸 3': 'Size 3',
  模板定义: 'Template definition',
  '模板 UUID': 'Template UUID',
  '关联宏 UUID': 'Linked macro UUID',
  '关联宏 UUID，可为空': 'Linked macro UUID; optional',
  '关联符号 UUID': 'Linked symbol UUID',
  '关联符号 UUID，可为空': 'Linked symbol UUID; optional',
  '附件记录 UUID': 'Accessory record UUID',
  '切口 UUID': 'Cut UUID',
};

// Raw desktop strings that normalize into awkward wording are translated directly.
const rawPropertyDescriptions = {
  '图框索引文件路径（以图框索引后缀结尾）': 'Plot frame UUID',
  '宏文件的绝对路径，仅支持 .ema / .ems 后缀': 'Macro UUID',
  归属目录路径: 'Owner UUID (user or team)',
  '源宏索引文件路径（以宏索引后缀结尾）': 'Source macro UUID',
  '源表单索引文件路径（以 .efNN 结尾）': 'Source form UUID',
  '目标表单索引文件路径（以 .efNN 结尾）': 'Target form UUID',
  符号库所在父目录路径: 'Symbol library owner UUID',
  '符号库索引文件路径列表（以 .ecsl 结尾，至少 1 个）': 'Symbol library UUIDs (at least 1)',
  '符号库索引文件路径（以 .slb 结尾）': 'Symbol library UUID',
  '符号标题（用作文件名）': 'Symbol title',
  '表单类型（与索引后缀数字对应，如 2 → .ef02）': 'Form type (number)',
  '表单索引文件名（以 .efNN 结尾）': 'Form name',
  '表单索引文件路径（以 .efNN 结尾）': 'Form UUID',
  部件文件路径: 'Part UUID',
  '部件文件路径列表（以部件类型后缀结尾）': 'Part UUID list',
  '部件编号（不含后缀）': 'Part number',
  钻孔排列样式部件文件路径: 'Drill-layout part UUID',
  '表单索引文件后缀列表（同名 key 重复传递，自动去重），如 .ef02、.ef06': 'Form type list (repeated key; duplicates are removed)',
};

const untranslated = [];

function sanitizeSchema(schema, toolName, path) {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  if (typeof schema.description === 'string' && schema.description.trim() !== '') {
    const direct = rawPropertyDescriptions[schema.description];
    if (direct !== undefined) {
      schema.description = direct;
    } else {
      const normalized = normalizeWording(schema.description);
      const english = englishPropertyDescriptions[normalized];
      schema.description = english ?? normalized;
      if (english === undefined) {
        untranslated.push(`${toolName}${path}: ${normalized}`);
      }
    }
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    sanitizeSchema(value, toolName, `${path}.${key}`);
  }
  if (schema.items !== undefined) {
    sanitizeSchema(schema.items, toolName, `${path}[]`);
  }
}

for (const row of includedRows) {
  const english = englishToolDescriptions[row.name];
  row.description = english ?? sanitizeDescription(row.description);
  if (english === undefined) {
    untranslated.push(`${row.name}: tool description`);
  }
  sanitizeSchema(row.inputSchema, row.name, '');
}

if (untranslated.length > 0) {
  console.error(`Warning: ${untranslated.length} description(s) have no English translation:`);
  for (const item of untranslated) {
    console.error(`  ${item}`);
  }
}

const groups = [
  { fileName: 'system.ts', exportName: 'systemTools', domains: ['system'] },
  { fileName: 'misc.ts', exportName: 'miscTools', domains: ['eplan', 'erp'] },
  { fileName: 'forms.ts', exportName: 'formTools', domains: ['forms'] },
  { fileName: 'layers.ts', exportName: 'layerTools', domains: ['layer'] },
  { fileName: 'libraries.ts', exportName: 'libraryTools', domains: ['libraries'] },
  { fileName: 'macros.ts', exportName: 'macroTools', domains: ['macro'] },
  { fileName: 'parts.ts', exportName: 'partTools', domains: ['parts'] },
  { fileName: 'plot-frames.ts', exportName: 'plotFrameTools', domains: ['plotFrames'] },
  { fileName: 'projects.ts', exportName: 'projectTools', domains: ['projects'] },
  { fileName: 'symbols.ts', exportName: 'symbolTools', domains: ['symbols'] },
  { fileName: 'teams.ts', exportName: 'teamTools', domains: ['teams'] },
  // Avoid clashing with the hand-written jlc_ecad_get_user tool in src/tools/user.ts.
  { fileName: 'user-tools.ts', exportName: 'userTools', domains: ['user', 'v2/preference', 'v3/preference'] },
];

const assigned = new Set();
for (const group of groups) {
  group.tools = includedRows.filter((row) => {
    const domain = domainOf(row.path);
    const matches = group.domains.includes(domain);
    if (matches) {
      assigned.add(row.name);
    }
    return matches;
  });
}

const unassigned = includedRows.filter((row) => !assigned.has(row.name));
if (unassigned.length > 0) {
  throw new Error(`Unassigned tools: ${unassigned.map((row) => row.name).join(', ')}`);
}

mkdirSync(outputDir, { recursive: true });

/**
 * Render the desktop app's JSON Schema as a Zod expression.
 *
 * The catalog only uses object/string/number/array/boolean types, string and
 * number enums, descriptions, `required`, `minItems`, and
 * `additionalProperties: true`, so this small subset is enough. Objects are
 * emitted as `z.looseObject` because the executor accepts extra keys such as
 * `__confirm` and `__query`.
 */
function renderZodSchema(schema, indent) {
  const pad = ' '.repeat(indent);
  const description = typeof schema?.description === 'string' ? `.describe(${JSON.stringify(schema.description)})` : '';

  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    return `z.unknown()${description}`;
  }

  let code;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    if (values.length === 0) {
      code = 'z.never()';
    } else if (values.every((value) => typeof value === 'string')) {
      code = `z.enum(${JSON.stringify(values)})`;
    } else {
      code = `z.literal(${JSON.stringify(values)})`;
    }
  } else if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = schema.properties ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(properties).map(([key, value]) => {
      const optional = required.has(key) ? '' : '.optional()';
      return `${' '.repeat(indent + 2)}${JSON.stringify(key)}: ${renderZodSchema(value, indent + 2)}${optional},`;
    });
    const factory = schema.additionalProperties === false ? 'z.strictObject' : 'z.looseObject';
    code = entries.length === 0 ? `${factory}({})` : `${factory}({\n${entries.join('\n')}\n${pad}})`;
  } else if (schema.type === 'array' || schema.items !== undefined) {
    code = `z.array(${renderZodSchema(schema.items ?? {}, indent)})`;
    if (typeof schema.minItems === 'number') {
      code += `.min(${schema.minItems})`;
    }
  } else if (schema.type === 'string') {
    code = 'z.string()';
  } else if (schema.type === 'number') {
    code = 'z.number()';
  } else if (schema.type === 'integer') {
    code = 'z.number().int()';
  } else if (schema.type === 'boolean') {
    code = 'z.boolean()';
  } else if (schema.type === 'null') {
    code = 'z.null()';
  } else {
    code = 'z.unknown()';
  }

  return `${code}${description}`;
}

/**
 * The executor may fill an optional `ownerUuid`/`owner_uuid` from the current
 * user. Required owner parameters are never filled implicitly: the caller has
 * to choose the owner explicitly, so the executor needs to know both groups.
 */
function ownerParamsOf(schema) {
  const properties = schema && typeof schema === 'object' ? (schema.properties ?? {}) : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const ownerKeys = ['ownerUuid', 'owner_uuid'].filter((key) => key in properties);
  if (ownerKeys.length === 0) {
    return undefined;
  }
  return {
    optional: ownerKeys.filter((key) => !required.includes(key)),
    required: ownerKeys.filter((key) => required.includes(key)),
  };
}

function renderTool(tool) {
  const ownerParams = ownerParamsOf(tool.inputSchema);
  return [
    '  {',
    `    name: ${JSON.stringify(tool.name)},`,
    `    description: ${JSON.stringify(tool.description)},`,
    `    path: ${JSON.stringify(tool.path)},`,
    `    method: ${JSON.stringify(tool.method)},`,
    `    danger: ${String(tool.danger)},`,
    ...(ownerParams === undefined ? [] : [`    ownerParams: ${JSON.stringify(ownerParams)},`]),
    `    inputSchema: ${renderZodSchema(tool.inputSchema, 4)},`,
    '  },',
  ].join('\n');
}

const header = [
  '// Generated by scripts/import-ecad-catalog.mjs. Do not edit by hand.',
  `// Source: ${sourcePath}`,
  '// The catalog mirrors the JLC ECAD desktop app MCP tools; rerun the importer',
  '// after updating the desktop app.',
  '',
  "import { z } from 'zod';",
  '',
  "import type { EcadToolDefinition } from '../ecad/types.js';",
  '',
].join('\n');

for (const group of groups) {
  const body = group.tools.map(renderTool).join('\n');
  const content = `${header}export const ${group.exportName}: EcadToolDefinition[] = [\n${body}\n];\n`;
  writeFileSync(join(outputDir, group.fileName), content);
}

const indexContent = [
  '// Generated by scripts/import-ecad-catalog.mjs. Do not edit by hand.',
  '',
  "import type { EcadToolDefinition } from '../ecad/types.js';",
  ...groups.map((group) => `import { ${group.exportName} } from './${group.fileName.replace(/\.ts$/, '.js')}';`),
  '',
  'export const ECAD_TOOLS: readonly EcadToolDefinition[] = [',
  ...groups.map((group) => `  ...${group.exportName},`),
  '];',
  '',
  'export const ECAD_TOOL_MAP = new Map(ECAD_TOOLS.map((tool) => [tool.name, tool]));',
  '',
].join('\n');
writeFileSync(join(outputDir, 'index.ts'), indexContent);

const readme = `# ECAD tools

Most files in this directory are generated from the JLC ECAD desktop app's MCP
catalog; do not edit the generated ones by hand. The hand-written tools are
\`user.ts\` (\`jlc_ecad_get_user\` and user settings), \`auth.ts\` (\`jlc_ecad_login\`), \`eda.ts\` (the
EDA component/device searches), \`parts-web.ts\` (web-only parts endpoints),
\`product.ts\` (product catalog endpoints), \`rights.ts\` (ERP/member endpoints),
\`beta.ts\` (beta program), \`category.ts\` (category endpoints),
\`macro-upload.ts\` (macro data upload), \`team.ts\` (team management), and the
shared helper \`format.ts\`.

- Source: \`${sourcePath}\`
- Tools: ${includedRows.length}
- Destructive tools: ${includedRows.filter((row) => row.danger).length}
- Excluded domains (desktop-app local server only): ${[...excludedDomains].join(', ')}
- Assumed HTTP methods (no matching local route): ${[...assumedGet].filter((name) => includedRows.some((row) => row.name === name)).join(', ')}

Each generated file contains one domain and exports an
\`EcadToolDefinition[]\` whose \`inputSchema\` is a Zod schema converted from the
desktop app's JSON Schema; \`index.ts\` aggregates them into \`ECAD_TOOLS\` and
\`ECAD_TOOL_MAP\`. Descriptions are English translations that use owner/UUID
wording instead of the desktop app's local file and directory details. The
executor in \`src/ecad/executor.ts\` calls the corresponding endpoint under
\`JLC_ECAD_BASE_URL\`.

Some \`system_*\` tools are implemented by the desktop app's local server rather
than the public website. Point \`JLC_ECAD_BASE_URL\` at that local server when
using them.

Regenerate after a JLC ECAD update:

\`\`\`bash
node scripts/import-ecad-catalog.mjs /path/to/resources/app/server.js
pnpm run fmt
\`\`\`
`;
writeFileSync(join(outputDir, 'README.md'), readme);

console.log(`Imported ${includedRows.length} tools (${includedRows.filter((row) => row.danger).length} destructive).`);
for (const group of groups) {
  console.log(`  ${group.fileName}: ${group.tools.length}`);
}
