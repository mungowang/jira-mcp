import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { addHint, atm, zephyrFetch, ZephyrApiError } from '../http.ts';
import { collectRunResults } from '../runResults.ts';
import {
  itemSelectorsShape,
  RESULT_STATUS_NOTE,
  runItemSchema,
  selectorQuery,
  testCaseKeySchema,
  testResultFieldsShape,
  testRunKeySchema,
} from '../schemas.ts';
import { compact, defineTool, encodePath, isEmptyResponse } from '../toolkit.ts';

const RUN_COMPOSITION_HINT =
  "The run item could not be resolved. If the test case is not an item of the run, the behavior is version-specific: some Server builds " +
  'reject the call like this, others silently ADD the case as a new item (the build audited live on 2026-07-27 adds it). List the current ' +
  'items with get_test_run; add items with add_test_cases_to_run (internal API, when enabled) or recreate_test_run_with_items.';

const SELECTOR_MISMATCH_HINT =
  'No run item matched the selector. matchEnvironment must equal an item\'s environment and matchUserKey its executedBy/userKey — NOT ' +
  'assignedTo, and an earlier update may have cleared executedBy. Inspect the items with get_test_run / get_test_run_results, or drop the ' +
  'selector to target the newest item of that test case.';

/**
 * Found live, and ONLY for the empty-bodied case: a 5xx that carries no message at all says nothing
 * about the write. A 5xx that does carry an error message reports its own outcome and must not be
 * dressed up as a possible silent write — that sent operators re-reading a run for an execution the
 * server had just refused to create.
 */
const RESULT_500_HINT =
  'This 5xx carried NO body, and an empty-bodied 500 from the result endpoints does not report the outcome of the write: live it has ' +
  'been observed to STORE the execution anyway (and to add a duplicate run item), while this response carries nothing that tells a ' +
  'stored execution apart from one that was never recorded. So the write may or may not have happened — neither may be assumed from ' +
  'this response. It was first hit with matchEnvironment naming an environment no item of the test case carries, but the same ' +
  'empty-bodied 500 comes back from other inputs too, so its cause is undetermined as well. Do not retry blindly: re-read the run with ' +
  'get_test_run_results and send only what is genuinely missing, or you create a DUPLICATE execution.';

/**
 * The measured failure mode of the bulk endpoint (NBUL-C248 and NBUL-C249, with ids): it does NOT abort
 * at the failing entry, it skips it and commits everything else. Only attached when the body identifies
 * that entry — see blamesOneEntry.
 */
const PARTIAL_BATCH_HINT =
  'This error blames ONE entry of the batch, and this endpoint is NOT ATOMIC: it does NOT abort at the failing entry — verified live ' +
  'twice with ids, the rejected entry alone is SKIPPED and EVERY other valid entry is COMMITTED, the ones AFTER the failure as well as ' +
  'the ones before it, while the call still answers this error and returns no ids. Do NOT resend the batch or its tail from this error: ' +
  're-read the run with get_test_run_results first and resend only the entries that are genuinely missing, otherwise you create ' +
  'DUPLICATE executions.';

/**
 * Bodies that blame ONE entry — an unknown case key, a rejected value of a field that lives inside an
 * entry, an unknown custom field, a case that is not an item of the run. Only those are the per-entry
 * failures that leave the other entries committed.
 *
 * The field names are an ALLOWLIST of per-entry fields, because a bare `for field` also matches
 * rejections of the payload as a whole: live, a batch-wide 400 ("… cannot be found for field
 * testRunKey.", a batch-wide selector value the API cannot resolve) still carried the partial-commit
 * warning and sent operators hunting for executions that were never created. `environment` is
 * deliberately absent — it is both an entry field and the batch-wide matchEnvironment selector, so a
 * rejection naming it does not identify an entry. So is "no test execution found …", which on this
 * endpoint is the batch-wide selector matching nothing.
 */
const PER_ENTRY_FAILURE_RE =
  /\bfor field\s+"?(?:testCaseKey|status|iteration|version)\b|\bcustom field\b|not (?:part of|found in) (?:the )?(?:test ?)?run/i;

/**
 * Rejections of the payload AS A WHOLE: the request is refused before any entry is processed, so nothing
 * is committed and there is nothing to re-read. Checked before the per-entry allowlist, in case such a
 * body also happens to name a per-entry field.
 */
const WHOLE_PAYLOAD_REJECTION_RE =
  /cannot deserialize|unrecognized field|json parse error|not readable|\bfor field\s+"?(?:testRunKey|projectKey|results)\b/i;

/** True only for a body that identifies a FAILING ENTRY of the batch — the measured partial-commit case. */
function blamesOneEntry(err: ZephyrApiError): boolean {
  // The skipped-entry behavior was measured on 400s; a 5xx names no entry and proves nothing about the rest.
  if (err.status >= 500) return false;
  if (WHOLE_PAYLOAD_REJECTION_RE.test(err.responseBody)) return false;
  return PER_ENTRY_FAILURE_RE.test(err.responseBody);
}

/**
 * Bodies that carry no error detail at all: `responseBody` is the trimmed body or — when there was none —
 * the HTTP reason phrase, or the empty-body marker (src/http.ts).
 */
const NO_DETAIL_BODIES = new Set(['', '(empty response body)', 'internal server error']);

/** True when the response said nothing beyond its status line — the only 5xx shape the write warning was measured on. */
const carriesNoDetail = (err: ZephyrApiError): boolean => NO_DETAIL_BODIES.has(err.responseBody.trim().toLowerCase());

/** The API really cannot resolve the run item (the case is not an item, or the selector matched nothing). */
const UNRESOLVED_ITEM_RE = /no test (execution|result) found/i;
/** The API names run membership explicitly. */
const NOT_AN_ITEM_RE = /not part of (the )?(test ?)?run|not found in (the )?test ?run/i;

interface ResultErrorContext {
  hasSelector: boolean;
  /** The bulk endpoint, which commits every entry it can and only skips the rejected one. */
  batch?: boolean;
}

/**
 * Annotate an error from a result endpoint. The hints are gated on the response body: on the audited
 * build only 1 of 7 observed 400s was about run composition (bad status/iteration/version values,
 * unknown custom fields and unknown case keys all name their own field), so attaching the composition
 * hint to every failure misdiagnosed them.
 */
function withResultHints(err: unknown, ctx: ResultErrorContext): unknown {
  if (!(err instanceof ZephyrApiError)) return err;
  let out: unknown = err;
  if (ctx.batch && blamesOneEntry(err)) out = addHint(out, PARTIAL_BATCH_HINT);
  if (err.status >= 500 && carriesNoDetail(err)) out = addHint(out, RESULT_500_HINT);
  if (err.status !== 400 && err.status !== 404) return out;
  const body = err.responseBody;
  if (UNRESOLVED_ITEM_RE.test(body)) return addHint(out, ctx.hasSelector ? SELECTOR_MISMATCH_HINT : RUN_COMPOSITION_HINT);
  if (NOT_AN_ITEM_RE.test(body)) return addHint(out, RUN_COMPOSITION_HINT);
  return out;
}

/** Behavior of a result call for a test case that is not an item of the run. */
const AUTO_ADD_NOTE =
  'The test case should already be an item of the run; if it is not, the behavior is VERSION-SPECIFIC — some Server builds silently ' +
  'ADD it to the run as a new item (verified live: testCaseCount grows; the new item\'s POSITION in items[] is not the head and not ' +
  'the tail — it landed second of three and second of four in two separate runs, so do not rely on where it appears), others reject ' +
  'the call with 400/404.';

/**
 * The two-call pattern this note used to advise is harmful: the second call goes through the PUT, which
 * replaces the execution. Verified live 2026-07-27 that one call is enough.
 */
const SCRIPT_RESULTS_NOTE =
  'scriptResults carry per-step outcomes of a STEP_BY_STEP script as { index (0-based), status, comment? }. An overall `status` sent ' +
  "TOGETHER with scriptResults is stored as sent (verified live: 'Blocked' with three 'Pass' steps stored 'Blocked') and is NEVER derived " +
  "from the step statuses — scriptResults without a status leave the execution at the project default ('Not Executed'), so pass `status` " +
  'in the SAME call. Some older builds may instead ignore the overall status: read the result back with get_test_run_results rather than ' +
  'sending a second update_last_test_result, which replaces the whole execution. A scriptResults entry whose index is past the last step ' +
  'of the case is discarded silently (HTTP 200, no error).';

const SELECTOR_NOTE =
  'When the same test case is an item of the run several times (e.g. once per environment or assignee), disambiguate with ' +
  'matchEnvironment / matchUserKey; with no selector the API picks one of them itself — measured live it took the FIRST (lowest-id) ' +
  'twin and left the other untouched, so pass a selector whenever the case appears more than once. Selectors only SELECT an existing ' +
  'item — they never set a value, so pass `environment` as well if the result should carry it. matchUserKey matches executedBy/userKey, ' +
  'not assignedTo. If nothing matches, this build answers 400 "No test execution found …" or an empty-bodied HTTP 500 — the 500 was first ' +
  'seen with matchEnvironment, but other inputs produce it too, so its cause is undetermined; that empty-bodied 500 has been observed to ' +
  'write the execution and add a duplicate item anyway, so the write may or may not have happened — re-read with get_test_run_results ' +
  'instead of retrying.';

const RESULT_FIELD_KEYS = Object.keys(testResultFieldsShape) as Array<keyof typeof testResultFieldsShape>;

/**
 * Fields the PUT endpoint resets when they are absent from the body — it REPLACES the execution instead
 * of patching it (verified live: an omitted status fell back to the instance default, executedBy to null,
 * actualEndDate/executionDate to the server time). scriptResults, which the API does preserve, and derived
 * fields (executionDate, userKey, automated) are deliberately not re-sent.
 */
const MERGED_FIELD_KEYS = [
  'status',
  'executedBy',
  'assignedTo',
  'environment',
  'comment',
  'executionTime',
  'actualStartDate',
  'actualEndDate',
  'iteration',
  'version',
] as const;

/** Only scalars the API actually returned are re-sent — never a null, never a re-serialized object. */
function isReusableValue(value: unknown): value is string | number {
  return (typeof value === 'string' && value !== '') || typeof value === 'number';
}

/** Build the request body from the result fields only — never keys or item selectors, never unpassed optionals. */
function resultFieldsBody(args: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of RESULT_FIELD_KEYS) picked[key] = args[key];
  return compact(picked);
}

interface ItemSelection {
  testRunKey: string;
  testCaseKey: string;
  matchEnvironment?: string | undefined;
  matchUserKey?: string | undefined;
}

/**
 * Read the execution the PUT is about to replace: the latest execution of the addressed run item. Any
 * failure is swallowed — a pre-read must never turn a working update into an error.
 */
async function currentExecution(cfg: Config, args: ItemSelection): Promise<Record<string, unknown> | undefined> {
  let results: Array<Record<string, unknown>>;
  try {
    ({ results } = await collectRunResults(cfg, args.testRunKey, true));
  } catch {
    return undefined;
  }
  let newest: Record<string, unknown> | undefined;
  for (const r of results) {
    if (r.testCaseKey !== args.testCaseKey) continue;
    if (args.matchEnvironment !== undefined && r.environment !== args.matchEnvironment) continue;
    if (args.matchUserKey !== undefined && r.executedBy !== args.matchUserKey && r.userKey !== args.matchUserKey) continue;
    // Without a selector the API amends the NEWEST matching item (found live) — mirror that choice.
    if (!newest || Number(r.id ?? 0) >= Number(newest.id ?? 0)) newest = r;
  }
  return newest;
}

/** POST/PUT endpoint of the results of one run item, addressed by run key + test case key. */
const singleResultPath = (testRunKey: string, testCaseKey: string): string =>
  atm(encodePath('/testrun', testRunKey, 'testcase', testCaseKey, 'testresult'));

const bulkResultsPath = (testRunKey: string): string => atm(encodePath('/testrun', testRunKey, 'testresults'));

/** Shared input of create_test_result / update_last_test_result. */
const singleResultInput = {
  testRunKey: testRunKeySchema,
  testCaseKey: testCaseKeySchema.describe("Test case key, e.g. PROJ-T123 — should already be one of the run's items"),
  ...itemSelectorsShape,
  ...testResultFieldsShape,
};

export function registerTestResultTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_result',
    description:
      'Record a NEW execution of a run item (POST /testrun/{runKey}/testcase/{caseKey}/testresult). Appends to the execution history ' +
      'of that item — to amend the newest execution instead, use update_last_test_result. Only the fields you pass are sent, and the ' +
      'execution keeps the project default for everything you omit. ' +
      `${AUTO_ADD_NOTE} ${RESULT_STATUS_NOTE} ${SCRIPT_RESULTS_NOTE} ${SELECTOR_NOTE} ` +
      'Returns { id } of the created execution.',
    inputSchema: singleResultInput,
    annotations: {},
    handler: async (args, { cfg }) => {
      try {
        return await zephyrFetch(cfg, {
          method: 'POST',
          path: singleResultPath(args.testRunKey, args.testCaseKey),
          query: selectorQuery(args),
          body: resultFieldsBody(args),
        });
      } catch (err) {
        throw withResultHints(err, { hasSelector: args.matchEnvironment !== undefined || args.matchUserKey !== undefined });
      }
    },
  });

  defineTool(server, cfg, {
    name: 'update_last_test_result',
    description:
      'Amend the LAST (most recent) execution of a run item (PUT /testrun/{runKey}/testcase/{caseKey}/testresult). The endpoint ' +
      'REPLACES the execution instead of patching it: fields missing from the body are reset (verified live — an omitted status falls ' +
      "back to the project default 'Not Executed', executedBy becomes null, actualEndDate/executionDate jump to the server time; only " +
      'comment, environment, executionTime, actualStartDate and scriptResults are kept by the API itself). To stop a comment edit from ' +
      'wiping the verdict, this tool therefore first READS the run item\'s current execution (one extra GET, two requests on builds ' +
      'without /testresults/page) and re-sends what you did not pass: status, executedBy, assignedTo, environment, comment, ' +
      'executionTime, actualStartDate, actualEndDate, iteration, version — exactly as the API returned them, never invented. So ' +
      'omitting a field means "keep it", not "clear it"; a value the API does not return cannot be preserved; and if the pre-read fails ' +
      'or the item has no execution yet, only your fields are sent. Older executions are unreachable here — record a new one with ' +
      'create_test_result, or edit any execution by id with update_test_result_by_id (internal API, when enabled). ' +
      `${AUTO_ADD_NOTE} ${RESULT_STATUS_NOTE} ${SCRIPT_RESULTS_NOTE} ${SELECTOR_NOTE} ` +
      'Returns the API response ({ id } of the amended execution on the audited build), or { updated: true, testRunKey, testCaseKey } ' +
      'when the API answers with an empty body.',
    inputSchema: singleResultInput,
    annotations: {},
    handler: async (args, { cfg }) => {
      const body = resultFieldsBody(args);
      const previous = await currentExecution(cfg, args);
      if (previous) {
        for (const key of MERGED_FIELD_KEYS) {
          if (key in body) continue;
          const value = previous[key];
          if (isReusableValue(value)) body[key] = value;
        }
      }
      let res: unknown;
      try {
        res = await zephyrFetch(cfg, {
          method: 'PUT',
          path: singleResultPath(args.testRunKey, args.testCaseKey),
          query: selectorQuery(args),
          body,
        });
      } catch (err) {
        throw withResultHints(err, { hasSelector: args.matchEnvironment !== undefined || args.matchUserKey !== undefined });
      }
      return isEmptyResponse(res) ? { updated: true, testRunKey: args.testRunKey, testCaseKey: args.testCaseKey } : res;
    },
  });

  defineTool(server, cfg, {
    name: 'create_test_results_bulk',
    description:
      'Record NEW executions for several items of ONE test run in a single call (POST /testrun/{runKey}/testresults). The body is the ' +
      '`results` array itself; in each entry only the fields you pass are sent, and the returned ids are positionally aligned with it. ' +
      `${AUTO_ADD_NOTE} ${RESULT_STATUS_NOTE} ${SCRIPT_RESULTS_NOTE} ` +
      'matchEnvironment / matchUserKey apply to the WHOLE batch and only SELECT which existing run item to append to — they never set ' +
      "the created result's environment. NOT ATOMIC, and it does NOT abort at the failing entry: when one entry is rejected (unknown " +
      'testCaseKey, bad status/iteration/version value, unknown custom field) the call answers an error and returns no ids, yet that ' +
      'entry alone is SKIPPED while EVERY other valid entry is COMMITTED — the entries AFTER the failing one just as much as those ' +
      'before it (verified live twice, with ids: [valid, valid, unknown key, valid] committed entries 1, 2 and 4; [unknown key, valid] ' +
      'committed entry 2). So after an error that names ONE entry the batch may already be fully written except for that entry: ' +
      're-read the run with get_test_run_results BEFORE resending anything and resend only the entries that are genuinely missing — ' +
      'resending the batch or its tail creates DUPLICATE executions. An error that rejects the payload as a whole (a malformed body, ' +
      'an unknown run key, a batch-wide matchEnvironment/matchUserKey the API cannot resolve) is different: it is refused before any ' +
      'entry is processed, so nothing was committed and nothing needs re-reading. Two entries for the same test case create two ' +
      'independent executions (no upsert). ' +
      'Returns the array of created executions ([{ id }, …]).',
    inputSchema: {
      testRunKey: testRunKeySchema,
      results: z
        .array(runItemSchema)
        .min(1)
        .describe("One entry per execution to record; each targets a run item by testCaseKey and carries that execution's fields"),
      ...itemSelectorsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      try {
        return await zephyrFetch(cfg, {
          method: 'POST',
          path: bulkResultsPath(args.testRunKey),
          query: selectorQuery(args),
          body: args.results.map((result) => compact(result)),
        });
      } catch (err) {
        throw withResultHints(err, {
          hasSelector: args.matchEnvironment !== undefined || args.matchUserKey !== undefined,
          batch: true,
        });
      }
    },
  });

  defineTool(server, cfg, {
    name: 'get_latest_result_for_test_case',
    description:
      'Read ONE execution of a test case across ALL test runs (GET /testcase/{key}/testresult/latest). WHICH one is the API\'s choice ' +
      'and it is not the plain "newest": measured live with three executions of one case, it returned the most recently CREATED one ' +
      '(highest id) even though another carried a later execution date, and back-dating the winner did not dislodge it — so neither ' +
      '"latest by date" nor "latest by date you set" is a safe reading. Treat the answer as "an execution the API considers current" ' +
      'and, whenever the specific execution matters, read the run with get_test_run_results instead. ' +
      'Answers 404 when the case has never been executed. ' +
      'Returns the execution object as the API stores it (id, testCaseKey, status, environment, executedBy, scriptResults, …). ' +
      'Read-back quirks seen live: executionDate mirrors actualEndDate, executedBy is duplicated as userKey (both absent when there is ' +
      'no executor), every result created through the API carries automated: true, issueLinks come back as traceLinks, and a case with ' +
      'no script still returns one stepless scriptResults entry.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, { method: 'GET', path: atm(encodePath('/testcase', args.testCaseKey, 'testresult', 'latest')) }),
  });
}
