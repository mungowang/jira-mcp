import type { Config } from './config.ts';
import { atm, zephyrFetch, ZephyrApiError } from './http.ts';

export interface RunResultsPage {
  total: number;
  values: unknown[];
  /** Present when the paginated endpoint is missing and the flat fallback was used. */
  note?: string;
}

export interface RunResultsQuery {
  startAt: number;
  maxResults: number;
  onlyLastExecutions?: boolean | undefined;
  /**
   * An already-read GET /testrun/{key} payload. The flat fallback resolves onlyLastExecutions from the
   * run's items[], so a caller that holds the run (get_test_run_summary) passes it instead of a re-read.
   */
  run?: Record<string, unknown> | undefined;
}

/**
 * Read one page of a test run's execution results via GET /testrun/{key}/testresults/page.
 * Older Zephyr Scale Server versions have no /page endpoint (404 for ANY run key) — in that
 * case the deprecated flat endpoint is read and paginated client-side. A run that genuinely
 * does not exist makes the flat call 404 too, so real errors still surface.
 */
/** Page size used when collecting all results of a run. */
export const COLLECT_PAGE_SIZE = 200;
/** Safety cap so an inconsistent `total` can never loop forever (200 * 50 = 10 000 results). */
export const COLLECT_MAX_PAGES = 50;

export interface CollectedRunResults {
  results: Array<Record<string, unknown>>;
  /** True when COLLECT_MAX_PAGES was hit before `total` was reached. */
  truncated: boolean;
  /** Present when the flat-endpoint fallback was used. */
  note?: string | undefined;
}

/** Collect ALL execution results of a run (paginating through fetchRunResultsPage). */
export async function collectRunResults(
  cfg: Config,
  testRunKey: string,
  onlyLastExecutions: boolean,
  run?: Record<string, unknown> | undefined,
): Promise<CollectedRunResults> {
  const results: Array<Record<string, unknown>> = [];
  let startAt = 0;
  let truncated = false;
  let note: string | undefined;
  for (let page = 0; ; page++) {
    const res = await fetchRunResultsPage(cfg, testRunKey, { startAt, maxResults: COLLECT_PAGE_SIZE, onlyLastExecutions, run });
    results.push(...(res.values as Array<Record<string, unknown>>));
    note ??= res.note;
    startAt += res.values.length;
    if (res.values.length === 0 || startAt >= res.total) break;
    if (page + 1 >= COLLECT_MAX_PAGES) {
      truncated = true;
      break;
    }
  }
  return { results, truncated, note };
}

const FLAT_FALLBACK_NOTE =
  'The paginated /testresults/page endpoint is unavailable on this Zephyr Scale version; results were read from the deprecated flat ' +
  'endpoint and paginated client-side.';

/** Appended when the run object supplied the id of every item's last execution — the exact answer. */
const PER_ITEM_NOTE =
  " Only the last execution of each run item is kept, taken from the run object itself: GET /testrun items[] names the id of every item's " +
  'last execution, so the kept set is exactly one execution per item and can never be larger than the number of items.';

/** Appended when the run payload carries no per-item ids and the newest-per-test-case guess was used. */
const PER_CASE_NOTE =
  ' Only the last execution of each run item is kept. This run payload names no per-item last-execution ids, so the newest execution ' +
  '(highest id) per TEST CASE was kept instead: a test case that is an item of the run more than once collapses into ONE value, and the ' +
  'number of values can therefore be smaller than the number of items.';

/** Numeric id of an execution or item, tolerating the string form some builds return. */
function numericId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Id of the execution the run object names as an item's LAST one. On this build the item's own `id` IS
 * that execution id (verified live: it changes with every new execution of the item); builds that expose
 * the execution as a nested object are read from there first.
 */
function itemLastExecutionId(item: unknown): number | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const rec = item as Record<string, unknown>;
  const nested = rec.lastTestResult ?? rec.$lastTestResult;
  const nestedId = typeof nested === 'object' && nested !== null ? numericId((nested as Record<string, unknown>).id) : undefined;
  return nestedId ?? numericId(rec.lastTestResultId) ?? numericId(rec.id);
}

/** The items[] of a run payload, when it has one. */
function runItems(run: unknown): unknown[] | undefined {
  const items = typeof run === 'object' && run !== null ? (run as Record<string, unknown>).items : undefined;
  return Array.isArray(items) ? items : undefined;
}

/**
 * Ids of the last execution of every item of a run, or undefined when the payload names none. This is the
 * authoritative per-ITEM answer: it needs no guessing from execution fields, which are heterogeneous over
 * an item's own history (the placeholder execution created with the run carries no environment, later ones do).
 */
export function lastExecutionIds(run: unknown): Set<number> | undefined {
  const items = runItems(run);
  if (items === undefined) return undefined;
  const ids = new Set<number>();
  for (const item of items) {
    const id = itemLastExecutionId(item);
    if (id !== undefined) ids.add(id);
  }
  return ids.size > 0 ? ids : undefined;
}

/** Documented fallback for builds whose run payload has no last-execution ids: newest execution per test case. */
function newestPerTestCase(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const newest = new Map<string, Record<string, unknown>>();
  for (const r of results) {
    const key = typeof r.testCaseKey === 'string' ? r.testCaseKey : JSON.stringify(r.testCaseKey ?? null);
    const prev = newest.get(key);
    if (!prev || (numericId(r.id) ?? 0) >= (numericId(prev.id) ?? 0)) newest.set(key, r);
  }
  return [...newest.values()];
}

/** Read the run for its items[]; any failure only means the per-item ids are unavailable here. */
async function readRun(cfg: Config, testRunKey: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await zephyrFetch(cfg, {
      method: 'GET',
      path: atm(`/testrun/${encodeURIComponent(testRunKey)}`),
      query: { fields: 'items' },
    })) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function fetchRunResultsPage(cfg: Config, testRunKey: string, query: RunResultsQuery): Promise<RunResultsPage> {
  const runPath = `/testrun/${encodeURIComponent(testRunKey)}`;
  try {
    const res = (await zephyrFetch(cfg, {
      method: 'GET',
      path: atm(`${runPath}/testresults/page`),
      query: { startAt: query.startAt, maxResults: query.maxResults, onlyLastExecutions: query.onlyLastExecutions },
    })) as { total: number; values?: unknown[] };
    return { total: res.total, values: res.values ?? [] };
  } catch (err) {
    if (!(err instanceof ZephyrApiError) || err.status !== 404) throw err;
    const flat = await zephyrFetch(cfg, { method: 'GET', path: atm(`${runPath}/testresults`) });
    if (!Array.isArray(flat)) throw err;
    let all = flat as Array<Record<string, unknown>>;
    let note = FLAT_FALLBACK_NOTE;
    if (query.onlyLastExecutions && all.length > 0) {
      const run = query.run ?? (await readRun(cfg, testRunKey));
      const ids = lastExecutionIds(run);
      const perItem = ids ? all.filter((r) => ids.has(numericId(r.id) ?? -1)) : [];
      if (perItem.length > 0) {
        all = perItem;
        note += PER_ITEM_NOTE;
      } else {
        all = newestPerTestCase(all);
        note += PER_CASE_NOTE;
        const itemCount = runItems(run)?.length;
        if (itemCount !== undefined && itemCount > all.length) {
          note += ` Here that lost ${itemCount - all.length}: the run has ${itemCount} items and ${all.length} values remain.`;
        }
      }
    }
    return {
      total: all.length,
      values: all.slice(query.startAt, query.startAt + query.maxResults),
      note,
    };
  }
}
