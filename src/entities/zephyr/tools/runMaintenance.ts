import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { addHint, atm, zephyrFetch } from '../http.ts';
import {
  asNumericId,
  CAPTURED_NOTE,
  fetchEntity,
  fetchRunItems,
  internal,
  internalCall,
  INTERNAL_NOTE,
  resolveEntityId,
  runItemCaseId,
  runItemCaseKey,
  runItemIndex,
  saveRunItems,
  VERIFIED_NOTE,
  type RunItem,
} from '../internal.ts';
import { collectRunResults, COLLECT_MAX_PAGES, COLLECT_PAGE_SIZE } from '../runResults.ts';
import {
  customFieldsSchema,
  folderPathSchema,
  issueKeySchema,
  runItemSchema,
  RUN_IMMUTABILITY_NOTE,
  testCaseKeySchema,
  testPlanKeySchema,
  testResultFieldsShape,
  testRunKeySchema,
  USER_KEY_NOTE,
} from '../schemas.ts';
import { compact, defineTool, encodePath, ToolInputError } from '../toolkit.ts';
import { refuseIssueLinks, RUN_ISSUE_LINKS_DESCRIBE } from './testRuns.ts';

/* ─────────────────────────────────────────────────────────────────────────────
 * recreate_test_run_with_items — the public escape hatch from run immutability
 * ────────────────────────────────────────────────────────────────────────── */

/** Execution-result fields that may be carried over into the items of the recreated run. */
const RESULT_FIELD_KEYS = Object.keys(testResultFieldsShape);

/** A run as GET /testrun returns it: header fields plus `items`, both full of read-only extras. */
type SourceRun = Record<string, unknown>;

/** Header fields of the new run; every one of them falls back to the source run's value. */
interface RecreateHeaderArgs {
  testRunKey: string;
  name?: string | undefined;
  folder?: string | undefined;
  testPlanKey?: string | undefined;
  issueLinks?: string[] | undefined;
  iteration?: string | undefined;
  version?: string | undefined;
  owner?: string | undefined;
  plannedStartDate?: string | undefined;
  plannedEndDate?: string | undefined;
  customFields?: Record<string, unknown> | undefined;
}

/** A step index POST /testrun accepts: a non-negative integer (numeric strings are coerced like every id). */
function scriptStepIndex(raw: unknown): number | undefined {
  const index = asNumericId(raw);
  return index !== undefined && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * Strip stored script results down to the { index, status, comment } shape POST /testrun accepts.
 *
 * `index` is REQUIRED there, and this API stores the execution of a test case WITHOUT a STEP_BY_STEP
 * script as a single index-less stub `[{ status: 'Not Executed' }]` (found live). Forwarding that
 * verbatim made the whole create fail with 400 {"errorMessages":["The field index is required."]}, so:
 * entries carrying a usable index keep it, a set of several index-less entries is numbered by array
 * position (their order is the only sequence the payload carries), and a lone index-less entry — the
 * stub, since even a one-step script reports index 0 — leaves nothing usable and drops the field.
 * Returns undefined when no entry survives, which means "do not send scriptResults at all".
 */
function sanitizeScriptResults(raw: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const steps = raw.map((entry) => (entry ?? {}) as Record<string, unknown>);
  const indexes = steps.map((step) => scriptStepIndex(step.index));
  const byPosition = indexes.length > 1 && indexes.every((index) => index === undefined);
  const kept = steps.flatMap((step, position) => {
    const index = indexes[position] ?? (byPosition ? position : undefined);
    if (index === undefined) return [];
    return [compact({ index, status: step.status, comment: step.comment ?? undefined })];
  });
  return kept.length > 0 ? kept : undefined;
}

/** Pick only the writable result fields from a stored execution (drops ids, read-only extras and nulls). */
function copyableResultFields(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of RESULT_FIELD_KEYS) {
    const value = result[key];
    if (value === undefined || value === null) continue;
    if (key === 'scriptResults') {
      const scriptResults = sanitizeScriptResults(value);
      if (scriptResults !== undefined) out[key] = scriptResults;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Explicit argument wins; otherwise the source run's value, with JSON null treated as absent. */
const inherit = (explicit: unknown, sourceValue: unknown): unknown => (explicit !== undefined ? explicit : (sourceValue ?? undefined));

/** Collect the LAST execution of every item of the run, indexed by testCaseKey. */
async function collectLatestResults(
  cfg: Config,
  testRunKey: string,
): Promise<{ latest: Map<string, Record<string, unknown>>; truncated: boolean }> {
  const { results, truncated } = await collectRunResults(cfg, testRunKey, true);
  const latest = new Map<string, Record<string, unknown>>();
  for (const value of results) {
    if (typeof value?.testCaseKey === 'string') latest.set(value.testCaseKey, value);
  }
  return { latest, truncated };
}

/** Source items to carry over: original order, minus the removed test case keys. */
function keptSourceItems(source: SourceRun, removed: Set<string>): Array<Record<string, unknown> & { testCaseKey: string }> {
  const items = (Array.isArray(source.items) ? source.items : []) as Array<Record<string, unknown>>;
  return items.filter(
    (item): item is Record<string, unknown> & { testCaseKey: string } =>
      typeof item.testCaseKey === 'string' && !removed.has(item.testCaseKey),
  );
}

/** Rebuild the kept items for POST /testrun, optionally merging in each case's latest execution. */
function buildRecreatedItems(
  kept: Array<Record<string, unknown> & { testCaseKey: string }>,
  latestResults: Map<string, Record<string, unknown>>,
): { items: Array<Record<string, unknown>>; copiedResults: number } {
  let copiedResults = 0;
  const items = kept.map((item) => {
    // Items of GET /testrun carry read-only extras (ids, statuses, execution dates) — keep only the planning fields.
    const planning = compact({
      testCaseKey: item.testCaseKey,
      environment: item.environment ?? undefined,
      assignedTo: item.assignedTo ?? undefined,
    });
    const result = latestResults.get(item.testCaseKey);
    if (!result) return planning;
    copiedResults++;
    // Planning fields win over the copied result: a case included as several items keeps each item's
    // own environment/assignee while all of them receive that case's latest execution.
    return { ...copyableResultFields(result), ...planning };
  });
  return { items, copiedResults };
}

/** Body of POST /testrun: explicit header arguments over the source run's values, plus the new items. */
function recreatedRunBody(args: RecreateHeaderArgs, source: SourceRun, items: Array<Record<string, unknown>>): Record<string, unknown> {
  return compact({
    projectKey: source.projectKey ?? args.testRunKey.split('-')[0],
    name: inherit(args.name, source.name),
    folder: inherit(args.folder, source.folder),
    testPlanKey: inherit(args.testPlanKey, source.testPlanKey),
    // issueLinks is never forwarded, not even when the source run reports it: POST /testrun has no such
    // field on its DTO and answers 500 for any value (see RUN_ISSUE_LINKS_UNSUPPORTED).
    iteration: inherit(args.iteration, source.iteration),
    version: inherit(args.version, source.version),
    owner: inherit(args.owner, source.owner),
    plannedStartDate: inherit(args.plannedStartDate, source.plannedStartDate),
    plannedEndDate: inherit(args.plannedEndDate, source.plannedEndDate),
    customFields: inherit(args.customFields, source.customFields),
    items,
  });
}

/** Rethrow with `note` attached — addHint only decorates ZephyrApiError, so plain errors get it appended. */
function rethrowWithNote(err: unknown, note: string): never {
  const hinted = addHint(err, note);
  if (hinted !== err) throw hinted;
  throw new Error(`${err instanceof Error ? err.message : String(err)}\n${note}`);
}

/** Delete the source run, making sure the key of the already-created new run survives in any error. */
async function deleteSourceRun(cfg: Config, sourceKey: string, newKey: string): Promise<void> {
  try {
    await zephyrFetch(cfg, { method: 'DELETE', path: encodePath(atm('/testrun'), sourceKey) });
  } catch (err) {
    rethrowWithNote(err, `The new run ${newKey} WAS created successfully — only deleting the source run ${sourceKey} failed.`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Internal-API plumbing shared by the in-place run editors
 * ────────────────────────────────────────────────────────────────────────── */

/** Resolve run items to add: one entry per key, in the given order, with the batch-local index. */
async function buildAddedItems(cfg: Config, testCaseKeys: string[], assignedTo: string | undefined): Promise<Array<Record<string, unknown>>> {
  const added: Array<Record<string, unknown>> = [];
  for (const [batchIndex, key] of testCaseKeys.entries()) {
    const testCaseId = await resolveEntityId(cfg, 'testcase', key);
    // `index` is 0-based WITHIN the added batch: an absolute position is rejected with
    // "Invalid: index value out of range" (verified live against the stand).
    added.push({ index: batchIndex, lastTestResult: compact({ testCaseId, assignedTo }) });
  }
  return added;
}

/** Items of a run in their stored order. */
const inRunOrder = (items: RunItem[]): RunItem[] => [...items].sort((a, b) => runItemIndex(a) - runItemIndex(b));

/**
 * The complete renumbering of a sequence: every item gets its position as index, 0..n-1.
 *
 * Never a partial batch: PUT /testrunitem/bulk/save validates each submitted index against the SIZE of
 * the submitted batch, so sending only the items that move is rejected with 400 "Invalid: index value
 * out of range" as soon as one of them lands beyond the batch (found live — a plain swap of the last
 * two items of a 3-item run was enough). A full 0..n-1 batch is always legal, even on a run whose
 * stored indexes have holes.
 */
const fullReindex = (sequence: RunItem[]): Array<{ id: number; index: number }> =>
  sequence.map((item, index) => ({ id: item.id, index }));

/** How many items of the sequence are not already stored at their target position. */
const movedCount = (sequence: RunItem[]): number =>
  sequence.reduce((moved, item, index) => (runItemIndex(item) === index ? moved : moved + 1), 0);

/**
 * Add items to a run and leave its item indexes a clean 0..n-1 sequence.
 *
 * Two writes are unavoidable, and the reason is worth spelling out (captured from the Jira UI):
 * the server validates an added item's `index` WITHIN the batch, so new items always land at the
 * FRONT — the UI compensates by re-indexing every existing item in the same request, and skipping
 * that leaves two items sharing index 0, which makes every later reorder fail with
 * "Invalid: index value out of range". The added items have no ids until they exist, so restoring the
 * documented append order takes a second call.
 */
async function appendItemsKeepingOrder(
  cfg: Config,
  runId: number,
  added: Array<Record<string, unknown>>,
): Promise<{ totalItems: number }> {
  const before = inRunOrder(await fetchRunItems(cfg, runId));
  await saveRunItems(cfg, runId, {
    added,
    indexes: before.map((item, position) => ({ id: item.id, index: position + added.length })),
  });

  const after = await fetchRunItems(cfg, runId);
  const knownIds = new Set(before.map((item) => item.id));
  const byId = new Map(after.map((item) => [item.id, item]));
  const survivors = before.flatMap((item) => byId.get(item.id) ?? []);
  const fresh = inRunOrder(after.filter((item) => !knownIds.has(item.id)));
  const sequence = [...survivors, ...fresh];
  if (movedCount(sequence) > 0) await saveRunItems(cfg, runId, { indexes: fullReindex(sequence) });
  return { totalItems: after.length };
}

/**
 * Close the index holes a delete leaves behind.
 *
 * The endpoint does NOT renumber the survivors of a deletion: removing the item at index 1 of a 4-item
 * run leaves the stored sequence 0,2,3 (found live), and everything that reads or rewrites indexes then
 * starts from a broken sequence. One extra bulk/save fixes it; it is skipped when nothing is left or the
 * survivors happen to be contiguous already (removing a trailing item).
 */
async function renumberSurvivors(cfg: Config, runId: number, survivors: RunItem[], removedNote: string): Promise<void> {
  const sequence = inRunOrder(survivors);
  if (sequence.length === 0 || movedCount(sequence) === 0) return;
  try {
    await saveRunItems(cfg, runId, { indexes: fullReindex(sequence) });
  } catch (err) {
    rethrowWithNote(err, removedNote);
  }
}

/** Numeric id plus project id of a run — PUT /testrun/{id} wants projectId echoed back in the body. */
async function fetchRunIdentity(cfg: Config, testRunKey: string): Promise<{ id: number; projectId?: number }> {
  const run = await fetchEntity(cfg, 'testrun', testRunKey, 'id,projectId');
  const id = asNumericId(run.id);
  if (id === undefined) {
    throw new Error(`Could not resolve the numeric id of test run '${testRunKey}' (response: ${JSON.stringify(run)})`);
  }
  const projectId = asNumericId(run.projectId);
  return projectId === undefined ? { id } : { id, projectId };
}

/** Read the default trace-link type the UI uses when attaching runs to a plan. */
async function fetchDefaultRunLinkTypeId(cfg: Config): Promise<number> {
  const linkType = (await zephyrFetch(cfg, { method: 'GET', path: internal('/tracelinktype/default/testrun') })) as { id?: unknown };
  const id = asNumericId(linkType?.id);
  if (id === undefined) {
    throw new Error(`Could not resolve the default test-run trace-link type (response: ${JSON.stringify(linkType)})`);
  }
  return id;
}

/** Longest run name this build stores — beyond it the internal endpoint answers 200 and truncates. */
const RUN_NAME_MAX = 255;

/** ISO 8601 date-time carrying no zone designator at all: "2026-09-02T08:30", "2026-09-02T08:30:00.5". */
const OFFSETLESS_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Normalize a date to yyyy-MM-ddTHH:mm:ss.SSSZ — the only shape PUT /testrun/{id} accepts.
 *
 * Found live: a value without milliseconds ("2026-10-05T12:00:00Z"), a date-only value ("2026-10-05")
 * and a numeric UTC offset ("2026-10-05T12:00:00+03:00") are each answered with an empty HTTP 500,
 * while the public create endpoint takes them all.
 *
 * A zone-less value is read as UTC. The ECMAScript grammar reads a date-ONLY form as UTC but a
 * date-TIME form without an offset as LOCAL, so feeding the raw string to Date stored the same input
 * differently depending on the MCP server's timezone (found live on a UTC+4 host: "2026-09-02T08:30:00"
 * became 04:30Z while "2026-08-01" became 00:00Z). One rule for both forms is the only defensible one.
 */
function internalDate(field: string, value: string): string {
  const at = new Date(OFFSETLESS_DATETIME.test(value.trim()) ? `${value.trim()}Z` : value);
  if (Number.isNaN(at.getTime())) {
    throw new ToolInputError(`${field} is not a valid date: '${value}'. Pass ISO 8601, e.g. 2026-07-20T09:00:00Z.`);
  }
  return at.toISOString();
}

/**
 * Read the patched fields back so `updated` reports what the run really stores rather than the request.
 * The endpoint answers 200 while silently truncating an over-long name (found live), so the echo can
 * lie; a read that fails or does not report a field falls back to the value that was sent.
 */
async function storedRunFields(cfg: Config, testRunKey: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stored = await fetchEntity(cfg, 'testrun', testRunKey, Object.keys(patch).join(',')).catch(
    () => ({}) as Record<string, unknown>,
  );
  const updated: Record<string, unknown> = {};
  for (const [field, sent] of Object.entries(patch)) {
    updated[field] = stored[field] ?? sent;
  }
  return updated;
}

/** Order the run's items so that the listed cases come first, unlisted ones keeping their order after them. */
function sequenceForOrder(items: RunItem[], order: string[], testRunKey: string): RunItem[] {
  const unused = [...items];
  const listed: RunItem[] = [];
  for (const key of order) {
    const at = unused.findIndex((item) => runItemCaseKey(item) === key);
    if (at === -1) {
      // An empty run has no list to print, and "Current items:" followed by nothing reads like a bug.
      const current = items.map((item) => runItemCaseKey(item)).filter((caseKey): caseKey is string => caseKey !== undefined);
      throw new ToolInputError(
        current.length === 0
          ? `Test run ${testRunKey} has no items to reorder, so there is no item for test case ${key}.`
          : `No (remaining) item for test case ${key} in ${testRunKey}. Current items: ${current.join(', ')}`,
      );
    }
    listed.push(...unused.splice(at, 1));
  }
  return [...listed, ...unused];
}

export function registerRunMaintenanceTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'recreate_test_run_with_items',
    description:
      'Recreate a test run (cycle) under a NEW key with a changed item list, name or folder ' +
      '(GET /testrun/{key} + POST /testrun, plus DELETE /testrun/{key} when deleteOriginal=true). ' +
      RUN_IMMUTABILITY_NOTE +
      ' Items of the new run are: the source items in their original order, minus removeTestCaseKeys, plus addItems appended; ' +
      'of the source items only the planning fields (testCaseKey, environment, assignedTo) are carried over when copyResults is false ' +
      '— all read-only item data is dropped. ' +
      'The new run gets a NEW key and nothing that referenced the old one is updated. Header fields not passed explicitly are ' +
      'inherited from the source run (a JSON null there counts as absent) — EXCEPT testPlanKey, which GET /testrun does not report at ' +
      'all, so the new run starts with no plan association unless you pass it (or re-link with link_test_run_to_plan). ' +
      'A run cannot carry Jira issue links at all: issueLinks is rejected locally, and any value the source run reports is dropped ' +
      'rather than forwarded — link the issues on the test cases instead. ' +
      'removeTestCaseKeys filters the SOURCE items only: a key that also appears in addItems is still added. ' +
      'deleteOriginal runs only after POST /testrun succeeded, so a failed create leaves the source run untouched. ' +
      "copyResults=true carries each kept case's LAST execution over as the initial result of its item, while the item's own " +
      'environment/assignedTo still win — but GET /testrun reports each item MERGED with its latest execution, so an item whose ' +
      'configured environment/assignedTo were not repeated in that execution has already lost them before this tool reads the run; ' +
      'set them explicitly through addItems when specific values matter. Copied per-step scriptResults are sanitized: this API stores ' +
      'the execution of a case without a STEP_BY_STEP script as an index-less stub, and POST /testrun requires an index on every ' +
      'entry, so entries without a usable index are numbered by position or dropped. ' +
      'removeTestCaseKeys is a SILENT filter (keys that are not items of the run, including nonexistent ones, are ignored), addItems ' +
      'does NOT deduplicate (adding a case that is already an item creates a second item for it, after which test results for that ' +
      'case need matchEnvironment/matchUserKey), and removing every item is allowed and produces a valid run with zero items. ' +
      'The source run survives unless deleteOriginal=true, and is never deleted when creating the new run failed. ' +
      'Returns { key, originalKey, itemCount, copiedResults, deletedOriginal } plus copyResultsNote when result copying hit its page ' +
      "cap. copiedResults counts the KEPT SOURCE items that had a last execution — including the 'Not Executed' execution the server " +
      'writes for every item at creation, so it is not a count of real executions; addItems entries are never counted, even when they ' +
      'carry a status.',
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the SOURCE test run to recreate, e.g. PROJ-R123 (PROJ-C123 on older instances)'),
      name: z.string().optional().describe("Name of the new run (defaults to the source run's name)"),
      folder: folderPathSchema
        .optional()
        .describe(
          'Full path of an existing TEST_RUN folder starting with "/", e.g. "/Regression" (defaults to the source run\'s folder). The folder MUST already exist.',
        ),
      testPlanKey: testPlanKeySchema
        .optional()
        .describe("Test plan to associate the new run with, e.g. PROJ-P123 (defaults to the source run's value)"),
      issueLinks: z.array(z.string()).optional().describe(RUN_ISSUE_LINKS_DESCRIBE),
      iteration: z.string().optional().describe("Iteration name (defaults to the source run's value)"),
      version: z.string().optional().describe("Version name (defaults to the source run's value)"),
      owner: z.string().optional().describe(`Owner (defaults to the source run's value). ${USER_KEY_NOTE}`),
      plannedStartDate: z.string().optional().describe("ISO 8601, e.g. 2026-07-20T09:00:00Z (defaults to the source run's value)"),
      plannedEndDate: z.string().optional().describe("ISO 8601 (defaults to the source run's value)"),
      customFields: customFieldsSchema()
        .optional()
        .describe("Custom field values keyed by field name (defaults to the source run's values)"),
      addItems: z
        .array(runItemSchema)
        .optional()
        .describe(
          'Extra items appended AFTER the kept source items. Each item requires testCaseKey and may carry full execution result fields ' +
            '(status, environment, executedBy, assignedTo, comment, executionTime, actualStartDate, actualEndDate, customFields, issueLinks, scriptResults).',
        ),
      removeTestCaseKeys: z
        .array(z.string())
        .optional()
        .describe('Source items whose test case key is in this list are DROPPED from the new run, e.g. ["PROJ-T5"]'),
      copyResults: z
        .boolean()
        .optional()
        .describe('Carry the LAST execution of each kept source item over as the initial result of the new run (default false)'),
      deleteOriginal: z
        .boolean()
        .optional()
        .describe(
          'Permanently DELETE the source run with all its execution results after the new run was created successfully (default false). ' +
            'The source run is never deleted otherwise, and never when creating the new run failed.',
        ),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      refuseIssueLinks(args.issueLinks);
      const source = (await zephyrFetch(cfg, { method: 'GET', path: encodePath(atm('/testrun'), args.testRunKey) })) as SourceRun;
      const kept = keptSourceItems(source, new Set(args.removeTestCaseKeys ?? []));

      const { latest, truncated } = args.copyResults
        ? await collectLatestResults(cfg, args.testRunKey)
        : { latest: new Map<string, Record<string, unknown>>(), truncated: false };

      const { items, copiedResults } = buildRecreatedItems(kept, latest);
      items.push(...(args.addItems ?? []).map((item) => compact(item)));

      const created = (await zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/testrun'),
        body: recreatedRunBody(args, source, items),
      })) as { key: string };

      const deleteOriginal = args.deleteOriginal === true;
      if (deleteOriginal) await deleteSourceRun(cfg, args.testRunKey, created.key);

      return compact({
        key: created.key,
        originalKey: args.testRunKey,
        itemCount: items.length,
        copiedResults,
        deletedOriginal: deleteOriginal,
        copyResultsNote: truncated
          ? `Result copying stopped after ${COLLECT_MAX_PAGES * COLLECT_PAGE_SIZE} results — items beyond that limit were recreated without copied results.`
          : undefined,
      });
    },
  });

  // Everything below edits runs through the UNOFFICIAL internal API — gated behind ZEPHYR_ALLOW_INTERNAL_API.
  if (!cfg.allowInternalApi) return;

  defineTool(server, cfg, {
    name: 'add_test_cases_to_run',
    description:
      `${INTERNAL_NOTE} Append test cases to an EXISTING test run (cycle) IN PLACE ` +
      '(GET /testrun/{key} and GET /testcase/{key} to resolve numeric ids, then PUT /testrunitem/bulk/save) — the run keeps its key ' +
      'and the existing items keep their execution results. The public API cannot do this at all; its only workaround, ' +
      'recreate_test_run_with_items, changes the key. New items are appended after the existing ones in the order given, ' +
      'each with an empty (Not Executed) result. Every key is resolved before anything is written, so an unknown key fails the whole call. ' +
      'A case that is already an item of the run is NOT deduplicated — a second item is created for it, with its own empty result, and ' +
      'reorder_test_run_items then matches repeated mentions in `order` to those items in their current order. ' +
      'Costs two bulk/save writes: the endpoint only accepts a batch-local index, so added items land first and every item is then ' +
      'renumbered into a clean 0..n-1 sequence — without that, two items share index 0 and reorder_test_run_items starts failing. ' +
      `${CAPTURED_NOTE} ${VERIFIED_NOTE} Returns { testRunKey, added, addedCount, totalItems }.`,
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the run to extend, e.g. PROJ-R123 (PROJ-C123 on older instances)'),
      testCaseKeys: z
        .array(testCaseKeySchema)
        .min(1)
        .describe('Test case keys to add, in the desired order, e.g. ["PROJ-T1", "PROJ-T2"]'),
      assignedTo: z
        .string()
        .optional()
        .describe(
          `Assignee applied to every added item. ${USER_KEY_NOTE} The stand validates it: an unknown key fails the whole call with ` +
            '400 "Invalid: assignedTo for addedTestRunItems or updatedTestRunItems" on the first write, and nothing is added.',
        ),
    },
    annotations: {},
    handler: async (args, { cfg }) =>
      internalCall(async () => {
        const runId = await resolveEntityId(cfg, 'testrun', args.testRunKey);
        const added = await buildAddedItems(cfg, args.testCaseKeys, args.assignedTo);
        const { totalItems } = await appendItemsKeepingOrder(cfg, runId, added);
        return {
          testRunKey: args.testRunKey,
          added: args.testCaseKeys,
          addedCount: args.testCaseKeys.length,
          totalItems,
        };
      }),
  });

  defineTool(server, cfg, {
    name: 'remove_test_cases_from_run',
    description:
      `${INTERNAL_NOTE} Remove the items of the given test cases from an EXISTING test run (cycle) IN PLACE ` +
      '(GET /testrun/{key}, GET /testcase/{key}, GET /testrun/{id}/testrunitems, then PUT /testrunitem/bulk/save with ' +
      'deletedTestRunItems) — the run keeps its key and the surviving items keep their results. ' +
      'The removed items are deleted TOGETHER WITH their whole execution history and this CANNOT BE UNDONE. ' +
      'When a test case is present in the run as several items, ALL of them are removed. Every key is resolved before anything is ' +
      'written, so an unknown key fails the whole call. The call FAILS with "None of the given test cases are items of <run>", ' +
      'followed by the keys that ARE its items, when ' +
      'none of the given keys is an item of the run, and nothing is written; when at least one key matches, the non-matching keys are ' +
      'silently ignored — check `removed` for the keys that actually took effect. The endpoint leaves a GAP in the stored item indexes ' +
      '(0,2,3), so a second bulk/save renumbers the survivors into a clean 0..n-1 sequence; it is skipped when nothing is left or the ' +
      'survivors are already contiguous. Removing every item is allowed and leaves a valid empty run with its key, name, folder and ' +
      `owner, its derived status back to "Not Executed". ${CAPTURED_NOTE} ` +
      'Returns { testRunKey, removed, removedItemIds, remainingItems } — `removed` names the keys that actually took effect, in RUN ' +
      'order (the order the removed items had in the run), not request order; `removedItemIds` lists the removed items in that same ' +
      'run order, so a case that was present several times contributes one entry to `removed` and several to `removedItemIds`. ' +
      'Repeating a key in testCaseKeys has no extra effect. ' +
      'removedItemIds are internal test-run-item ids from /rest/tests/1.0, a different id space from the item/result ids of ' +
      'get_test_run and get_test_run_results.',
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the run to edit, e.g. PROJ-R123 (PROJ-C123 on older instances)'),
      testCaseKeys: z.array(testCaseKeySchema).min(1).describe('Test case keys whose items to remove, e.g. ["PROJ-T1", "PROJ-T2"]'),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) =>
      internalCall(async () => {
        const runId = await resolveEntityId(cfg, 'testrun', args.testRunKey);

        const caseIdToKey = new Map<number, string>();
        for (const key of args.testCaseKeys) {
          caseIdToKey.set(await resolveEntityId(cfg, 'testcase', key), key);
        }

        const items = await fetchRunItems(cfg, runId);
        const wantedKeys = new Set(args.testCaseKeys);
        const requestedKeyOf = (item: RunItem): string | undefined => {
          const caseId = runItemCaseId(item);
          return (caseId !== undefined ? caseIdToKey.get(caseId) : undefined) ?? runItemCaseKey(item);
        };
        // Sorted by stored index: /testrunitems answers in an arbitrary order that is neither request
        // nor run order (found live: the same two-key removal came back reversed on one run and not on
        // another), and `removed`/`removedItemIds` promise run order.
        const toDelete = inRunOrder(
          items.filter((item) => {
            const caseId = runItemCaseId(item);
            const caseKey = runItemCaseKey(item);
            return (caseId !== undefined && caseIdToKey.has(caseId)) || (caseKey !== undefined && wantedKeys.has(caseKey));
          }),
        );
        if (toDelete.length === 0) {
          const current = inRunOrder(items)
            .map((item) => runItemCaseKey(item))
            .filter((caseKey): caseKey is string => caseKey !== undefined);
          throw new ToolInputError(
            `None of the given test cases are items of ${args.testRunKey} (run has ${items.length} item(s)).` +
              (current.length > 0 ? ` Current items: ${current.join(', ')}` : ''),
          );
        }

        const removedItemIds = toDelete.map((item) => item.id);
        await saveRunItems(cfg, runId, { deleted: removedItemIds });

        const deleted = new Set(removedItemIds);
        await renumberSurvivors(
          cfg,
          runId,
          items.filter((item) => !deleted.has(item.id)),
          `The items ${removedItemIds.join(', ')} WERE removed from ${args.testRunKey} — only renumbering the ` +
            'surviving items afterwards failed, so their indexes still have a gap. reorder_test_run_items repairs it.',
        );

        return {
          testRunKey: args.testRunKey,
          removed: [...new Set(toDelete.map(requestedKeyOf).filter((key): key is string => key !== undefined))],
          removedItemIds,
          remainingItems: items.length - toDelete.length,
        };
      }),
  });

  defineTool(server, cfg, {
    name: 'reorder_test_run_items',
    description:
      `${INTERNAL_NOTE} Reorder the items of an existing test run (cycle) IN PLACE ` +
      '(GET /testrun/{key}, GET /testrun/{id}/testrunitems, then PUT /testrunitem/bulk/save with updatedTestRunItemsIndexes) — ' +
      'the run keeps its key and every item keeps its results. Items whose test case is not listed in `order` keep their relative ' +
      'order AFTER the listed ones; a case present in the run several times has its mentions in `order` matched to its items in ' +
      'current order — so two items of the SAME test case can never be swapped relative to each other, no `order` can express it ' +
      '(remove and re-add them instead). A key matching no remaining item is rejected before anything is written, and a run with no ' +
      'items at all says so instead of listing an empty item set. ' +
      'ALL items are always submitted with indexes 0..n-1: the endpoint validates every index against the size of the submitted ' +
      'batch, so a partial batch is rejected with 400 "Invalid: index value out of range". A run already in the requested order ' +
      'makes no write at all. A full batch is legal even when the stored indexes have a gap, so this also repairs such a run — ' +
      'create_test_result can produce one by silently adding a case to the run without renumbering, after which the first reorder ' +
      'reports a `changed` count for items that never visibly moved. ' +
      `${VERIFIED_NOTE} ` +
      'Returns { testRunKey, order, changed } — order is the resulting full sequence of test case keys, changed the number of items ' +
      'whose stored index differed from its new position (0 means no write happened).',
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the run to reorder, e.g. PROJ-R123'),
      order: z
        .array(testCaseKeySchema)
        .min(1)
        .describe('Test case keys in the desired order, e.g. ["PROJ-T5", "PROJ-T1"]; listing every case is not required'),
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) =>
      internalCall(
        async () => {
          const runId = await resolveEntityId(cfg, 'testrun', args.testRunKey);
          const items = inRunOrder(await fetchRunItems(cfg, runId));
          const sequence = sequenceForOrder(items, args.order, args.testRunKey);
          const resultingOrder = sequence.map((item) => runItemCaseKey(item));
          const changed = movedCount(sequence);
          if (changed === 0) return { testRunKey: args.testRunKey, order: resultingOrder, changed: 0 };

          await saveRunItems(cfg, runId, { indexes: fullReindex(sequence) });
          return { testRunKey: args.testRunKey, order: resultingOrder, changed };
        },
        'Verify reordering on a disposable run first: the shape of the indexes elements may differ on another Zephyr Scale version.',
      ),
  });

  defineTool(server, cfg, {
    name: 'update_test_run',
    description:
      `${INTERNAL_NOTE} Rename a test run (cycle), move it to another folder or change its planned dates IN PLACE ` +
      '(GET /testrun/{key} for the numeric id, then PUT /testrun/{id}, then GET /testrun/{key} again to read the result back) — ' +
      'the run keeps its key, items and results. ' +
      'The public API v1 has no PUT /testrun at all. At least one field to change is required. folderId is the NUMERIC id of a ' +
      'TEST_RUN folder (from get_folder_tree), not a path, and the run is moved without touching its items. The folder type is NOT ' +
      'validated: a TEST_CASE or TEST_PLAN folder id is accepted and really moves the run there, after which it disappears from the ' +
      'test-run folder tree, from the Jira UI cycle tree and from every search_test_runs folder query while get_test_run still ' +
      'reports the foreign path — pass another (real TEST_RUN) folderId to bring it back. ' +
      'The planned dates are normalized to yyyy-MM-ddTHH:mm:ss.SSSZ before the write because this endpoint answers an empty HTTP 500 ' +
      'for any other ISO-8601 form; an unparseable value (including a bare epoch-millisecond number) is rejected locally. A value ' +
      "carrying no timezone — both the date-only \"2026-08-01\" and the date-time \"2026-09-02T08:30:00\" — is read as UTC, never in " +
      "the MCP server's local timezone; pass an explicit offset or Z when you mean another zone. " +
      'A 404/405 means in-place run editing is absent on this build — recreate_test_run_with_items then remains the only way; a 500 ' +
      'with an empty body is normally bad input (an unknown folderId), and the write is atomic, so nothing is applied. ' +
      `${VERIFIED_NOTE} Returns { testRunKey, updated } — updated reports the values read back from the run after the write, ` +
      'falling back to the value sent for a field the read does not report. An empty-string name is accepted and stored.',
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the run to edit, e.g. PROJ-R123 (PROJ-C123 on older instances)'),
      name: z
        .string()
        .max(RUN_NAME_MAX)
        .optional()
        .describe(`New run name, at most ${RUN_NAME_MAX} characters — the endpoint answers 200 and truncates a longer one`),
      folderId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Numeric id of the target TEST_RUN folder (from get_folder_tree or create_folder), not a folder path. ' +
            'Must be > 0, so a run cannot be moved back to the project root.',
        ),
      plannedStartDate: z
        .string()
        .optional()
        .describe('ISO 8601, e.g. 2026-07-20T09:00:00Z — normalized to 2026-07-20T09:00:00.000Z, the only form this endpoint takes'),
      plannedEndDate: z.string().optional().describe('ISO 8601 (see plannedStartDate)'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const { testRunKey, plannedStartDate, plannedEndDate, ...changes } = args;
      const patch = compact({
        ...changes,
        plannedStartDate: plannedStartDate === undefined ? undefined : internalDate('plannedStartDate', plannedStartDate),
        plannedEndDate: plannedEndDate === undefined ? undefined : internalDate('plannedEndDate', plannedEndDate),
      });
      if (Object.keys(patch).length === 0) {
        throw new ToolInputError('Pass at least one field to change (name, folderId, plannedStartDate, plannedEndDate).');
      }
      const updated = await internalCall(
        async () => {
          const run = await fetchRunIdentity(cfg, testRunKey);
          await zephyrFetch(cfg, {
            method: 'PUT',
            path: internal(`/testrun/${run.id}`),
            body: compact({ id: run.id, projectId: run.projectId, ...patch }),
          });
          return storedRunFields(cfg, testRunKey, patch);
        },
        'In-place run editing is experimental: a 404/405 means it does not exist on this Zephyr Scale version — use recreate_test_run_with_items instead. ' +
          'A 500 with an empty body normally means bad INPUT (an unknown folderId), not a missing endpoint; the write is atomic, so nothing was applied.',
      );
      return { testRunKey, updated };
    },
  });

  defineTool(server, cfg, {
    name: 'link_test_run_to_plan',
    description:
      `${INTERNAL_NOTE} Associate an EXISTING test run (cycle) with a test plan after creation ` +
      '(GET /testrun/{key} and GET /testplan/{key} for the numeric ids, GET /tracelinktype/default/testrun for the link type, ' +
      'then POST /tracelink/bulk/create with a flat [{ testRunId, testPlanId, typeId }] triple). The public API only accepts ' +
      'testPlanKey while the run is being created. The link is one-directional bookkeeping: the run keeps its key, items and results — ' +
      'but both the run and the plan get their updatedBy/updatedOn audit fields stamped. ' +
      'NOT idempotent: calling it twice for the same pair creates a SECOND trace link and the run then appears TWICE in ' +
      'get_test_plan(...).testRuns, and the same happens when the run was already attached through create_test_run\'s testPlanKey. ' +
      'No API can delete an individual trace link, so the only way to clear a duplicate is deleting the run (which cascades all of its ' +
      `links) or the plan — read get_test_plan(...).testRuns BEFORE linking. ${CAPTURED_NOTE} ${VERIFIED_NOTE} ` +
      'Returns { linked: true, testRunKey, testPlanKey, typeId }; linked:true only means the POST succeeded, not that the link is new.',
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the run to attach, e.g. PROJ-R123 (PROJ-C123 on older instances)'),
      testPlanKey: testPlanKeySchema.describe('Key of the test plan to attach it to, e.g. PROJ-P123'),
    },
    annotations: {},
    handler: async (args, { cfg }) =>
      internalCall(async () => {
        const testRunId = await resolveEntityId(cfg, 'testrun', args.testRunKey);
        const testPlanId = await resolveEntityId(cfg, 'testplan', args.testPlanKey);
        const typeId = await fetchDefaultRunLinkTypeId(cfg);
        await zephyrFetch(cfg, {
          method: 'POST',
          path: internal('/tracelink/bulk/create'),
          body: [{ testRunId, testPlanId, typeId }],
        });
        return { linked: true, testRunKey: args.testRunKey, testPlanKey: args.testPlanKey, typeId };
      }),
  });

  defineTool(server, cfg, {
    name: 'link_issues_to_test_run',
    description:
      `${INTERNAL_NOTE} Link Jira issues to an EXISTING test run (cycle) — the traceability the public API cannot express at ` +
      'all: POST /testrun rejects an issueLinks field outright (HTTP 500 "Unrecognized field \'issueLinks\' (TestRunDTO)"), so ' +
      'this endpoint is the only way. Resolves the run id (GET /testrun/{key}), each issue id (GET /rest/api/2/issue/{key}) and ' +
      'the default link type (GET /tracelinktype/default/testrun), then POSTs /tracelink/bulk/create with one ' +
      '{ testRunId, issueId, typeId } triple per issue — every issue in a single request. ' +
      'Afterwards the public GET /testrun reports only ONE of the linked issues — the most recently linked — in its `issueKey` ' +
      'field, and `issueCount` stays 0 on this build (measured with two issues linked: issueKey named the second, issueCount 0). ' +
      'Neither field can confirm the full set, so check your work in the Traceability tab. ' +
      'NOT idempotent: linking the same issue twice creates a SECOND trace link, and no API deletes an individual link — the only ' +
      `way to clear one is deleting the run. ${CAPTURED_NOTE} ${VERIFIED_NOTE} ` +
      'Returns { linked: true, testRunKey, issueKeys, typeId, links } where links carries the created trace-link ids.',
    inputSchema: {
      testRunKey: testRunKeySchema.describe('Key of the run to link, e.g. PROJ-R123 (PROJ-C123 on older instances)'),
      issueKeys: z
        .array(issueKeySchema)
        .min(1)
        .describe('Jira issue keys to link to the run, e.g. ["PROJ-123", "PROJ-456"]; all of them go in one request'),
    },
    annotations: {},
    handler: async (args, { cfg }) =>
      internalCall(async () => {
        const testRunId = await resolveEntityId(cfg, 'testrun', args.testRunKey);
        const typeId = await fetchDefaultRunLinkTypeId(cfg);
        const triples: Array<{ testRunId: number; issueId: string; typeId: number }> = [];
        for (const issueKey of args.issueKeys) {
          // Resolved through Jira's own API: the trace-link endpoint addresses issues by NUMERIC id, as a string
          // (captured from the Jira UI), while every key the caller knows is the human one.
          const issue = (await zephyrFetch(cfg, {
            method: 'GET',
            path: encodePath('/rest/api/2/issue', issueKey),
            query: { fields: 'summary' },
          })) as { id?: unknown };
          const issueId = asNumericId(issue.id);
          if (issueId === undefined) {
            throw new ToolInputError(`Could not resolve the numeric id of Jira issue '${issueKey}' (response: ${JSON.stringify(issue)})`);
          }
          triples.push({ testRunId, issueId: String(issueId), typeId });
        }
        const created = await zephyrFetch(cfg, { method: 'POST', path: internal('/tracelink/bulk/create'), body: triples });
        return {
          linked: true,
          testRunKey: args.testRunKey,
          issueKeys: args.issueKeys,
          typeId,
          links: Array.isArray(created) ? created : undefined,
        };
      }),
  });
}
