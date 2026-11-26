import { apiRequest } from '../api/client.js';
import { loadSession } from '../session.js';
import { isRecord } from '../utils.js';

let cached: { cookie: string; uuid: string } | undefined;

/**
 * Resolve the signed-in user's UUID for tools whose owner parameter defaults to
 * the current user. The result is cached per session cookie for the lifetime of
 * the process; a different cookie (for example after login) triggers a refresh.
 */
export async function getCurrentUserUuid(retryTool?: string): Promise<string | undefined> {
  const cookie = loadSession()?.cookie ?? '';
  if (cached?.cookie === cookie) {
    return cached.uuid;
  }

  const response = await apiRequest({ method: 'GET', path: '/api/editor/user', requireJson: true, retryTool });
  const body = isRecord(response.data) ? response.data : {};
  const user = isRecord(body.result) ? body.result : {};
  const uuid = typeof user.uuid === 'string' ? user.uuid : undefined;
  if (uuid) {
    cached = { cookie, uuid };
  }
  return uuid;
}
