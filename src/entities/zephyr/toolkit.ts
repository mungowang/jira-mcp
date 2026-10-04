import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type { Config } from './config.ts';
import { NetworkError, ZephyrApiError } from './http.ts';
import { log } from './log.ts';

export interface ToolContext {
  cfg: Config;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface ToolSpec<S extends ZodRawShape> {
  name: string;
  /** English description targeted at LLM clients. */
  description: string;
  inputSchema: S;
  annotations?: ToolAnnotations;
  handler: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

/** Thrown by tools for invalid input detected before any HTTP call. */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

interface TextResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(text: string, isError = false): TextResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * Secrets shorter than this are left alone: redacting a tiny secret corrupts unrelated output (a
 * one-character secret rewrites every payload) and protects nothing — loadConfig prints a startup
 * warning when a configured secret falls below the floor.
 */
const MIN_SCRUB_LENGTH = 6;

/**
 * Every textual encoding a secret can wear by the time it reaches the client: raw (error texts and
 * the debug log), JSON-escaped (success payloads go through JSON.stringify, which escapes quotes,
 * backslashes and control characters — the raw form then never matches), and, for basic auth, the
 * base64 Authorization token in case a proxy echoes request headers into an error body. Secrets
 * never enter a URL, so there is no percent-encoded form to cover.
 */
function secretVariants(cfg: Config): string[] {
  const variants = new Set<string>();
  for (const secret of [cfg.pat, cfg.password]) {
    if (!secret || secret.length < MIN_SCRUB_LENGTH) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1));
  }
  if (cfg.username && cfg.password && cfg.password.length >= MIN_SCRUB_LENGTH) {
    variants.add(Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64'));
  }
  return [...variants];
}

/** Defensive scrubbing: secrets must never appear in tool output or error texts. */
function scrubSecrets(cfg: Config, text: string): string {
  let out = text;
  for (const variant of secretVariants(cfg)) {
    // includes() first so the common no-hit case on a large payload stays one scan with no
    // allocation; split/join rather than a regex, so metacharacters inside a secret stay inert.
    if (out.includes(variant)) out = out.split(variant).join('***');
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof ZephyrApiError || err instanceof NetworkError || err instanceof ToolInputError) {
    return err.message;
  }
  if (err instanceof z.ZodError) {
    return `Invalid arguments:\n${err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Register a tool on the MCP server: strict zod input schema, read-only mode guard,
 * pretty-printed JSON success payloads and normalized `isError` failures.
 */
export function defineTool<S extends ZodRawShape>(server: McpServer, cfg: Config, spec: ToolSpec<S>): void {
  const schema = z.object(spec.inputSchema).strict();
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: schema,
      annotations: { ...spec.annotations },
    },
    async (args: z.output<typeof schema>) => {
      if (cfg.readonly && !spec.annotations?.readOnlyHint) {
        return textResult(`Server is in read-only mode (ZEPHYR_READONLY=true) — '${spec.name}' performs writes and is disabled.`, true);
      }
      try {
        const data = await spec.handler(args, { cfg });
        return textResult(scrubSecrets(cfg, JSON.stringify(data ?? null, null, 2)));
      } catch (err) {
        // §5: secrets must never reach logs either — scrub before logging, same as for the client.
        log('debug', scrubSecrets(cfg, `tool ${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`));
        return textResult(scrubSecrets(cfg, errorText(err)), true);
      }
    },
  );
}

/** Resolve the effective project key: explicit argument or ZEPHYR_DEFAULT_PROJECT_KEY. */
export function resolveProjectKey(cfg: Config, projectKey: string | undefined): string {
  const key = projectKey ?? cfg.defaultProjectKey;
  if (!key) {
    throw new ToolInputError('projectKey is required (and no ZEPHYR_DEFAULT_PROJECT_KEY is configured).');
  }
  return key;
}

/** Drop undefined values so optional params never reach the request body (§6.7). */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** UI link for a test case, per spec §6.3. */
export function testCaseWebUrl(cfg: Config, key: string): string {
  return `${cfg.baseUrl}/secure/Tests.jspa#/testCase/${key}`;
}

/** Standard envelope for search tools (§6.5). */
export function pageEnvelope(startAt: number, maxResults: number, values: unknown[]): {
  startAt: number;
  maxResults: number;
  count: number;
  isLast: boolean;
  values: unknown[];
} {
  return { startAt, maxResults, count: values.length, isLast: values.length < maxResults, values };
}

/** Serialize a `fields` array to the comma-separated form the API expects. */
export function fieldsParam(fields: string[] | undefined): string | undefined {
  return fields && fields.length > 0 ? fields.join(',') : undefined;
}

/** Join path segments, URL-encoding each: encodePath('/testcase', key) -> '/testcase/PROJ-T1'. */
export function encodePath(prefix: string, ...segments: Array<string | number>): string {
  return [prefix.replace(/\/$/, ''), ...segments.map((segment) => encodeURIComponent(String(segment)))].join('/');
}

/** Default page size shared by every search tool (the API server-side default of 200 is too coarse for LLM clients). */
export const DEFAULT_PAGE_SIZE = 50;

/** Normalize the pagination arguments of a search tool. */
export function pageArgs(args: { startAt?: number | undefined; maxResults?: number | undefined }): {
  startAt: number;
  maxResults: number;
} {
  return { startAt: args.startAt ?? 0, maxResults: args.maxResults ?? DEFAULT_PAGE_SIZE };
}

/**
 * True when an API response carries no meaningful payload: `null`, no body at all, `{}` or `[]`.
 *
 * Write endpoints on Server/DC answer inconsistently — some echo the created entity, some answer 204,
 * some send an empty object and some an empty array — so every write tool that has something useful
 * to confirm uses this one rule: no payload means "synthesize the confirmation envelope", anything
 * else is passed through verbatim.
 */
export function isEmptyResponse(res: unknown): boolean {
  if (res === null || res === undefined) return true;
  if (Array.isArray(res)) return res.length === 0;
  return typeof res === 'object' && Object.keys(res).length === 0;
}

/**
 * Truncate a nested error message for embedding into a composite tool's per-item report.
 *
 * The cut is always announced: found live, a per-item 404 ended at exactly 500 characters mid-word
 * ("… which health_check can tell"), which reads like the server's own wording rather than like a
 * truncated one. The marker names the limit and the real length so the reader can tell how much is
 * missing, and the cut is pulled back to the last word boundary when one is close enough to matter.
 */
export function errorSummary(err: unknown, max = 500): string {
  const text = err instanceof Error ? err.message : String(err);
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastBreak = head.search(/\s\S*$/); // -1 when the head holds no whitespace at all
  const kept = lastBreak > 0 && lastBreak > max - 40 ? head.slice(0, lastBreak) : head;
  return `${kept}… [truncated to ${max} characters of ${text.length}; re-run this item on its own for the full message]`;
}
