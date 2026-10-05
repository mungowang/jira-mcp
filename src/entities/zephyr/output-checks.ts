import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { E, type EntityName } from '../../entity-types.ts';

/**
 * Observation mode for the Zephyr output contract - **zero behaviour change**.
 *
 * The vendored Zephyr tools answer `{ content: [{ type: 'text', text }] }` where `text` is
 * `JSON.stringify(data, null, 2)`: the payload *is* JSON, it is just not exposed a second time as
 * `structuredContent`. Declaring an `outputSchema` obliges a tool to supply `structuredContent`,
 * and the SDK throws when it is missing or does not match - so attaching one to a tool whose
 * payload turns out to be an array, or `null` where the entity declares a string, would turn a
 * working tool into a failing one.
 *
 * This wrapper answers the question first: it parses what the tool returned and validates it
 * against the entity the tool is believed to produce, reporting the result to stderr. It never
 * touches the result, so a run with `ZEPHYR_OUTPUT_CHECKS=1` behaves exactly like a run without it.
 * When the flag is unset the wrapper is not even installed.
 *
 * Turn it into a declared schema only for the tools that come back `ok`, and put that evidence in
 * the repo the way `ENTITY_FOR_STEP` records the core tools.
 */

/** Tools whose successful payload is a plain object: the entity it is expected to satisfy. */
export const CANDIDATE_ENTITY: Record<string, EntityName> = {
  get_test_case: 'testCase',
  get_test_run: 'testRun',
  get_test_run_results: 'zephyrPage',
  get_test_run_summary: 'testRunSummary',
  get_test_plan: 'testPlan',
  get_latest_result_for_test_case: 'testResult',
  search_test_cases: 'zephyrPage',
  search_test_runs: 'zephyrPage',
  search_test_plans: 'zephyrPage',
  get_folder_tree: 'folderTree',
  get_status_options: 'statusOptions',
};

/**
 * Tools that answer a bare array, and the entity each *item* should satisfy. These can never carry
 * an `outputSchema` - MCP requires an object at the root - so the item check is only there to keep
 * the claim in the README measured rather than assumed.
 */
export const CANDIDATE_ITEM: Record<string, EntityName> = {
  get_custom_field_definitions: 'customFieldDefinition',
  get_test_cases_linked_to_issue: 'testCase',
};

export type OutputCheck = {
  tool: string;
  entity: EntityName;
  root: 'object' | 'array' | 'scalar';
  /** For an array root: how many items were checked. */
  items?: number;
  ok: boolean;
  detail?: string;
};

const checks: OutputCheck[] = [];

/** Everything observed so far, in call order. Empty unless the flag was set at startup. */
export function outputChecks(): readonly OutputCheck[] {
  return checks;
}

const short = (v: unknown): string => {
  try { return JSON.stringify(v)?.slice(0, 80) ?? String(v); } catch { return String(v); }
};

function record(check: OutputCheck): void {
  checks.push(check);
  const where = `${check.tool} -> E.${check.entity}`;
  if (check.ok) {
    const what = check.root === 'array' ? `array(${check.items} items) all match` : check.root;
    process.stderr.write(`[zephyr-output] ok       ${where} (${what})\n`);
    return;
  }
  process.stderr.write(`[zephyr-output] MISMATCH ${where}: ${check.detail}\n`);
}

/** Validate one payload. Never throws: the point is to report, not to fail the call. */
function inspect(tool: string, entity: EntityName, data: unknown): void {
  const schema = E[entity];
  try {
    if (Array.isArray(data)) {
      const failed = data.map((item, i) => ({ i, r: schema.safeParse(item) })).filter((x) => !x.r.success);
      record({
        tool, entity, root: 'array', items: data.length, ok: failed.length === 0,
        ...(failed.length
          ? { detail: `${data.length - failed.length}/${data.length} items match; item[${failed[0].i}]: ${issueText(failed[0].r)}` }
          : {}),
      });
      return;
    }
    if (data === null || typeof data !== 'object') {
      record({ tool, entity, root: 'scalar', ok: false, detail: `root is ${data === null ? 'null' : typeof data}, not an object` });
      return;
    }
    const parsed = schema.safeParse(data);
    record({
      tool, entity, root: 'object', ok: parsed.success,
      ...(parsed.success ? {} : { detail: issueText(parsed) }),
    });
  } catch (err) {
    record({ tool, entity, root: 'object', ok: false, detail: `check itself failed: ${(err as Error).message}` });
  }
}

function issueText(result: { success: boolean; error?: unknown }): string {
  const issues = (result as { error?: { issues?: { path: (string | number)[]; message: string }[] } }).error?.issues;
  if (!issues?.length) return 'unknown validation error';
  return issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * Wrap a server so every Zephyr call whose tool is in one of the tables is checked after the fact.
 * Returns the server unchanged when `ZEPHYR_OUTPUT_CHECKS` is not `1`.
 */
export function observeOutputs(server: McpServer): McpServer {
  if (process.env.ZEPHYR_OUTPUT_CHECKS !== '1') return server;

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== 'registerTool') return Reflect.get(target, prop, receiver);
      return (name: string, config: unknown, handler: (...a: unknown[]) => Promise<unknown>) => {
        const entity = CANDIDATE_ENTITY[name] ?? CANDIDATE_ITEM[name];
        if (entity === undefined) return (target.registerTool as CallableFunction)(name, config, handler);
        return (target.registerTool as CallableFunction)(name, config, async (...args: unknown[]) => {
          const result = await handler(...args) as { isError?: boolean; content?: { type: string; text?: string }[] };
          try {
            // Error results are never validated by the SDK either, so they are not evidence.
            if (result?.isError) return result;
            const text = result?.content?.[0]?.text;
            if (typeof text !== 'string') {
              record({ tool: name, entity, root: 'scalar', ok: false, detail: 'no text content block to read' });
              return result;
            }
            inspect(name, entity, JSON.parse(text));
          } catch (err) {
            record({ tool: name, entity, root: 'object', ok: false, detail: `payload is not JSON (${(err as Error).message}): ${short(result?.content?.[0]?.text)}` });
          }
          return result;
        });
      };
    },
  });
}
