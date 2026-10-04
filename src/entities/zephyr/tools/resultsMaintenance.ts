import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { zephyrFetch, ZephyrApiError } from '../http.ts';
import {
  CAPTURED_NOTE,
  internal,
  internalCall,
  INTERNAL_NOTE,
  resolveResultStatusId,
  VERIFIED_NOTE,
  withInternalHint,
} from '../internal.ts';
import { projectKeySchema, RESULT_STATUS_NOTE, USER_KEY_NOTE } from '../schemas.ts';
import { compact, defineTool, isEmptyResponse, resolveProjectKey, ToolInputError } from '../toolkit.ts';

/**
 * Editing the execution history of a run — both tools address an execution by its NUMERIC result id
 * and both are backed by the UNOFFICIAL internal API, so the whole file is gated behind
 * ZEPHYR_ALLOW_INTERNAL_API.
 */

/** Public result-field names mapped to the internal field names PUT /testresult expects. */
function internalResultPatch(args: {
  testResultId: number;
  comment?: string | undefined;
  executionTime?: number | undefined;
  executedBy?: string | undefined;
  actualStartDate?: string | undefined;
  actualEndDate?: string | undefined;
}): Record<string, unknown> {
  return compact({
    id: args.testResultId,
    comment: args.comment,
    executionTime: args.executionTime,
    userKey: args.executedBy,
    actualStartDate: args.actualStartDate,
    executionDate: args.actualEndDate,
  });
}

/**
 * True for the documented business-rule rejection of an item's newest execution.
 *
 * Found live: this 400 arrives with the generic internal-API hint attached, which sent readers off
 * debugging their Zephyr version instead of reading the perfectly clear message — so it gets its own
 * clarification.
 */
function isLastResultRejection(err: unknown): boolean {
  return err instanceof ZephyrApiError && err.status === 400 && /lastTestResult/i.test(err.responseBody);
}

const LAST_RESULT_HINT =
  "This particular 400 ('Test execution is the lastTestResult and cannot be deleted') is the documented business rule, NOT a " +
  "version incompatibility: an item's newest execution is protected, and one refused id rejects the WHOLE batch — nothing was " +
  'deleted. Delete only older history entries, or drop the item itself with remove_test_cases_from_run.';

/**
 * Why the tool cannot report a deletion. Found live: the endpoint answers 200 with no per-id report
 * for ids that never existed or were already deleted, and ids are global, so there is no run to read
 * back from either.
 */
const DELETE_RESULTS_UNCONFIRMED_NOTE =
  'POST /testresult/bulk/delete answers 200 with no per-id report even for ids that never existed or were already deleted ' +
  '(verified live), so this call cannot confirm that anything was actually removed — deletionConfirmed is always false. ' +
  "An id the API REFUSES (an item's lastTestResult) rejects the whole batch with a 400 and nothing is deleted; an id it simply " +
  'cannot FIND is ignored silently while the rest of the batch IS deleted. Verify with get_test_run_results.';

/**
 * Bodies that carry no error detail at all: the response was a bare status line. `responseBody` is
 * the trimmed body, or — when there was none — the HTTP reason phrase, or the empty-body marker.
 */
const NO_DETAIL_BODIES = new Set(['', '(empty response body)', 'internal server error']);

/**
 * Replacement error for the empty-bodied 500 of PUT /testresult.
 *
 * Measured live: an id that does not exist (or was deleted) is answered with 500 and an EMPTY body
 * instead of 404, while the same call succeeds for a live id — so the endpoint IS implemented on
 * this build. The generic empty-5xx hint (src/http.ts) can only offer the opposite candidates (an
 * over-long value, an unimplemented operation), which is exactly what this tool's description rules
 * out, so for this one response the hint is REPLACED rather than appended to, and the internal-API
 * trailer is left off as well.
 */
function missingResultIdError(err: unknown, testResultId: number): unknown {
  if (!(err instanceof ZephyrApiError) || err.status !== 500) return undefined;
  if (!NO_DETAIL_BODIES.has(err.responseBody.trim().toLowerCase())) return undefined;
  return new ZephyrApiError(
    err.status,
    err.method,
    err.path,
    err.responseBody,
    `On this build PUT /testresult answers 500 with an empty body when the test execution does not exist — verified live: ` +
      `an existing id is edited successfully, a deleted or invented one produces exactly this response instead of a 404. So ` +
      `testResultId ${testResultId} most likely no longer exists, or is not an execution id at all: it must come from ` +
      `get_test_run_results values[].id or a create_test_result response, NOT a test run, run item or test case id. Neither ` +
      `the payload nor the endpoint is implicated — the same request succeeds for a live id — and retrying it unchanged ` +
      `will fail the same way.`,
    err.htmlBody,
  );
}

/** What the `applied` envelope is, and what it is not — an agent read it as a read-back of the stored execution. */
const APPLIED_NOTE =
  '`applied` is the patch that was SENT: the internal field names and the values put on the wire. The endpoint answers with ' +
  'no body, so this is proof of what was REQUESTED and accepted without an error, not a read-back of what is now stored. ' +
  'Fields absent from it were not touched and keep their previous values, which it does not show either. Read the execution ' +
  'back with get_test_run_results (or get_latest_result_for_test_case) to see the stored values.';

export function registerResultsMaintenanceTools(server: McpServer, cfg: Config): void {
  if (!cfg.allowInternalApi) return;

  defineTool(server, cfg, {
    name: 'delete_test_results',
    description:
      `${INTERNAL_NOTE} Permanently delete individual test executions (results) by their numeric ids ` +
      '(POST /testresult/bulk/delete with a bare JSON array of ids) — the public API v1 cannot delete results at all, they normally ' +
      'die only together with their run. CANNOT BE UNDONE. ' +
      "CONSTRAINT: the LAST execution of a run item cannot be deleted — the API rejects it with 'Test execution is the " +
      "lastTestResult and cannot be deleted', so only older history entries are deletable; to drop an item's whole history remove " +
      'the item itself with remove_test_cases_from_run. That rejection is the expected business rule, not a version problem, and it ' +
      'discards the whole batch: a mixed list is all-or-nothing with respect to REFUSED ids (nothing is deleted), while ids that ' +
      'simply do not exist are ignored and the rest of the batch is deleted. ' +
      'Ids come from get_test_run_results values[].id or a create_test_result response; they are global, so one call may span runs. ' +
      `${CAPTURED_NOTE} ${VERIFIED_NOTE} ` +
      'Returns { requestedIds, deletionConfirmed: false, note } plus apiResponse when the endpoint answers with a body — it does NOT ' +
      'claim a deletion, because the endpoint cannot confirm one per id (see note); read get_test_run_results back to check.',
    inputSchema: {
      testResultIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Numeric test result (execution) ids to delete, e.g. [190318]; NOT test case or run keys'),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      let res: unknown;
      try {
        res = await zephyrFetch(cfg, { method: 'POST', path: internal('/testresult/bulk/delete'), body: args.testResultIds });
      } catch (err) {
        throw withInternalHint(err, isLastResultRejection(err) ? LAST_RESULT_HINT : undefined);
      }
      return compact({
        requestedIds: args.testResultIds,
        deletionConfirmed: false,
        // Whatever the endpoint says is the only evidence available — it used to be discarded.
        apiResponse: isEmptyResponse(res) ? undefined : res,
        note: DELETE_RESULTS_UNCONFIRMED_NOTE,
      });
    },
  });

  defineTool(server, cfg, {
    name: 'update_test_result_by_id',
    description:
      `${INTERNAL_NOTE} Edit ANY test execution (result) by its numeric id, including OLDER history entries ` +
      '(PUT /testresult with a single-element array) — update_last_test_result reaches only the newest execution of an item. ' +
      'Partial update: only the fields passed are changed, and at least one is required. `status` is the case-sensitive status NAME ' +
      'and is resolved to the internal testResultStatusId via GET /rest/api/2/project/{projectKey} + GET /project/{id}/testresultstatus, ' +
      `so projectKey (or ZEPHYR_DEFAULT_PROJECT_KEY) must be available whenever status is passed. ${RESULT_STATUS_NOTE} ` +
      `Ids come from get_test_run_results values[].id or a create_test_result response. ${VERIFIED_NOTE} ` +
      'Everything not passed is preserved on that execution, including its environment and per-step scriptResults. Editing an OLDER ' +
      "execution does not change which execution the run item reports as its last one; editing the item's NEWEST execution does " +
      "update the item's derived status. " +
      'An id that does not exist (or was already deleted) is answered by this build with HTTP 500 and an EMPTY body, not 404, so a ' +
      'bare 500 here most often means the id is gone rather than that the input was too long or the endpoint is missing — the ' +
      'error hint for that response says the same. ' +
      'Returns { testResultId, applied, statusName?, note }. applied is an object of the INTERNAL field names actually SENT mapped ' +
      'to the values sent (executedBy → userKey, actualEndDate → executionDate, status → testResultStatusId as its resolved ' +
      'numeric id; comment, executionTime and actualStartDate keep their names) — the exact patch that went on the wire, with ' +
      'statusName echoing the status NAME behind that numeric id whenever status was passed. It is the REQUEST, not a read-back: ' +
      'the endpoint answers with no body, so applied establishes what was asked for and that it was accepted without an error, ' +
      'and it does NOT show the stored values, the previous values, or the untouched fields (everything not listed is preserved). ' +
      'Read the execution back with get_test_run_results to see what is stored.',
    inputSchema: {
      testResultId: z
        .number()
        .int()
        .positive()
        .describe('Numeric id of the execution to edit — any history entry, not just the last one (from get_test_run_results values[].id)'),
      projectKey: projectKeySchema.describe(
        'Jira project key, e.g. "PROJ" — required when status is passed (it resolves the status name to its internal id); defaults to ZEPHYR_DEFAULT_PROJECT_KEY',
      ),
      status: z.string().optional().describe('Execution status NAME, case-sensitive (list them with get_status_options)'),
      comment: z.string().optional().describe('Comment (HTML allowed)'),
      executionTime: z.number().int().optional().describe('Execution duration in milliseconds'),
      executedBy: z.string().optional().describe(`Executor. ${USER_KEY_NOTE}`),
      actualStartDate: z.string().optional().describe('ISO 8601, e.g. 2026-07-20T14:00:00Z'),
      actualEndDate: z.string().optional().describe('ISO 8601; stored in the internal executionDate field'),
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const patch = internalResultPatch(args);
      // Only `id` in the patch and no status means nothing was actually requested.
      if (Object.keys(patch).length === 1 && args.status === undefined) {
        throw new ToolInputError('Pass at least one field to change (status, comment, executionTime, executedBy, dates).');
      }
      if (args.status !== undefined) {
        // Resolving the status reads two more endpoints; a failure there really can be version drift.
        patch.testResultStatusId = await internalCall(() =>
          resolveResultStatusId(cfg, resolveProjectKey(cfg, args.projectKey), args.status as string),
        );
      }
      try {
        await zephyrFetch(cfg, { method: 'PUT', path: internal('/testresult'), body: [patch] });
      } catch (err) {
        throw missingResultIdError(err, args.testResultId) ?? withInternalHint(err);
      }
      const { id: _id, ...applied } = patch;
      return compact({ testResultId: args.testResultId, applied, statusName: args.status, note: APPLIED_NOTE });
    },
  });
}
