/**
 * Parse a `fetch` Response body as JSON, turning the cryptic
 * `SyntaxError: Unexpected token '<', "<html> ..."` you get when an `/api/...` request fell
 * through to the single-page app's `index.html` (or the API is down / behind a proxy that
 * doesn't route it) into a message that says what's actually wrong.
 *
 * Use it wherever an editor API response is parsed *before* its status is branched on, or on a
 * response that is expected to be OK — a plain `response.json()` there hides the real failure.
 */
export async function readApiJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new Error(
      `The editor API returned a non-JSON response (HTTP ${response.status}). The request isn't ` +
        `reaching the API — check the API service is running with EDITOR_ENABLED=true and that ` +
        `/api is routed to it rather than falling through to the app's index.html.`,
    );
  }
}
