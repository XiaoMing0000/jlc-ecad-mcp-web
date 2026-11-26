import type { ZodType } from 'zod';
import type { HttpMethod } from '../api/client.js';

/**
 * One tool imported from the JLC ECAD desktop app's MCP catalog.
 *
 * The desktop app exposes its catalog as JSON Schema and a local HTTP route.
 * `scripts/import-ecad-catalog.mjs` converts that schema into a Zod schema so
 * the same definition drives validation, `tools/list`, and the HTTP call.
 */
export interface EcadToolDefinition {
  name: string;
  description: string;
  /** Path relative to JLC_ECAD_BASE_URL, for example /api/editor/parts/:uuid. */
  path: string;
  method: HttpMethod;
  /** Destructive tools require __confirm: true. */
  danger: boolean;
  inputSchema: ZodType;
  /**
   * `ownerUuid`/`owner_uuid` arguments, split by whether the desktop schema
   * requires them. Only optional ones may be filled from the current user.
   */
  ownerParams?: {
    optional: string[];
    required: string[];
  };
}
