import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { requestTool } from './api-tool.js';
import { destructiveConfirmation } from './format.js';

// Web-only team management endpoints; the generated desktop catalog lives in teams.ts.
const TEAMS_PATH = '/api/editor/teams';

function teamPath(teamUuid: string, suffix: string): string {
  return `${TEAMS_PATH}/${encodeURIComponent(teamUuid)}${suffix}`;
}

export const ADD_TEAM_MEMBER_TOOL = {
  name: 'jlc_ecad_add_team_member',
  title: 'Add a team member',
  description: 'Add a member to a team with POST /api/editor/teams/:uuid/members/add. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    memberUuid: z.string().describe('Member user UUID (sent as body `uuid`).'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

export const CREATE_TEAM_TOOL = {
  name: 'jlc_ecad_create_team',
  title: 'Create a team',
  description: 'Create a team with POST /api/editor/teams/create. Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    username: z.string().describe('Team username.'),
    members: z.array(z.string()).describe('Member user UUIDs.'),
    avatar: z.string().optional().describe('Team avatar.'),
    nickname: z.string().optional().describe('Team nickname.'),
    introduction: z.string().optional().describe('Team introduction.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

export const DELETE_TEAM_TOOL = {
  name: 'jlc_ecad_delete_team',
  title: 'Delete a team',
  description:
    'Delete a team with POST /api/editor/teams/:uuid/delete. ' +
    'Call it without __confirm first, ask the user to confirm, then call again with {"__confirm": true}. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID to delete.'),
    __confirm: z.boolean().optional().describe('Set to true only after the user confirms the deletion.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export const LIST_TEAMS_TOOL = {
  name: 'jlc_ecad_list_teams',
  title: 'List teams',
  description: 'List teams with GET /api/editor/teams. Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    page: z.number().int().min(1).describe('1-based page number.'),
    pageSize: z.number().int().min(1).describe('Page size.'),
    type: z.string().describe('Team type filter, passed through unchanged.'),
    form: z.string().describe('Team form filter, passed through unchanged.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export const GET_TEAM_LOGS_TOOL = {
  name: 'jlc_ecad_get_team_logs',
  title: 'Get team operation logs',
  description: "Read a team's operation logs with GET /api/editor/teams/:uuid/logs. " + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    search: z.string().describe('Log search keyword.'),
    startTime: z.number().describe('Start timestamp.'),
    endTime: z.number().describe('End timestamp.'),
    sort: z.string().describe('Sort order, passed through unchanged.'),
    page: z.number().int().min(1).optional().describe('1-based page number.'),
    pageSize: z.number().int().min(1).optional().describe('Page size.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export const GET_OTHER_TEAMS_TOOL = {
  name: 'jlc_ecad_get_other_teams',
  title: 'Get related teams',
  description:
    'Read the teams the user joined, teams that reference the user through project membership, and other personal projects with the user as a member, using GET /api/editor/teams/otherTeams. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({}),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export const REMOVE_TEAM_MEMBER_TOOL = {
  name: 'jlc_ecad_remove_team_member',
  title: 'Remove a team member',
  description:
    'Remove a member from a team with POST /api/editor/teams/:uuid/members/remove. ' +
    'Call it without __confirm first, ask the user to confirm, then call again with {"__confirm": true}. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    memberUuid: z.string().describe('Member user UUID (sent as body `uuid`).'),
    remove_project_member: z.string().describe('Forwarded unchanged to the API.'),
    __confirm: z.boolean().optional().describe('Set to true only after the user confirms the removal.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export const GET_TEAM_INFO_TOOL = {
  name: 'jlc_ecad_get_team_info',
  title: 'Get team details',
  description: 'Read team details with GET /api/editor/teams/:uuid/teamInfo. Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
};

export const TRANSFER_TEAM_TOOL = {
  name: 'jlc_ecad_transfer_team',
  title: 'Transfer a team',
  description:
    'Transfer team ownership with POST /api/editor/teams/:uuid/transfer. ' +
    'Call it without __confirm first, ask the user to confirm, then call again with {"__confirm": true}. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    newOwnerUuid: z.string().describe('New owner user UUID (sent as body `uuid`).'),
    __confirm: z.boolean().optional().describe('Set to true only after the user confirms the transfer.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export const UPDATE_TEAM_TOOL = {
  name: 'jlc_ecad_update_team',
  title: 'Update a team',
  description: 'Update team information with POST /api/editor/teams/:uuid/update. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    nickname: z.string().describe('Team nickname.'),
    avatar: z.string().optional().describe('Team avatar.'),
    introduction: z.string().optional().describe('Team introduction.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

export const UPDATE_TEAM_MEMBER_ROLE_TOOL = {
  name: 'jlc_ecad_update_team_member_role',
  title: 'Update a team member role',
  description:
    'Update a team member role with POST /api/editor/teams/:uuid/members/:memberUuid/update. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    memberUuid: z.string().describe('Member user UUID (path parameter).'),
    role: z.string().describe('New member role.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

export const UPDATE_TEAM_MEMBER_REMARK_TOOL = {
  name: 'jlc_ecad_update_team_member_remark',
  title: 'Update a team member remark',
  description:
    'Update a team member remark with POST /api/editor/teams/:uuid/updateRemark. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: z.looseObject({
    teamUuid: z.string().describe('Team UUID (path parameter).'),
    memberUuid: z.string().describe('Member user UUID (sent as body `uuid`).'),
    remark: z.string().describe('Member remark.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};

export async function handleAddTeamMember(args: z.infer<typeof ADD_TEAM_MEMBER_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(ADD_TEAM_MEMBER_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, '/members/add'),
    body: { uuid: args.memberUuid },
  });
}

export async function handleCreateTeam(args: z.infer<typeof CREATE_TEAM_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(CREATE_TEAM_TOOL.name, {
    method: 'POST',
    path: `${TEAMS_PATH}/create`,
    body: {
      username: args.username,
      members: args.members,
      avatar: args.avatar,
      nickname: args.nickname,
      introduction: args.introduction,
    },
  });
}

export async function handleDeleteTeam(args: z.infer<typeof DELETE_TEAM_TOOL.inputSchema>): Promise<CallToolResult> {
  if (args.__confirm !== true) {
    return destructiveConfirmation(DELETE_TEAM_TOOL.name);
  }
  return requestTool(DELETE_TEAM_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, '/delete'),
    body: {},
  });
}

export async function handleListTeams(args: z.infer<typeof LIST_TEAMS_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(LIST_TEAMS_TOOL.name, {
    method: 'GET',
    path: TEAMS_PATH,
    query: { page: args.page, pageSize: args.pageSize, type: args.type, form: args.form },
  });
}

export async function handleGetTeamLogs(args: z.infer<typeof GET_TEAM_LOGS_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(GET_TEAM_LOGS_TOOL.name, {
    method: 'GET',
    path: teamPath(args.teamUuid, '/logs'),
    query: {
      page: args.page,
      pageSize: args.pageSize,
      search: args.search,
      startTime: args.startTime,
      endTime: args.endTime,
      sort: args.sort,
    },
  });
}

export async function handleGetOtherTeams(): Promise<CallToolResult> {
  return requestTool(GET_OTHER_TEAMS_TOOL.name, { method: 'GET', path: `${TEAMS_PATH}/otherTeams` });
}

export async function handleRemoveTeamMember(args: z.infer<typeof REMOVE_TEAM_MEMBER_TOOL.inputSchema>): Promise<CallToolResult> {
  if (args.__confirm !== true) {
    return destructiveConfirmation(REMOVE_TEAM_MEMBER_TOOL.name);
  }
  return requestTool(REMOVE_TEAM_MEMBER_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, '/members/remove'),
    body: { uuid: args.memberUuid, remove_project_member: args.remove_project_member },
  });
}

export async function handleGetTeamInfo(args: z.infer<typeof GET_TEAM_INFO_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(GET_TEAM_INFO_TOOL.name, {
    method: 'GET',
    path: teamPath(args.teamUuid, '/teamInfo'),
  });
}

export async function handleTransferTeam(args: z.infer<typeof TRANSFER_TEAM_TOOL.inputSchema>): Promise<CallToolResult> {
  if (args.__confirm !== true) {
    return destructiveConfirmation(TRANSFER_TEAM_TOOL.name);
  }
  return requestTool(TRANSFER_TEAM_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, '/transfer'),
    body: { uuid: args.newOwnerUuid },
  });
}

export async function handleUpdateTeam(args: z.infer<typeof UPDATE_TEAM_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(UPDATE_TEAM_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, '/update'),
    body: { nickname: args.nickname, avatar: args.avatar, introduction: args.introduction },
  });
}

export async function handleUpdateTeamMemberRole(args: z.infer<typeof UPDATE_TEAM_MEMBER_ROLE_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(UPDATE_TEAM_MEMBER_ROLE_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, `/members/${encodeURIComponent(args.memberUuid)}/update`),
    body: { role: args.role },
  });
}

export async function handleUpdateTeamMemberRemark(args: z.infer<typeof UPDATE_TEAM_MEMBER_REMARK_TOOL.inputSchema>): Promise<CallToolResult> {
  return requestTool(UPDATE_TEAM_MEMBER_REMARK_TOOL.name, {
    method: 'POST',
    path: teamPath(args.teamUuid, '/updateRemark'),
    body: { uuid: args.memberUuid, remark: args.remark },
  });
}
