import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { requestTool } from './api-tool.js';

// Web-only macro data upload; the generated desktop catalog lives in macros.ts.
const MACRO_PATH = '/api/editor/macro';
const DEFAULT_CONTENT_TYPE = 'stream';

const uploadMacroDataSchema = z.looseObject({
  uuid: z.string().describe('Macro UUID.'),
  dataBase64: z.string().describe('Macro payload as a base64 string; it is decoded and sent as raw bytes.'),
  contentType: z.string().optional().describe(`Content-Type header; defaults to "${DEFAULT_CONTENT_TYPE}".`),
});

export const UPLOAD_MACRO_DATA_TOOL = {
  name: 'jlc_ecad_upload_macro_data',
  title: 'Upload macro data',
  description:
    'Upload macro data with PUT /api/editor/macro/:uuid/macroDataUuid. ' +
    `Pass the payload as base64 in dataBase64; it is sent as raw bytes with Content-Type "${DEFAULT_CONTENT_TYPE}" by default. ` +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: uploadMacroDataSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export async function handleUploadMacroData(args: z.infer<typeof uploadMacroDataSchema>): Promise<CallToolResult> {
  return requestTool(UPLOAD_MACRO_DATA_TOOL.name, {
    method: 'PUT',
    path: `${MACRO_PATH}/${encodeURIComponent(args.uuid)}/macroDataUuid`,
    rawBody: Buffer.from(args.dataBase64, 'base64'),
    contentType: args.contentType ?? DEFAULT_CONTENT_TYPE,
  });
}
