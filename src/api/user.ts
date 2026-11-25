import { getBaseUrl } from '../config.js';
import { apiGet } from './client.js';

export interface EditorUserResult {
  ok: true;
  endpoint: string;
  httpStatus: number;
  /** Raw JSON body returned by the editor backend. */
  data: unknown;
}

/**
 * GET /api/editor/user
 *
 * Returns the profile of the user owning the configured session cookie.
 * The backend wraps the profile in { success, code, result }.
 */
export async function getEditorUser(): Promise<EditorUserResult> {
  const { httpStatus, data } = await apiGet('/api/editor/user');

  return {
    ok: true,
    endpoint: `${getBaseUrl()}/api/editor/user`,
    httpStatus,
    data,
  };
}
