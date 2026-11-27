import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../api/client.js';
import { JlcEcadApiError } from '../api/errors.js';
import { logDebug } from '../logger.js';
import { isRecord } from '../utils.js';
import { requestTool } from './api-tool.js';
import { formatToolError } from './format.js';

// Web-only macro data upload; the generated desktop catalog lives in macros.ts.
const MACRO_PATH = '/api/editor/macro';
const DEFAULT_CONTENT_TYPE = 'stream';

export const UPLOAD_MACRO_DATA_TOOL = {
  name: 'jlc_ecad_upload_macro_data',
  title: 'Upload macro data',
  description:
    'Upload macro data with PUT /api/editor/macro/:uuid/:macroDataUuid. ' +
    'macroDataUuid is the `uuid` of an entry in the macro detail `variables`; when it is omitted it is resolved from GET /api/editor/macro. ' +
    `Pass the payload as base64 in dataBase64; it is sent as raw bytes with Content-Type "${DEFAULT_CONTENT_TYPE}" by default. ` +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    uuid: z.string().describe('Macro UUID.'),
    macroDataUuid: z
      .string()
      .optional()
      .describe(
        'Macro data UUID: the `uuid` of one entry in the macro detail `variables` (GET /api/editor/macro?uuid=...). ' +
          'Resolved from the macro detail when omitted.',
      ),
    type: z
      .number()
      .int()
      .optional()
      .describe('Macro data type (`variables[].type`) used to pick the entry when macroDataUuid is omitted; defaults to the first entry.'),
    dataBase64: z.string().describe('Macro payload as a base64 string; it is decoded and sent as raw bytes.'),
    contentType: z.string().optional().describe(`Content-Type header; defaults to "${DEFAULT_CONTENT_TYPE}".`),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export async function handleUploadMacroData(args: z.infer<typeof UPLOAD_MACRO_DATA_TOOL.inputSchema>): Promise<CallToolResult> {
  try {
    const macroDataUuid = args.macroDataUuid ? args.macroDataUuid : await resolveMacroDataUuid(args.uuid, args.type);
    return await requestTool(UPLOAD_MACRO_DATA_TOOL.name, {
      method: 'PUT',
      path: `${MACRO_PATH}/${encodeURIComponent(args.uuid)}/${encodeURIComponent(macroDataUuid)}`,
      rawBody: Buffer.from(args.dataBase64, 'base64'),
      contentType: args.contentType ?? DEFAULT_CONTENT_TYPE,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`${UPLOAD_MACRO_DATA_TOOL.name} failed: ${message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: formatToolError(error, message) }],
    };
  }
}

/**
 * Pick the macro data UUID from the macro detail response. The editor backend
 * may wrap the payload in { success, code, result }, so accept both shapes.
 */
async function resolveMacroDataUuid(macroUuid: string, type?: number): Promise<string> {
  const response = await apiRequest({
    method: 'GET',
    path: MACRO_PATH,
    query: { uuid: macroUuid },
    retryTool: UPLOAD_MACRO_DATA_TOOL.name,
  });

  const payload = isRecord(response.data) && isRecord(response.data.result) ? response.data.result : response.data;
  const variables = isRecord(payload) && Array.isArray(payload.variables) ? payload.variables : [];
  const entry = variables.find(
    (variable) =>
      isRecord(variable) && typeof variable.uuid === 'string' && variable.uuid !== '' && (type === undefined || Number(variable.type) === type),
  );

  if (!isRecord(entry) || typeof entry.uuid !== 'string') {
    throw new JlcEcadApiError(
      type === undefined
        ? `Macro ${macroUuid} has no macro data, so macroDataUuid cannot be resolved. Pass macroDataUuid explicitly.`
        : `Macro ${macroUuid} has no macro data of type ${type}, so macroDataUuid cannot be resolved. Pass macroDataUuid explicitly.`,
    );
  }

  return entry.uuid;
}
