import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';
import type { EcadToolDefinition } from './types.js';

/** The subset of `McpServer.registerTool` config derived from the desktop catalog. */
export interface EcadToolRegistration {
  title: string;
  description: string;
  inputSchema: ZodType;
  annotations: ToolAnnotations;
}

/**
 * Convert one imported desktop-app tool into a Zod-backed MCP tool. The
 * generated catalog already defines `inputSchema` with Zod, so it is passed
 * through unchanged.
 */
export function toMcpTool(tool: EcadToolDefinition): EcadToolRegistration {
  return {
    title: toolTitle(tool),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: !tool.danger,
      destructiveHint: tool.danger,
      idempotentHint: !tool.danger,
      openWorldHint: true,
    },
  };
}

/** The desktop app uses the first description line as the tool title. */
function toolTitle(tool: EcadToolDefinition): string {
  const firstLine = tool.description.split('\n')[0]?.trim() ?? '';
  if (firstLine === '' || /^(GET|POST|PUT|DELETE|PATCH|HEAD)\s+\//i.test(firstLine)) {
    return tool.name;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
