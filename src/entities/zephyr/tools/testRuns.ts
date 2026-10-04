import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { atm, zephyrFetch, ZephyrApiError } from '../http.ts';
import { collectRunResults, COLLECT_MAX_PAGES, COLLECT_PAGE_SIZE, fetchRunResultsPage } from '../runResults.ts';
import {
  runItemSchema,
  customFieldsSchema,
  fieldsSchema,
  FOLDER_MUST_EXIST_NOTE,
  folderPathSchema,
  maxResultsSchema,
  PAGINATION_NOTE,
  projectKeySchema,
  RESULT_STATUS_NOTE,
  RUN_IMMUTABILITY_NOTE,
  startAtSchema,
  testCaseKeySchema,
  testPlanKeySchema,
  testResultFieldsShape,
  testRunKeySchema,
  TQL_CHEATSHEET,
  USER_KEY_NOTE,
} from '../schemas.ts';
import { compact, defineTool, encodePath, fieldsParam, pageArgs, pageEnvelope, resolveProjectKey, ToolInputError } from '../toolkit.ts';

/** Path of a run or one of its sub-resources: runPath('PROJ-R1', 'testresults'). */
const runPath = (testRunKey: string, ...segments: string[]): string => atm(encodePath('/testrun', testRunKey, ...segments));

/**
 * Why run-level `issueLinks` is refused before the request instead of being forwarded.
 *
 * Found live: POST /testrun answers HTTP 500 with a ~2 KB Jackson stack trace — 'Unrecognized field
 * "issueLinks" (Class com.kanoah.testmanager.service.model.TestRunDTO), not marked as ignorable' — for
 * ANY value, including an empty array, and creates nothing. The field is absent from the server's DTO,
 * not merely unconfigured, so no per-instance setting can make it work; GET /testrun correspondingly
 * always reports issueCount 0. Forwarding it can only produce an unhandled 500, so the parameter is
 * kept in the schema (dropping it would make a passed value silently vanish) and rejected by name.
 */
export const RUN_ISSUE_LINKS_UNSUPPORTED =
  'issueLinks is not supported for test runs on this API: POST /rest/atm/1.0/testrun answers HTTP 500 ' +
  '\'Unrecognized field "issueLinks" (TestRunDTO), not marked as ignorable\' for any value (an empty array included) and ' +
  'creates nothing, and GET /testrun always reports issueCount 0. Nothing was sent. Link the Jira issues on the TEST CASES ' +
  'instead — create_test_case or update_test_case with issueLinks — or link them to the RUN with link_issues_to_test_run, which ' +
  'reaches the trace-link endpoint the Jira UI uses (internal API, needs ZEPHYR_ALLOW_INTERNAL_API=true). Use testPlanKey (or ' +
  'link_test_run_to_plan) to associate the run with a test plan.';

/** Description shared by both run-creating tools' `issueLinks` parameter. */
export const RUN_ISSUE_LINKS_DESCRIBE =
  'NOT SUPPORTED for test runs and rejected locally: the API has no such field on its run DTO, so any value (an empty array ' +
  'included) makes POST /testrun answer HTTP 500 and create nothing. Link them with link_issues_to_test_run (internal API) or ' +
  'on the test cases (create_test_case / update_test_case with issueLinks).';

/** Reject a run-level issueLinks value before any request is made. */
export function refuseIssueLinks(issueLinks: string[] | undefined): void {
  if (issueLinks !== undefined) throw new ToolInputError(RUN_ISSUE_LINKS_UNSUPPORTED);
}

/** POST /testrun answers with the key of the new run only. */
interface CreatedRun {
  key: string;
}

interface StatusTally {
  byStatus: Record<string, number>;
  total: number;
  executed: number;
}

/**
 * Count results by their status name verbatim (statuses are case-sensitive and instances define custom
 * sets, so nothing is normalized). Only the literal 'Not Executed' does not count as executed.
 */
function tallyByStatus(results: Array<Record<string, unknown>>): StatusTally {
  const byStatus: Record<string, number> = {};
  for (const result of results) {
    const status = typeof result.status === 'string' && result.status !== '' ? result.status : '(no status)';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return { byStatus, total: results.length, executed: results.length - (byStatus['Not Executed'] ?? 0) };
}

/** Share of `part` in `whole`, in percent with one decimal. */
const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;

export function registerTestRunTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_run',
    description:
      'Create a test run / test cycle (POST /testrun). Pass the COMPLETE list of test cases in `items` now — ' +
      `${RUN_IMMUTABILITY_NOTE} Each item may also carry its execution result (status, executedBy, executionTime, actual dates, ` +
      'per-step scriptResults, …), which imports a run together with its results in one call; afterwards use the test result tools. ' +
      `A run folder is of type TEST_RUN. ${FOLDER_MUST_EXIST_NOTE} ${RESULT_STATUS_NOTE} ` +
      "The run's own `status` is derived by the server from its item statuses and uses a different vocabulary from the execution " +
      "statuses above ('Not Executed' / 'In Progress' / 'Done'). " +
      'A run CANNOT be linked to Jira issues: issueLinks is rejected locally because the API has no such field on a run — link the ' +
      'issues on the test cases instead. ' +
      'Returns { key } of the new run.',
    inputSchema: {
      projectKey: projectKeySchema,
      name: z.string().min(1).describe('Test run name; it cannot be changed later through the public API'),
      folder: folderPathSchema
        .optional()
        .describe('Full path of an existing TEST_RUN folder from the root starting with "/", e.g. "/Regression"'),
      testPlanKey: testPlanKeySchema.optional().describe('Test plan to associate the run with, e.g. PROJ-P123'),
      issueLinks: z.array(z.string()).optional().describe(RUN_ISSUE_LINKS_DESCRIBE),
      iteration: z.string().optional().describe('Free-text iteration label'),
      version: z.string().optional().describe('Free-text version label'),
      owner: z.string().optional().describe(`Owner. ${USER_KEY_NOTE}`),
      plannedStartDate: z.string().optional().describe('ISO 8601, e.g. 2026-07-20T00:00:00Z (passed through as-is)'),
      plannedEndDate: z.string().optional().describe('ISO 8601 (passed through as-is)'),
      customFields: customFieldsSchema().optional().describe('Custom field values keyed by field name'),
      items: z
        .array(runItemSchema)
        .optional()
        .describe(
          'Test cases to include — the ONLY place where the composition of a run can be set. Each entry requires testCaseKey and ' +
            'may carry the execution result fields of that item (status, environment, executedBy, assignedTo, comment, executionTime, ' +
            'actualStartDate, actualEndDate, customFields, issueLinks, scriptResults).',
        ),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      refuseIssueLinks(args.issueLinks);
      const body = compact({
        projectKey: resolveProjectKey(cfg, args.projectKey),
        name: args.name,
        folder: args.folder,
        testPlanKey: args.testPlanKey,
        iteration: args.iteration,
        version: args.version,
        owner: args.owner,
        plannedStartDate: args.plannedStartDate,
        plannedEndDate: args.plannedEndDate,
        customFields: args.customFields,
        items: args.items?.map((item) => compact(item)),
      });
      const res = (await zephyrFetch(cfg, { method: 'POST', path: atm('/testrun'), body })) as CreatedRun;
      return { key: res.key };
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_run',
    description:
      'Read one test run / test cycle including its items (GET /testrun/{key}). ' +
      `${RUN_IMMUTABILITY_NOTE} ` +
      'Use get_test_run_results for the executions of the run and get_test_run_summary for status counts. ' +
      "items[].id is the id of that item's LATEST EXECUTION, not a stable item identifier: it changes with every new result, and it " +
      "is a different id space from remove_test_cases_from_run's removedItemIds. " +
      'Returns the run object as the API stores it (key, name, status, owner, folder, items, …), or only the requested `fields`.',
    inputSchema: {
      testRunKey: testRunKeySchema,
      fields: fieldsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: runPath(args.testRunKey),
        query: { fields: fieldsParam(args.fields) },
      }),
  });

  defineTool(server, cfg, {
    name: 'search_test_runs',
    description:
      'Search test runs / test cycles with TQL (GET /testrun/search). For runs TQL accepts ONLY the fields projectKey and folder — ' +
      'name, status or dates are NOT searchable, and there is no full-text search; read a candidate run with get_test_run instead. ' +
      'A folder clause matches that folder AND its subfolders: folder = "/A" also returns the runs in /A/B. ' +
      `${TQL_CHEATSHEET}\n${PAGINATION_NOTE}`,
    inputSchema: {
      query: z.string().min(1).describe('TQL query; for test runs only projectKey and folder are searchable, e.g. projectKey = "PROJ"'),
      fields: fieldsSchema,
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const { startAt, maxResults } = pageArgs(args);
      const values = (await zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/testrun/search'),
        query: { query: args.query, fields: fieldsParam(args.fields), startAt, maxResults },
      })) as unknown[];
      return pageEnvelope(startAt, maxResults, values);
    },
  });

  defineTool(server, cfg, {
    name: 'delete_test_run',
    description:
      'Permanently delete a test run / test cycle together with ALL its execution results, its attachments and its test-plan links ' +
      '(DELETE /testrun/{key}). Cannot be undone. ' +
      `${RUN_IMMUTABILITY_NOTE} So delete + create_test_run with the full desired \`items\` is the public way to change a run's ` +
      'name, folder or composition (the new run gets a NEW key). ' +
      'The DELETE itself answers 2xx for a key that never existed, was already deleted or belongs to another entity type (a TEST ' +
      'CASE key was reported deleted while the case stayed intact), so the key is verified FIRST with GET /testrun/{key}: an unknown ' +
      'key fails without deleting anything. ' +
      'Returns { deleted: true, key, existenceVerified: true }, or existenceVerified: false plus a note when that pre-check itself ' +
      'could not answer (the delete is still attempted, so success then does not prove the run existed).',
    inputSchema: {
      testRunKey: testRunKeySchema,
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      // Found live: DELETE /testrun/{key} answers 2xx for NBUL-C999999 (never existed), for an already
      // deleted key and for a TEST CASE key that was still intact afterwards — a bare { deleted: true }
      // would be a claim this tool never checked.
      let existenceVerified = true;
      try {
        await zephyrFetch(cfg, { method: 'GET', path: runPath(args.testRunKey), query: { fields: 'key' } });
      } catch (err) {
        if (err instanceof ZephyrApiError && err.status === 404) {
          throw new ToolInputError(
            `No test run with key '${args.testRunKey}' exists (GET ${runPath(args.testRunKey)} answered 404) — nothing was deleted. ` +
              'Check the key: test case (PROJ-T…) and test plan (PROJ-P…) keys are not run keys, and a run deleted earlier is gone ' +
              'for good.',
          );
        }
        // Any other failure of the check (permissions, a build without the read) must not block the
        // delete — report an unverified deletion instead of refusing to work.
        existenceVerified = false;
      }
      await zephyrFetch(cfg, { method: 'DELETE', path: runPath(args.testRunKey) });
      return compact({
        deleted: true,
        key: args.testRunKey,
        existenceVerified,
        note: existenceVerified
          ? undefined
          : `The pre-delete check GET ${runPath(args.testRunKey)} did not answer, so the DELETE was sent unverified: its 2xx does ` +
            'not prove the run existed. Confirm with get_test_run.',
      });
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_run_results',
    description:
      'Page through the execution results of a test run / test cycle (GET /testrun/{key}/testresults/page). ' +
      'An item can have several executions; onlyLastExecutions=true keeps only the most recent one per item, so it never returns more ' +
      "values than the run has items. Creating a run already seeds one 'Not Executed' execution per item (that execution IS the item's " +
      'last one), so with onlyLastExecutions=false — the default — `total` starts at the item count, not at 0. ' +
      'Older Zephyr Scale builds have no /page endpoint: the deprecated flat GET /testrun/{key}/testresults is then read and ' +
      "paginated client-side, and onlyLastExecutions is resolved from the run object, whose items[] name the id of each item's last " +
      'execution; the `note` in the response says which path produced the values (a run that does not exist still surfaces as a 404). ' +
      'Values come in the order the API returns them, which is neither run-item order nor execution order. ' +
      'Returns { startAt, maxResults, total, count, isLast, values, note? } where total is the size of the set being paged — the number ' +
      'of results on the server, or the post-deduplication count when onlyLastExecutions is true — and isLast is startAt + count >= total.',
    inputSchema: {
      testRunKey: testRunKeySchema,
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
      onlyLastExecutions: z
        .boolean()
        .optional()
        .describe('true returns only the last execution of each run item; omitted means the API default (false — all executions)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const { startAt, maxResults } = pageArgs(args);
      const page = await fetchRunResultsPage(cfg, args.testRunKey, {
        startAt,
        maxResults,
        onlyLastExecutions: args.onlyLastExecutions,
      });
      return compact({
        startAt,
        maxResults,
        total: page.total,
        count: page.values.length,
        isLast: startAt + page.values.length >= page.total,
        note: page.note,
        values: page.values,
      });
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_run_summary',
    description:
      'Aggregated execution summary of a test run / test cycle: composite read-only call of GET /testrun/{key} plus every page of ' +
      'its results (with the flat-endpoint fallback of get_test_run_results). Counts the LAST execution of each item — the run object ' +
      'names them, so latestResults and executed never exceed itemCount — grouping by status name verbatim in `byStatus`; nothing is ' +
      `normalized. ${RESULT_STATUS_NOTE} \`runStatus\` is the status of the RUN itself (e.g. 'In Progress', 'Done'), not an execution ` +
      "status. `executed` counts every counted result whose status is not the literal 'Not Executed'. executionProgressPct = " +
      'executed/itemCount (executed/latestResults when the run exposes no items), so an item with no counted last execution counts as ' +
      'not executed and `note` says how many there are. passRatePct is the share of the literal status ' +
      "'Pass' among `executed` — 0 when nothing passed, and absent only when `executed` is 0. " +
      'Returns { key, name, runStatus, itemCount?, latestResults, executed, executionProgressPct?, byStatus, passRatePct?, note? }.',
    inputSchema: {
      testRunKey: testRunKeySchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const run = (await zephyrFetch(cfg, {
        method: 'GET',
        path: runPath(args.testRunKey),
        query: { fields: 'key,name,status,items' },
      })) as Record<string, unknown>;
      // The run is read first anyway, and it is what identifies the last execution of every item: pass it on
      // so the results half resolves onlyLastExecutions per ITEM instead of guessing from execution fields.
      const { results, truncated, note } = await collectRunResults(cfg, args.testRunKey, true, run);
      const { byStatus, total, executed } = tallyByStatus(results);
      const itemCount = Array.isArray(run.items) ? run.items.length : undefined;
      // Items the results do not account for are unexecuted as far as this call knows, so they belong in the
      // denominator; without an items array the counted results are all there is to measure against.
      const denominator = itemCount !== undefined && itemCount > total ? itemCount : total;
      const uncounted = itemCount !== undefined ? itemCount - total : 0;
      const notes = [
        note,
        uncounted > 0
          ? `${uncounted} of ${itemCount ?? 0} items have no counted last execution; executionProgressPct is computed against ` +
            'itemCount, so they count as not executed.'
          : undefined,
        truncated ? `Aggregation truncated at ${COLLECT_MAX_PAGES * COLLECT_PAGE_SIZE} results.` : undefined,
      ].filter((part): part is string => part !== undefined);

      return compact({
        key: args.testRunKey,
        name: run.name,
        runStatus: run.status,
        itemCount,
        latestResults: total,
        executed,
        executionProgressPct: denominator > 0 ? pct(executed, denominator) : undefined,
        byStatus,
        passRatePct: executed > 0 ? pct(byStatus['Pass'] ?? 0, executed) : undefined,
        note: notes.length > 0 ? notes.join(' ') : undefined,
      });
    },
  });
}
