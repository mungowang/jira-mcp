// Self-hosted instances often use self-signed certificates. The flag name mirrors the
// Zephyr side (JIRA_TLS_REJECT_UNAUTHORIZED); JIRA_SSL_VERIFY is accepted as an alias.
if (process.env.JIRA_TLS_REJECT_UNAUTHORIZED === 'false' || process.env.JIRA_SSL_VERIFY === 'false') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.JIRA_TLS_REJECT_UNAUTHORIZED = 'false';
  process.stderr.write('[jira-server] WARN TLS verification disabled (JIRA_TLS_REJECT_UNAUTHORIZED/JIRA_SSL_VERIFY=false)\n');
}

/**
 * Transport: one function for any path. Auth, timeout, retry and error translation
 * all live here so tool implementations stay one-liners.
 */

const BASE = (process.env.JIRA_BASE_URL ?? '').replace(/\/+$/, '');

/**
 * Why JIRA_BASE_URL cannot be used, or null when it looks usable.
 *
 * Exists because a bad base used to surface as `fetch failed` or `Failed to parse URL from ...`,
 * which says nothing about the cause. A host that injects the base from a secret store can pass
 * the reference through unresolved, and that looks exactly like a typo.
 *
 * The value itself is never echoed: such a host treats the base URL as a credential and masks it
 * in logs, so quoting it would only produce `[redacted]`-style noise.
 */
export function baseUrlProblem(raw: string | undefined = process.env.JIRA_BASE_URL): string | null {
  const value = (raw ?? '').trim();
  if (value === '') {
    return 'JIRA_BASE_URL is empty. Set it to the instance root, e.g. http://jira.example.com:8080';
  }
  if (value.includes('${')) {
    return 'JIRA_BASE_URL still contains an unresolved ${...} placeholder. The client passed the '
      + 'reference through instead of resolving it to a value - check how the server is launched '
      + '(a `${env:NAME}` / `${credential:NAME}` reference must be resolved before spawn)';
  }
  if (!/^https?:\/\//i.test(value)) {
    return 'JIRA_BASE_URL must be an absolute URL starting with http:// or https:// '
      + '(a bare host:port is not enough, and it is not a /rest/... path)';
  }
  try {
    new URL(value);
  } catch {
    return 'JIRA_BASE_URL is not a parseable URL (check for stray spaces or quotes)';
  }
  return null;
}

const AUTH = process.env.JIRA_PAT
  ? `Bearer ${process.env.JIRA_PAT}`
  : 'Basic ' + Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_PASSWORD}`).toString('base64');

const TIMEOUT_MS = Number(process.env.JIRA_TIMEOUT_MS ?? 30_000);
const MAX_RETRIES = Number(process.env.JIRA_MAX_RETRIES ?? 2);
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Translate a Jira response into an actionable message. A bare status code tells the
 * model nothing; these hints tell it what to do next.
 */
export function explain(status: number, body: string, method: string, path: string): string {
  const head = `Jira ${method} ${path} -> ${status}`;
  const b = body.slice(0, 400);
  if (status === 401) {
    return `${head}: authentication failed. Check JIRA_USERNAME / JIRA_PASSWORD. ` +
      `If the account authenticates through SSO/Crowd without a local password, or the instance ` +
      `enables CAPTCHA, Basic Auth is not usable here - use a local account instead. Raw response: ${b}`;
  }
  if (status === 403) {
    return `${head}: permission denied. This account cannot access that project/board/object, ` +
      `or the operation requires administrator rights. Raw response: ${b}`;
  }
  if (status === 404) {
    const isPluginPath = path.startsWith('/rest/') && !path.startsWith('/rest/api/') && !path.startsWith('/rest/agile/');
    return `${head}: ${isPluginPath
      ? 'path not found. If this is a plugin endpoint, confirm the plugin is installed (jira_list_plugins)'
      : 'object or path not found'}. Raw response: ${b}`;
  }
  if (status === 406) {
    return `${head}: the instance refused the requested content type. On Jira Server this usually means ` +
      `the endpoint needs Jira administrator rights (it answers with an HTML error page instead of JSON), ` +
      `or the resource does not exist for this account/version. Raw response: ${b}`;
  }
  if (status === 429) return `${head}: rate limited, still failing after retries. Raw response: ${b}`;
  if (status === 400 || status === 422) {
    if (/is not on the appropriate screen/i.test(body)) {
      const field = /Field '([^']+)'/.exec(body)?.[1];
      return `${head}: field${field ? ` '${field}'` : ''} is not on the screen for this project/issue type, ` +
        `or the field name does not exist. Call jira_describe_create / jira_describe_edit first to see ` +
        `which fields are actually writable. Raw response: ${b}`;
    }
    if (/cannot be set|not editable|read-only/i.test(body)) {
      return `${head}: this field is not writable in the current state/screen ` +
        `(it may be a calculated field or restricted by the workflow). ` +
        `Call jira_describe_edit to confirm the writable fields. Raw response: ${b}`;
    }
    return `${head}: request rejected (field format or value not accepted). ` +
      `Call jira_describe_* to get the expected value shape. Raw response: ${b}`;
  }
  if (status >= 500) return `${head}: Jira server error. Raw response: ${b}`;
  return `${head}: ${b}`;
}

export function resolveUrl(path: string, query?: Record<string, unknown>): string {
  // '/rest/...' passes through untouched (plugin modules); anything else is a short
  // path under /rest/api/2.
  const full = path.startsWith('http') ? path
    : path.startsWith('/rest/') ? BASE + path
    : `${BASE}/rest/api/2${path.startsWith('/') ? path : '/' + path}`;
  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])) : '';
  return full + qs;
}

function retryDelayMs(res: Response | undefined, attempt: number): number {
  const ra = res?.headers.get('retry-after');
  const secs = ra ? Number(ra) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 4_000);
}

export async function jira<T = unknown>(
  method: string, path: string,
  opts: { query?: Record<string, unknown>; body?: unknown } = {},
): Promise<T> {
  // Classify a bad base before spending a request: fetch's own message for this is useless.
  const problem = baseUrlProblem();
  if (problem !== null) throw new Error(`Jira ${method} ${path}: ${problem}`);

  const url = resolveUrl(path, opts.query);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: AUTH,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout: retryable.
      lastErr = err;
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(undefined, attempt)); continue; }
      const why = (err as Error)?.name === 'TimeoutError'
        ? `request did not return within ${TIMEOUT_MS}ms (tune JIRA_TIMEOUT_MS)`
        : `network error: ${(err as Error)?.message ?? String(err)}`;
      throw new Error(`Jira ${method} ${path}: ${why}`);
    }

    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

    if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    throw new Error(explain(res.status, text, method, path));
  }
  throw new Error(`Jira ${method} ${path}: retries exhausted (${String(lastErr)})`);
}

/** Multipart upload (Jira attachments require X-Atlassian-Token: no-check). */
export async function jiraUpload(path: string, data: Uint8Array, filename: string): Promise<unknown> {
  const problem = baseUrlProblem();
  if (problem !== null) throw new Error(`Jira upload ${path}: ${problem}`);

  const fd = new FormData();
  fd.append('file', new Blob([data as never]), filename);
  let res: Response;
  try {
    // Must go through resolveUrl: callers pass short paths like `/issue/PROJ-1/attachments`,
    // which still need the /rest/api/2 prefix.
    res = await fetch(resolveUrl(path), {
      method: 'POST',
      headers: { Authorization: AUTH, 'X-Atlassian-Token': 'no-check' },
      body: fd,
      signal: AbortSignal.timeout(Math.max(TIMEOUT_MS, 120_000)),
    });
  } catch (err) {
    throw new Error(`Jira upload ${path}: ${(err as Error)?.message ?? String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(explain(res.status, text, 'POST', path));
  return text ? JSON.parse(text) : undefined;
}
