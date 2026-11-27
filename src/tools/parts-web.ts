import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { requestTool } from './api-tool.js';
import { destructiveConfirmation } from './format.js';

// Web-only parts endpoints that are not part of the desktop-app catalog.
const ORDER_BOM_PATH = '/api/editor/parts/orderBom';
const PRODUCTION_PATH = '/api/editor/parts/production';
const SEARCH_PUBLIC_PATH = '/api/editor/parts/searchPublic';

export const ORDER_PART_BOM_TOOL = {
  name: 'jlc_ecad_order_part_bom',
  title: 'Order a part BOM',
  description:
    'Place a part BOM order with POST /api/editor/parts/orderBom. ' +
    'This is an outward-facing order, so call it without __confirm first, ask the user to confirm, ' +
    'then call again with {"__confirm": true}. Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    list: z.array(z.record(z.string(), z.unknown())).describe('BOM line items, forwarded unchanged.'),
    bom_name: z.string().describe('BOM name.'),
    customer_code: z.string().describe('Customer code.'),
    __confirm: z.boolean().optional().describe('Set to true only after the user confirms the order.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const ADD_PART_PRODUCTION_TOOL = {
  name: 'jlc_ecad_add_part_production',
  title: 'Add part production tabs',
  description: 'Add production tabs to a part with POST /api/editor/parts/production. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    partUuid: z.string().describe('Part UUID the production tabs belong to.'),
    data: z
      .array(
        z.looseObject({
          drillUuid: z.string().optional().describe('Drill record UUID referenced by the tab, if any.'),
          name: z.string().optional().describe('Production tab name.'),
          offsetX: z.number().describe('X offset.'),
          offsetY: z.number().describe('Y offset.'),
          sort: z.number().describe('Sort order.'),
        }),
      )
      .describe('Production tabs to add; items must not carry a uuid.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const UPDATE_PART_PRODUCTION_TOOL = {
  name: 'jlc_ecad_update_part_production',
  title: 'Update part production tabs',
  description: 'Update production tabs of a part with POST /api/editor/parts/production. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    partUuid: z.string().describe('Part UUID the production tabs belong to.'),
    data: z
      .array(
        z.looseObject({
          uuid: z.string().describe('Production tab UUID to update.'),
          drillUuid: z.string().optional().describe('Drill record UUID referenced by the tab, if any.'),
          name: z.string().optional().describe('Production tab name.'),
          offsetX: z.number().optional().describe('X offset.'),
          offsetY: z.number().optional().describe('Y offset.'),
          sort: z.number().optional().describe('Sort order.'),
        }),
      )
      .describe('Production tabs to update; each item needs its uuid.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const DELETE_PART_PRODUCTION_TOOL = {
  name: 'jlc_ecad_delete_part_production',
  title: 'Delete part production tabs',
  description:
    'Delete production tabs from a part with DELETE /api/editor/parts/production. ' +
    'Call it without __confirm first, ask the user to confirm, then call again with {"__confirm": true}. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    partUuid: z.string().describe('Part UUID the production tabs belong to.'),
    uuids: z.array(z.string()).describe('Production tab UUIDs to delete.'),
    __confirm: z.boolean().optional().describe('Set to true only after the user confirms the deletion.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const GET_PART_PRODUCTION_TOOL = {
  name: 'jlc_ecad_get_part_production',
  title: 'Get part production tabs',
  description:
    "Read a part's production tabs with GET /api/editor/parts/production?partUuid=... . " + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    partUuid: z.string().describe('Part UUID whose production tabs to read.'),
  }),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const SEARCH_PUBLIC_PARTS_TOOL = {
  name: 'jlc_ecad_search_public_parts',
  title: 'Search public parts',
  description: 'Search the public part catalog with GET /api/editor/parts/searchPublic. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    keyword: z.string().describe('Search keyword.'),
    type: z.number().describe('Part type expected by the editor API.'),
    accessory: z.number().optional().describe('Optional accessory type filter.'),
    page: z.number().int().min(1).describe('1-based page number.'),
    pageSize: z.number().int().min(1).describe('Page size.'),
  }),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleOrderPartBom(args: z.infer<typeof ORDER_PART_BOM_TOOL.inputSchema>): Promise<CallToolResult> {
  if (args.__confirm !== true) {
    return destructiveConfirmation(ORDER_PART_BOM_TOOL.name);
  }
  return requestTool(ORDER_PART_BOM_TOOL.name, {
    method: 'POST',
    path: ORDER_BOM_PATH,
    body: { list: args.list, bom_name: args.bom_name, customer_code: args.customer_code },
  });
}

export async function handleAddPartProduction(args: z.infer<typeof ADD_PART_PRODUCTION_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(ADD_PART_PRODUCTION_TOOL.name, {
    method: 'POST',
    path: PRODUCTION_PATH,
    body: { partUuid: args.partUuid, data: args.data },
  });
}

export async function handleUpdatePartProduction(args: z.infer<typeof UPDATE_PART_PRODUCTION_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(UPDATE_PART_PRODUCTION_TOOL.name, {
    method: 'POST',
    path: PRODUCTION_PATH,
    body: { partUuid: args.partUuid, data: args.data },
  });
}

export async function handleDeletePartProduction(args: z.infer<typeof DELETE_PART_PRODUCTION_TOOL.inputSchema>): Promise<CallToolResult> {
  if (args.__confirm !== true) {
    return destructiveConfirmation(DELETE_PART_PRODUCTION_TOOL.name);
  }
  return requestTool(DELETE_PART_PRODUCTION_TOOL.name, {
    method: 'DELETE',
    path: PRODUCTION_PATH,
    body: { partUuid: args.partUuid, uuids: args.uuids },
  });
}

export async function handleGetPartProduction(args: z.infer<typeof GET_PART_PRODUCTION_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(GET_PART_PRODUCTION_TOOL.name, {
    method: 'GET',
    path: PRODUCTION_PATH,
    query: { partUuid: args.partUuid },
  });
}

export async function handleSearchPublicParts(args: z.infer<typeof SEARCH_PUBLIC_PARTS_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(SEARCH_PUBLIC_PARTS_TOOL.name, {
    method: 'GET',
    path: SEARCH_PUBLIC_PATH,
    query: {
      keyword: args.keyword,
      type: args.type,
      accessory: args.accessory,
      page: args.page,
      pageSize: args.pageSize,
    },
  });
}
