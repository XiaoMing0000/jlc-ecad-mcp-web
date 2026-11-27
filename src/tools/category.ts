import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { requestTool } from './api-tool.js';
import { destructiveConfirmation } from './format.js';

// Category endpoints from the web API; not part of the desktop-app catalog.
const CATEGORIES_PATH = '/api/editor/categories';

export const CREATE_CATEGORY_TOOL = {
  name: 'jlc_ecad_create_category',
  title: 'Create a category',
  description: 'Create a category with POST /api/editor/categories. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    name: z.string().describe('Category name.'),
    type: z.number().int().describe('Category type; the editor currently uses 6.'),
    user_uuid: z.string().describe('Owner UUID: a user UUID or a team UUID.'),
    parent_uuid: z.string().optional().describe('Parent category UUID; omit for a root category.'),
    order_no: z.number().int().describe('Sort order.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const LIST_CATEGORIES_TOOL = {
  name: 'jlc_ecad_list_categories',
  title: 'List categories',
  description:
    'Read categories with GET /api/editor/categories?user_uuid=...&type[]=... . ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    user_uuid: z.string().describe('Owner UUID: a user UUID or a team UUID.'),
    type: z.array(z.number().int()).describe('Category types; the editor currently uses [6].'),
  }),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const DELETE_CATEGORY_TOOL = {
  name: 'jlc_ecad_delete_category',
  title: 'Delete a category',
  description:
    'Delete a category with POST /api/editor/categories/:uuid/delete. ' +
    'Call it without __confirm first, ask the user to confirm, then call again with {"__confirm": true}. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    uuid: z.string().describe('Category UUID to delete.'),
    __confirm: z.boolean().optional().describe('Set to true only after the user confirms the deletion.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const UPDATE_CATEGORY_TOOL = {
  name: 'jlc_ecad_update_category',
  title: 'Update a category',
  description: 'Update a category with POST /api/editor/categories/:uuid. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    uuid: z.string().describe('Category UUID to update.'),
    name: z.string().describe('Category name.'),
    parent_uuid: z.string().optional().describe('Parent category UUID; omit to keep the current parent.'),
    order_no: z.number().int().optional().describe('Sort order; omit to keep the current order.'),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export async function handleCreateCategory(args: z.infer<typeof CREATE_CATEGORY_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(CREATE_CATEGORY_TOOL.name, {
    method: 'POST',
    path: CATEGORIES_PATH,
    body: {
      name: args.name,
      type: args.type,
      user_uuid: args.user_uuid,
      parent_uuid: args.parent_uuid,
      order_no: args.order_no,
    },
  });
}

export async function handleListCategories(args: z.infer<typeof LIST_CATEGORIES_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(LIST_CATEGORIES_TOOL.name, {
    method: 'GET',
    path: CATEGORIES_PATH,
    query: { user_uuid: args.user_uuid, type: args.type },
  });
}

export async function handleDeleteCategory(args: z.infer<typeof DELETE_CATEGORY_TOOL.inputSchema>): Promise<CallToolResult> {
  if (args.__confirm !== true) {
    return destructiveConfirmation(DELETE_CATEGORY_TOOL.name);
  }
  return requestTool(DELETE_CATEGORY_TOOL.name, {
    method: 'POST',
    path: `${CATEGORIES_PATH}/${encodeURIComponent(args.uuid)}/delete`,
    body: {},
  });
}

export async function handleUpdateCategory(args: z.infer<typeof UPDATE_CATEGORY_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(UPDATE_CATEGORY_TOOL.name, {
    method: 'POST',
    path: `${CATEGORIES_PATH}/${encodeURIComponent(args.uuid)}`,
    body: { name: args.name, parent_uuid: args.parent_uuid, order_no: args.order_no },
  });
}
