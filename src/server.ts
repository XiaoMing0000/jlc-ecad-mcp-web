import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';
import { SERVER_NAME, SERVER_TITLE } from './config.js';
import { executeEcadTool } from './ecad/executor.js';
import { toMcpTool } from './ecad/metadata.js';
import { LOGIN_TOOL, LOGOUT_TOOL, handleLogin, handleLogout } from './tools/auth.js';
import { GET_BETA_STATUS_TOOL, JOIN_BETA_WHITELIST_TOOL, handleGetBetaStatus, handleJoinBetaWhitelist } from './tools/beta.js';
import {
  CREATE_CATEGORY_TOOL,
  DELETE_CATEGORY_TOOL,
  LIST_CATEGORIES_TOOL,
  UPDATE_CATEGORY_TOOL,
  handleCreateCategory,
  handleDeleteCategory,
  handleListCategories,
  handleUpdateCategory,
} from './tools/category.js';
import { SEARCH_COMPONENTS_TOOL, SEARCH_DEVICES_TOOL, handleSearchComponents, handleSearchDevices } from './tools/eda.js';
import { ECAD_TOOLS } from './tools/index.js';
import { UPLOAD_MACRO_DATA_TOOL, handleUploadMacroData } from './tools/macro-upload.js';
import {
  ADD_TEAM_MEMBER_TOOL,
  CREATE_TEAM_TOOL,
  DELETE_TEAM_TOOL,
  GET_OTHER_TEAMS_TOOL,
  GET_TEAM_INFO_TOOL,
  GET_TEAM_LOGS_TOOL,
  LIST_TEAMS_TOOL,
  REMOVE_TEAM_MEMBER_TOOL,
  TRANSFER_TEAM_TOOL,
  UPDATE_TEAM_MEMBER_REMARK_TOOL,
  UPDATE_TEAM_MEMBER_ROLE_TOOL,
  UPDATE_TEAM_TOOL,
  handleAddTeamMember,
  handleCreateTeam,
  handleDeleteTeam,
  handleGetOtherTeams,
  handleGetTeamInfo,
  handleGetTeamLogs,
  handleListTeams,
  handleRemoveTeamMember,
  handleTransferTeam,
  handleUpdateTeam,
  handleUpdateTeamMemberRemark,
  handleUpdateTeamMemberRole,
} from './tools/team.js';
import {
  ADD_PART_PRODUCTION_TOOL,
  DELETE_PART_PRODUCTION_TOOL,
  GET_PART_PRODUCTION_TOOL,
  ORDER_PART_BOM_TOOL,
  SEARCH_PUBLIC_PARTS_TOOL,
  UPDATE_PART_PRODUCTION_TOOL,
  handleAddPartProduction,
  handleDeletePartProduction,
  handleGetPartProduction,
  handleOrderPartBom,
  handleSearchPublicParts,
  handleUpdatePartProduction,
} from './tools/parts-web.js';
import {
  GET_PRODUCT_FILTERS_TOOL,
  GET_PRODUCT_TREE_TOOL,
  LIST_PRODUCTS_POST_TOOL,
  LIST_PRODUCTS_TOOL,
  handleGetProductFilters,
  handleGetProductTree,
  handleListProducts,
  handleListProductsPost,
} from './tools/product.js';
import {
  GET_DESIGNER_RIGHTS_TOOL,
  GET_MEMBER_RIGHTS_TOOL,
  GET_OFFICIAL_ACCOUNT_QRCODE_TOOL,
  handleGetDesignerRights,
  handleGetMemberRights,
  handleGetOfficialAccountQrcode,
} from './tools/rights.js';
import {
  ACCEPT_AGREEMENT_TOOL,
  GET_USER_BY_UUID_TOOL,
  GET_USER_LOGS_TOOL,
  GET_USER_TOOL,
  SEARCH_USERS_TOOL,
  UPDATE_USER_TOOL,
  handleAcceptAgreement,
  handleGetUser,
  handleGetUserByUuid,
  handleGetUserLogs,
  handleSearchUsers,
  handleUpdateUser,
} from './tools/user.js';

interface LocalTool<Schema extends ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: ToolAnnotations;
}

/** Register a hand-written tool; McpServer renders its JSON Schema from Zod. */
function registerLocalTool<Schema extends ZodType>(server: McpServer, tool: LocalTool<Schema>, handler: ToolCallback<Schema>): void {
  server.registerTool<Schema, Schema>(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    handler,
  );
}

/**
 * Every tool's inputSchema is a Zod schema: the hand-written tools declare it
 * directly, and the generated catalog defines it with Zod. McpServer validates
 * `tools/call` arguments and renders `tools/list` inputSchema from it.
 */
export function createServer(version: string): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version,
    },
    {
      instructions:
        'JLC EDA editor API tools. Authentication uses the locally saved JLC EDA session. ' +
        'If a tool reports a 401, ask the user whether they want to sign in and prefer `npx -y jlc-ecad-mcp login`. ' +
        'Destructive tools require {"__confirm": true} after the user confirms. ' +
        'Catalog tools were imported from the JLC ECAD desktop app; tools that only work against its local server are not registered.',
    },
  );

  registerLocalTool(server, GET_USER_TOOL, async () => handleGetUser());
  registerLocalTool(server, ACCEPT_AGREEMENT_TOOL, async (args) => handleAcceptAgreement(args));
  registerLocalTool(server, GET_USER_LOGS_TOOL, async (args) => handleGetUserLogs(args));
  registerLocalTool(server, SEARCH_USERS_TOOL, async (args) => handleSearchUsers(args));
  registerLocalTool(server, UPDATE_USER_TOOL, async (args) => handleUpdateUser(args));
  registerLocalTool(server, GET_USER_BY_UUID_TOOL, async (args) => handleGetUserByUuid(args));
  registerLocalTool(server, LOGIN_TOOL, async (args) => handleLogin(args));
  registerLocalTool(server, LOGOUT_TOOL, async () => handleLogout());
  registerLocalTool(server, SEARCH_COMPONENTS_TOOL, async (args) => handleSearchComponents(args));
  registerLocalTool(server, SEARCH_DEVICES_TOOL, async (args) => handleSearchDevices(args));
  registerLocalTool(server, ORDER_PART_BOM_TOOL, async (args) => handleOrderPartBom(args));
  registerLocalTool(server, ADD_PART_PRODUCTION_TOOL, async (args) => handleAddPartProduction(args));
  registerLocalTool(server, UPDATE_PART_PRODUCTION_TOOL, async (args) => handleUpdatePartProduction(args));
  registerLocalTool(server, DELETE_PART_PRODUCTION_TOOL, async (args) => handleDeletePartProduction(args));
  registerLocalTool(server, GET_PART_PRODUCTION_TOOL, async (args) => handleGetPartProduction(args));
  registerLocalTool(server, SEARCH_PUBLIC_PARTS_TOOL, async (args) => handleSearchPublicParts(args));
  registerLocalTool(server, GET_PRODUCT_FILTERS_TOOL, async (args) => handleGetProductFilters(args));
  registerLocalTool(server, LIST_PRODUCTS_TOOL, async (args) => handleListProducts(args));
  registerLocalTool(server, LIST_PRODUCTS_POST_TOOL, async (args) => handleListProductsPost(args));
  registerLocalTool(server, GET_PRODUCT_TREE_TOOL, async () => handleGetProductTree());
  registerLocalTool(server, GET_OFFICIAL_ACCOUNT_QRCODE_TOOL, async () => handleGetOfficialAccountQrcode());
  registerLocalTool(server, GET_DESIGNER_RIGHTS_TOOL, async () => handleGetDesignerRights());
  registerLocalTool(server, GET_MEMBER_RIGHTS_TOOL, async () => handleGetMemberRights());
  registerLocalTool(server, GET_BETA_STATUS_TOOL, async () => handleGetBetaStatus());
  registerLocalTool(server, JOIN_BETA_WHITELIST_TOOL, async (args) => handleJoinBetaWhitelist(args));
  registerLocalTool(server, CREATE_CATEGORY_TOOL, async (args) => handleCreateCategory(args));
  registerLocalTool(server, LIST_CATEGORIES_TOOL, async (args) => handleListCategories(args));
  registerLocalTool(server, UPDATE_CATEGORY_TOOL, async (args) => handleUpdateCategory(args));
  registerLocalTool(server, DELETE_CATEGORY_TOOL, async (args) => handleDeleteCategory(args));
  registerLocalTool(server, UPLOAD_MACRO_DATA_TOOL, async (args) => handleUploadMacroData(args));
  registerLocalTool(server, ADD_TEAM_MEMBER_TOOL, async (args) => handleAddTeamMember(args));
  registerLocalTool(server, CREATE_TEAM_TOOL, async (args) => handleCreateTeam(args));
  registerLocalTool(server, DELETE_TEAM_TOOL, async (args) => handleDeleteTeam(args));
  registerLocalTool(server, LIST_TEAMS_TOOL, async (args) => handleListTeams(args));
  registerLocalTool(server, GET_TEAM_LOGS_TOOL, async (args) => handleGetTeamLogs(args));
  registerLocalTool(server, GET_OTHER_TEAMS_TOOL, async () => handleGetOtherTeams());
  registerLocalTool(server, REMOVE_TEAM_MEMBER_TOOL, async (args) => handleRemoveTeamMember(args));
  registerLocalTool(server, GET_TEAM_INFO_TOOL, async (args) => handleGetTeamInfo(args));
  registerLocalTool(server, TRANSFER_TEAM_TOOL, async (args) => handleTransferTeam(args));
  registerLocalTool(server, UPDATE_TEAM_TOOL, async (args) => handleUpdateTeam(args));
  registerLocalTool(server, UPDATE_TEAM_MEMBER_ROLE_TOOL, async (args) => handleUpdateTeamMemberRole(args));
  registerLocalTool(server, UPDATE_TEAM_MEMBER_REMARK_TOOL, async (args) => handleUpdateTeamMemberRemark(args));

  for (const tool of ECAD_TOOLS) {
    server.registerTool(tool.name, toMcpTool(tool), async (args) => executeEcadTool(tool, args));
  }

  return server;
}
