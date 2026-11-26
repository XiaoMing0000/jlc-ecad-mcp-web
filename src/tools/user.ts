import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getEditorUser } from '../api/user.js';
import { getSessionFilePath } from '../config.js';
import { logDebug } from '../logger.js';
import { isRecord } from '../utils.js';
import { requestTool } from './api-tool.js';
import { formatToolError } from './format.js';

const USER_PATH = '/api/editor/user';

export const GET_USER_TOOL = {
  name: 'jlc_ecad_get_user',
  title: 'Get JLC EDA user profile',
  description:
    'Get the profile of the currently logged-in JLC EDA (jlc-ecad.com) user by calling GET /api/editor/user. ' +
    'Returns the raw JSON response from the JLC EDA editor backend. ' +
    `Authentication uses cookies stored locally via JLC_ECAD_COOKIE or ${getSessionFilePath()}. ` +
    'If no valid session is available, ask the user whether they want to sign in. Preferred: run ' +
    '`npx -y jlc-ecad-mcp login` (or `node dist/index.js login` from the repository) in a terminal, then call this tool again. ' +
    'If the client cannot run shell commands, call jlc_ecad_login with {"confirm": true}.',
  inputSchema: z.looseObject({}),
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleGetUser(): Promise<CallToolResult> {
  try {
    const result = await getEditorUser();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug(`jlc_ecad_get_user failed: ${message}`);
    return {
      isError: true,
      content: [{ type: 'text', text: formatToolError(error, message) }],
    };
  }
}

const agreementSchema = z.looseObject({});

const userLogsSchema = z.looseObject({
  page: z.number().int().min(1).optional().describe('1-based page number.'),
  pageSize: z.number().int().min(1).optional().describe('Page size.'),
  startTime: z.number().optional().describe('Start timestamp.'),
  endTime: z.number().optional().describe('End timestamp.'),
  sort: z.string().optional().describe('Sort order, for example "desc" or "asc".'),
});

const searchUsersSchema = z.looseObject({
  q: z.number().int().describe('Search value, sent as `q`.'),
  limit: z.number().int().min(1).describe('Maximum number of results.'),
});

const updateUserSchema = z.looseObject({
  nickname: z.string().describe('New nickname.'),
  avatar: z.string().describe('New avatar.'),
});

const getUserByUuidSchema = z.looseObject({
  uuid: z.string().describe('User UUID.'),
});

export const ACCEPT_AGREEMENT_TOOL = {
  name: 'jlc_ecad_accept_user_agreement',
  title: 'Accept the user agreement',
  description:
    'Accept the unified JLC EDA privacy agreement with POST /api/editor/user/agreement. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: agreementSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const GET_USER_LOGS_TOOL = {
  name: 'jlc_ecad_get_user_logs',
  title: 'Get user operation logs',
  description: 'Read the signed-in user operation logs with GET /api/editor/user/logs. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: userLogsSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export const SEARCH_USERS_TOOL = {
  name: 'jlc_ecad_search_users',
  title: 'Search users',
  description: 'Search users with GET /api/editor/user/search?q=...&limit=... . ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: searchUsersSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export const UPDATE_USER_TOOL = {
  name: 'jlc_ecad_update_user',
  title: 'Update user profile',
  description: 'Update the signed-in user profile with POST /api/editor/user. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: updateUserSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const GET_USER_BY_UUID_TOOL = {
  name: 'jlc_ecad_get_user_by_uuid',
  title: 'Get another user profile',
  description: 'Read the profile of a specific user with GET /api/editor/user/:uuid. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: getUserByUuidSchema,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export async function handleAcceptAgreement(args: unknown): Promise<CallToolResult> {
  return requestTool(ACCEPT_AGREEMENT_TOOL.name, {
    method: 'POST',
    path: `${USER_PATH}/agreement`,
    body: isRecord(args) ? args : {},
  });
}

export async function handleGetUserLogs(args: z.infer<typeof userLogsSchema>): Promise<CallToolResult> {
  return requestTool(GET_USER_LOGS_TOOL.name, {
    method: 'GET',
    path: `${USER_PATH}/logs`,
    query: {
      page: args.page,
      pageSize: args.pageSize,
      startTime: args.startTime,
      endTime: args.endTime,
      sort: args.sort,
    },
  });
}

export async function handleSearchUsers(args: z.infer<typeof searchUsersSchema>): Promise<CallToolResult> {
  return requestTool(SEARCH_USERS_TOOL.name, {
    method: 'GET',
    path: `${USER_PATH}/search`,
    query: { q: args.q, limit: args.limit },
  });
}

export async function handleUpdateUser(args: z.infer<typeof updateUserSchema>): Promise<CallToolResult> {
  return requestTool(UPDATE_USER_TOOL.name, {
    method: 'POST',
    path: USER_PATH,
    body: { nickname: args.nickname, avatar: args.avatar },
  });
}

export async function handleGetUserByUuid(args: z.infer<typeof getUserByUuidSchema>): Promise<CallToolResult> {
  return requestTool(GET_USER_BY_UUID_TOOL.name, {
    method: 'GET',
    path: `${USER_PATH}/${encodeURIComponent(args.uuid)}`,
  });
}
