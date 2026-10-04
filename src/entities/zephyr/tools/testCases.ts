import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { addHint, atm, zephyrFetch, ZephyrApiError } from '../http.ts';
import {
  compact,
  defineTool,
  encodePath,
  errorSummary,
  fieldsParam,
  isEmptyResponse,
  pageArgs,
  pageEnvelope,
  resolveProjectKey,
  testCaseWebUrl,
  ToolInputError,
} from '../toolkit.ts';
import {
  fieldsSchema,
  folderPathSchema,
  FOLDER_MUST_EXIST_NOTE,
  issueKeySchema,
  maxResultsSchema,
  newStepSchema,
  PAGINATION_NOTE,
  projectKeySchema,
  startAtSchema,
  stepSchema,
  testCaseFieldsShape,
  testCaseKeySchema,
  testScriptSchema,
  testScriptTypeSchema,
  TQL_CHEATSHEET,
  USER_KEY_NOTE,
} from '../schemas.ts';

/* ─────────────────────────────────────────────────────────────────────────────
 * Endpoint limits and defaults
 * ────────────────────────────────────────────────────────────────────────── */

/** TQL queries longer than this go through POST /testcase/search — long URLs are truncated by proxies. */
const SEARCH_POST_THRESHOLD = 1500;
/** POST /testcase/search accepts at most this many values inside one IN list. */
const MAX_TQL_IN_VALUES = 2500;
/** POST /testcase/link-issues accepts at most this many UNIQUE test case keys per call. */
const MAX_UNIQUE_LINKED_TEST_CASES = 2500;
/** Page size used while collecting keys for a fromFolder move (the API caps a page at 200). */
const SEARCH_MAX_PAGE_SIZE = 200;
/** Safety cap on how many cases one fromFolder move touches. */
const DEFAULT_MOVE_CAP = 200;
/** Safety cap on how many linked cases a coverage report expands (up to 2 requests each). */
const DEFAULT_COVERAGE_CASES = 50;
/**
 * Longest test case name the API accepts. Found live: 255 characters are created, 256 answer HTTP 500
 * with an empty body, so the limit has to be enforced locally to produce an actionable message.
 */
const MAX_TEST_CASE_NAME_LENGTH = 255;
/** Marker clone_test_case appends to the source name when no explicit name is given. */
const COPY_NAME_SUFFIX = ' (copy)';
/**
 * Budget for ONE error inside a composite report (create_test_cases_bulk, move_test_cases_to_folder).
 *
 * Found live: the shared 500-character summary cut every per-item error mid-word and without a marker,
 * and since the actionable HINT is appended LAST it was always the half that disappeared ("…a TEST_RUN
 * folder cannot be used as a test case folder even when " — the remedy sat past character 500). The cap
 * is now spent on the raw API body first, so the hint survives whole, and a cut is always visible.
 */
const PER_ITEM_ERROR_LIMIT = 2000;
/** How much of the raw API response body one per-item error may carry before it is cut. */
const PER_ITEM_BODY_LIMIT = 1000;
/** Same marker the HTTP layer uses for a cut response body, so a truncation always reads the same. */
const TRUNCATION_MARKER = '… [truncated]';
/** Projection used for the per-case lookup of a coverage report. */
const COVERAGE_CASE_FIELDS = ['key', 'name', 'status'];

/* ─────────────────────────────────────────────────────────────────────────────
 * Local shapes for the untyped API payloads
 * ────────────────────────────────────────────────────────────────────────── */

/** A test case (or nested script/step) as the API returns it — extra read-only fields included. */
type ApiObject = Record<string, unknown>;
/** A step reduced to the fields PUT /testcase accepts. */
type WritableStep = ApiObject;

const asObject = (value: unknown): ApiObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ApiObject) : undefined;

/** Inherited text fields: an empty string means "unset" on this API and must not be copied. */
const nonEmptyString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Cut `text` to `limit` characters, marking the cut so a reader can never mistake it for the whole text. */
const withMarkerIfCut = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}${TRUNCATION_MARKER}` : text;

/**
 * One entry of a composite report's failed[]: long enough for the whole message, and cut visibly.
 *
 * For an API error the body is trimmed first and the error is rebuilt from it, so the hint — appended
 * after the body and holding the remedy — is never the part that is lost.
 */
function perItemError(err: unknown): string {
  const trimmed =
    err instanceof ZephyrApiError && err.responseBody.length > PER_ITEM_BODY_LIMIT
      ? new ZephyrApiError(
          err.status,
          err.method,
          err.path,
          withMarkerIfCut(err.responseBody, PER_ITEM_BODY_LIMIT),
          err.hint,
          err.htmlBody,
        )
      : err;
  return withMarkerIfCut(errorSummary(trimmed, PER_ITEM_ERROR_LIMIT + 1), PER_ITEM_ERROR_LIMIT);
}

/**
 * Refuse a name the API cannot store, before any request.
 *
 * Found live on both writers: POST /testcase answers an opaque bodyless HTTP 500 above the limit, while
 * PUT /testcase SILENTLY TRUNCATES to it and still reports success (256 characters sent, 255 stored,
 * { key, url } returned) — a data loss the caller had no way to notice.
 */
function assertNameFits(name: string | undefined, what = 'name'): void {
  if (name === undefined || name.length <= MAX_TEST_CASE_NAME_LENGTH) return;
  throw new ToolInputError(
    `${what} is ${name.length} characters; the API limit is ${MAX_TEST_CASE_NAME_LENGTH}. A longer name fails on creation with ` +
      'an opaque HTTP 500 and is silently truncated on update, so it is rejected here. Pass a shorter name.',
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Shared request helpers
 * ────────────────────────────────────────────────────────────────────────── */

const casePath = (testCaseKey: string): string => atm(encodePath('/testcase', testCaseKey));
const issueLinkPath = (issueKey: string): string => atm(encodePath('/issuelink', issueKey, 'testcases'));

/** GET one test case as an object (a non-object body degrades to {} instead of throwing). */
async function fetchTestCase(cfg: Config, testCaseKey: string, fields?: string[]): Promise<ApiObject> {
  const res = await zephyrFetch(cfg, {
    method: 'GET',
    path: casePath(testCaseKey),
    query: { fields: fieldsParam(fields) },
  });
  return asObject(res) ?? {};
}

/** PUT a PARTIAL test case body: fields absent from `body` keep their current values. */
async function patchTestCase(cfg: Config, testCaseKey: string, body: unknown): Promise<void> {
  await zephyrFetch(cfg, { method: 'PUT', path: casePath(testCaseKey), body });
}

/** POST one test case and shape the standard { key, url } answer. */
async function postTestCase(cfg: Config, body: unknown): Promise<{ key: string; url: string }> {
  const res = (await zephyrFetch(cfg, { method: 'POST', path: atm('/testcase'), body })) as { key: string };
  return { key: res.key, url: testCaseWebUrl(cfg, res.key) };
}

/**
 * A failed POST /testcase/search must say WHY it was a POST at all.
 *
 * Found live: a query above SEARCH_POST_THRESHOLD silently switches transport, and POST /testcase/search is
 * missing or broken on Server builds where GET works — the bare "Zephyr API error 500 (POST …)" left the
 * caller with nothing to act on, because nothing in the call it made mentions POST.
 */
function searchTransportError(err: unknown, queryLength: number): unknown {
  return addHint(
    err,
    `The query is ${queryLength} characters, above ${SEARCH_POST_THRESHOLD}, so it was sent as POST /testcase/search — an endpoint that is ` +
      `missing or broken on some Zephyr Scale Server builds, while GET /testcase/search works. Shorten the query below ` +
      `${SEARCH_POST_THRESHOLD} characters (split a long IN list into several calls and merge the results) to stay on GET.`,
  );
}

/** GET/POST /testcase/search — POST above SEARCH_POST_THRESHOLD, where `fields` travels as an array. */
async function searchTestCases(
  cfg: Config,
  params: { query: string; startAt: number; maxResults: number; fields?: string[] | undefined },
): Promise<unknown[]> {
  const usePost = params.query.length > SEARCH_POST_THRESHOLD;
  let raw: unknown;
  try {
    raw = usePost
      ? await zephyrFetch(cfg, {
          method: 'POST',
          path: atm('/testcase/search'),
          body: compact({ query: params.query, startAt: params.startAt, maxResults: params.maxResults, fields: params.fields }),
        })
      : await zephyrFetch(cfg, {
          method: 'GET',
          path: atm('/testcase/search'),
          query: {
            query: params.query,
            startAt: params.startAt,
            maxResults: params.maxResults,
            fields: fieldsParam(params.fields),
          },
        });
  } catch (err) {
    throw usePost ? searchTransportError(err, params.query.length) : err;
  }
  return Array.isArray(raw) ? raw : [];
}

/** Collect the string `key` values out of any list of test case references (objects or bare keys). */
function testCaseKeysOf(list: unknown): string[] {
  const entries: unknown[] = Array.isArray(list) ? list : [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : asObject(entry)?.key))
    .filter((key): key is string => typeof key === 'string');
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Step synchronization (add_test_steps / clone_test_case)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Reduce a step to the fields PUT /testcase accepts. GET returns extras on every step (index,
 * attachments, customFields, …) that are read-only, so only these five may be echoed back.
 */
function toWritableStep(step: ApiObject): WritableStep {
  return compact({
    id: step.id,
    description: step.description,
    testData: step.testData,
    expectedResult: step.expectedResult,
    testCaseKey: step.testCaseKey,
  });
}

/** The writable projection of the steps currently stored on a test case, in order. */
/**
 * The stored steps of a case, in the order the case really has them.
 *
 * Sorted by the authoritative `index` and NOT by the order the array happens to arrive in: once a case
 * has been edited, GET /testcase serves its steps in an arbitrary order (a real instance answered
 * index 2, 0, 1). Merging in arrival order silently re-sequenced the stored steps — nothing was lost,
 * but the case's step sequence was corrupted. Steps without a numeric index keep their arrival order,
 * after every indexed one.
 */
function existingWritableSteps(script: ApiObject | undefined): WritableStep[] {
  const raw = script?.steps;
  const steps: unknown[] = Array.isArray(raw) ? raw : [];
  return steps
    .map((step, arrivedAt) => {
      const object = asObject(step) ?? {};
      const index = typeof object.index === 'number' && Number.isFinite(object.index) ? object.index : Number.POSITIVE_INFINITY;
      return { object, arrivedAt, index };
    })
    .sort((a, b) => a.index - b.index || a.arrivedAt - b.arrivedAt)
    .map((entry) => toWritableStep(entry.object));
}

/**
 * True when the stored script holds content that overwriting it with a STEP_BY_STEP script would destroy.
 *
 * Found live: a case created WITHOUT a testScript is not script-less — the server attaches an EMPTY stub
 * (`{ id: 1915, type: "PLAIN_TEXT" }`, no text) to every new case. Deciding on `type` alone therefore
 * refused add_test_steps on every freshly created case and made the documented create-then-add-steps
 * workflow unreachable, while threatening the caller with the loss of content that does not exist.
 */
function hasScriptContent(script: ApiObject | undefined): boolean {
  const text = typeof script?.text === 'string' ? script.text : '';
  const steps: unknown[] = Array.isArray(script?.steps) ? script.steps : [];
  return text.length > 0 || steps.length > 0;
}

/**
 * Refuse a "Call to Test" step that points at the case being written.
 *
 * Found live: a step whose testCaseKey is EXACTLY the case being written makes the WHOLE PUT a silent
 * no-op — the API answers 2xx and stores nothing at all, so the unrelated steps of the same write
 * disappear too. Nothing in the response says so, and the cycle is knowable before the request, so it is
 * rejected here.
 *
 * The match is deliberately loose (trimmed, case-insensitive), because a key written "proj-t1" still
 * names the same case for a human — but the discard was only ever MEASURED for an exact self-reference,
 * and this API is case-sensitive about keys elsewhere. A loose match therefore gets its own message that
 * says why it is refused without claiming a stand behaviour nobody observed.
 *
 * `where` names the field the steps came from, so the position points into the caller's own payload
 * ("steps[1]" for add_test_steps/set_test_script, "testScript.steps[1]" for update_test_case).
 */
function assertNoSelfCall(testCaseKey: string, steps: ReadonlyArray<{ testCaseKey?: string | undefined }>, where = 'steps'): void {
  const target = testCaseKey.trim().toUpperCase();
  const at = steps.findIndex((step) => typeof step.testCaseKey === 'string' && step.testCaseKey.trim().toUpperCase() === target);
  if (at < 0) return;
  const written = steps[at]?.testCaseKey;
  const position = `${where}[${at}]`;
  if (written === testCaseKey) {
    throw new ToolInputError(
      `${position} is a "Call to Test" pointing at ${testCaseKey} itself, and a test case cannot call itself. The API accepts such a ` +
        'write with a 2xx and stores NOTHING — the whole request is discarded, including the other steps of the same call — so it is ' +
        'refused here. Point the step at a different test case key, or drop it.',
    );
  }
  throw new ToolInputError(
    `${position} is a "Call to Test" whose key ${JSON.stringify(written)} differs from ${testCaseKey} only in letter case or ` +
      'surrounding whitespace, so it names the case being written, and a test case cannot call itself. An EXACT self-reference was ' +
      'measured on the stand to be accepted with a 2xx and stored NOWHERE, the other steps of the same request included; a key ' +
      'written like this one was not measured, so nothing is claimed about what the API would do with it. Either way the step ' +
      'cannot be a valid call — point it at a different test case key, or drop it.',
  );
}

/** Number of steps a stored script holds (a missing or non-array steps field counts as none). */
function storedStepCount(script: ApiObject | undefined): number {
  return Array.isArray(script?.steps) ? script.steps.length : 0;
}

/** The script stored on a case RIGHT NOW, re-read from the API. Throws whatever the read throws. */
async function readStoredScript(cfg: Config, testCaseKey: string): Promise<ApiObject | undefined> {
  return asObject((await fetchTestCase(cfg, testCaseKey)).testScript);
}

/** Sentence appended to every unverified/mismatching write: the caller has to look, not to trust us. */
const READ_BACK_ADVICE = 'Read the case with get_test_case to see what it really holds before treating the write as done.';

const stepsPhrase = (count: number): string => `${count} step${count === 1 ? '' : 's'}`;

/**
 * What add_test_steps really achieved, read back from the case instead of assumed from the request.
 *
 * Found live: the PUT can be answered 2xx and stored NOWHERE (one "Call to Test" step the server cannot
 * inline voids the whole write), and totalSteps — computed from the array that was SENT — happily
 * reported the higher number. The count now comes from the case itself, and any difference is spelled out.
 */
async function reportStoredSteps(
  cfg: Config,
  testCaseKey: string,
  stepsSent: number,
): Promise<{ totalSteps: number | null; stepsSent?: number; warning?: string }> {
  let script: ApiObject | undefined;
  try {
    script = await readStoredScript(cfg, testCaseKey);
  } catch (err) {
    return {
      totalSteps: null,
      stepsSent,
      warning:
        `The write was accepted, but ${testCaseKey} could not be read back to confirm it (${errorSummary(err, 300)}), so the stored ` +
        `step count is unknown: stepsSent is what was sent, not what is stored. ${READ_BACK_ADVICE}`,
    };
  }
  const totalSteps = storedStepCount(script);
  const storedType = typeof script?.type === 'string' ? script.type : 'no script';
  if (totalSteps === stepsSent && storedType === 'STEP_BY_STEP') return { totalSteps };
  return {
    totalSteps,
    stepsSent,
    warning:
      `The API answered 2xx, but ${testCaseKey} now stores ${stepsPhrase(totalSteps)} in a ${storedType} script while ${stepsSent} were sent: ` +
      'the server discarded part or all of the write. totalSteps above is the count read back from the case, not the count that was ' +
      'sent. A "Call to Test" step the server cannot inline (a missing or unreadable key) voids the whole PUT exactly like this. ' +
      READ_BACK_ADVICE,
  };
}

/**
 * What set_test_script really stored: the script TYPE, plus the step count for STEP_BY_STEP and whether
 * a non-empty text survived for PLAIN_TEXT/BDD. Same live defect as add_test_steps — a 2xx alone does not
 * mean the script changed. Text is compared for presence only, never byte-for-byte: the server is free to
 * normalize the body, and a normalization is not a discarded write.
 */
async function reportStoredScript(
  cfg: Config,
  testCaseKey: string,
  sent: { type: string; text?: string | undefined; steps?: unknown[] | undefined },
): Promise<{ storedType?: string; storedSteps?: number; warning?: string }> {
  let script: ApiObject | undefined;
  try {
    script = await readStoredScript(cfg, testCaseKey);
  } catch (err) {
    return {
      warning:
        `The write was accepted, but ${testCaseKey} could not be read back to confirm it (${errorSummary(err, 300)}), so it is unknown ` +
        `whether the ${sent.type} script is really stored. ${READ_BACK_ADVICE}`,
    };
  }
  const storedType = typeof script?.type === 'string' ? script.type : 'no script';
  const storedSteps = storedStepCount(script);
  const storedText = typeof script?.text === 'string' ? script.text : '';
  if (storedType !== sent.type) {
    return {
      storedType,
      warning:
        `The API answered 2xx, but ${testCaseKey} still stores a ${storedType} script instead of the ${sent.type} one that was sent: ` +
        `the server discarded the write. ${READ_BACK_ADVICE}`,
    };
  }
  if (sent.type === 'STEP_BY_STEP' && storedSteps !== (sent.steps?.length ?? 0)) {
    return {
      storedType,
      storedSteps,
      warning:
        `The API answered 2xx, but ${testCaseKey} stores ${stepsPhrase(storedSteps)} while ${sent.steps?.length ?? 0} were sent: the server ` +
        `discarded part or all of the write. ${READ_BACK_ADVICE}`,
    };
  }
  if (sent.type !== 'STEP_BY_STEP' && (sent.text ?? '') !== '' && storedText === '') {
    return {
      storedType,
      warning:
        `The API answered 2xx, but the ${storedType} script of ${testCaseKey} reads back EMPTY while a text was sent: the server ` +
        `discarded the body. ${READ_BACK_ADVICE}`,
    };
  }
  return {};
}

type StepPosition = 'append' | 'prepend' | number;

/**
 * Insert `added` into `existing` at `position` (numeric indexes are 0-based and clamped to the list
 * length). Existing steps keep their ids on purpose: PUT /testcase synchronizes steps BY ID — a step
 * without an id is created, a step with an id is updated, and any stored step whose id is missing
 * from the list is DELETED. Carrying the ids over is what turns the write into an insert.
 */
function mergeSteps(existing: WritableStep[], added: WritableStep[], position: StepPosition): WritableStep[] {
  const insertAt = position === 'append' ? existing.length : position === 'prepend' ? 0 : Math.min(position, existing.length);
  return [...existing.slice(0, insertAt), ...added, ...existing.slice(insertAt)];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * create_test_cases_bulk fallback
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * True when /testcase/bulk itself is broken rather than the payload: some Server builds answer ANY
 * bulk request with any 5xx (or a bare JSON 404) while single POST /testcase works —
 * observed live. An HTML 404 means the plugin is not reachable at all, and a 4xx with a body is a
 * payload error: neither may be retried item by item.
 */
function bulkEndpointUnavailable(err: unknown): err is ZephyrApiError {
  return err instanceof ZephyrApiError && (err.status >= 500 || (err.status === 404 && !err.htmlBody));
}

interface OneByOneReport {
  created: Array<{ key: string; url: string }>;
  failed: Array<{ index: number; name: unknown; error: string }>;
}

/** Create the prepared bulk items one at a time, keeping the successes even if some items fail. */
async function createTestCasesOneByOne(cfg: Config, items: ApiObject[]): Promise<OneByOneReport> {
  const created: OneByOneReport['created'] = [];
  const failed: OneByOneReport['failed'] = [];
  for (const [index, item] of items.entries()) {
    try {
      created.push(await postTestCase(cfg, item));
    } catch (err) {
      failed.push({ index, name: item.name, error: perItemError(err) });
    }
  }
  return { created, failed };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * move_test_cases_to_folder
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A failing fromFolder search: this module builds that TQL itself, so a "fix your TQL syntax" hint sends
 * the caller after something it cannot change (found live with projectKey = "ZZZZ"). Name what IS checkable.
 */
function fromFolderSearchError(err: unknown): unknown {
  if (err instanceof ZephyrApiError && err.hint !== undefined && /TQL syntax is strict/.test(err.hint)) {
    return addHint(
      err,
      'move_test_cases_to_folder built this query from projectKey and fromFolder, so its syntax is not yours to fix — check that the project exists and that fromFolder is an existing path (case-sensitive, starting with "/", e.g. with get_folder_tree).',
    );
  }
  return err;
}

/**
 * Page through TQL `folder = "<folder>"` collecting keys, stopping at `cap + 1` or the last page.
 *
 * One key MORE than the cap is collected on purpose: it is the only way to tell a real truncation from
 * an exact fit. Found live: the cap note used to fire when the folder held exactly `cap` cases and told
 * the caller to run the tool again when nothing was left to move. The caller slices back down to `cap`.
 */
async function keysInFolder(cfg: Config, projectKey: string, folder: string, cap: number): Promise<string[]> {
  const target = cap + 1;
  const keys: string[] = [];
  for (let startAt = 0; keys.length < target; ) {
    const pageSize = Math.min(SEARCH_MAX_PAGE_SIZE, target - keys.length);
    const page = await searchTestCases(cfg, {
      query: `projectKey = "${projectKey}" AND folder = "${folder}"`,
      startAt,
      maxResults: pageSize,
      fields: ['key'],
    }).catch((err: unknown) => {
      throw fromFolderSearchError(err);
    });
    const pageKeys = testCaseKeysOf(page);
    keys.push(...pageKeys);
    if (pageKeys.length < pageSize) break;
    startAt += pageKeys.length;
  }
  return keys;
}

/** Move each case with a folder-only partial update; a failing case never aborts the others. */
async function moveEachToFolder(
  cfg: Config,
  keys: string[],
  folder: string,
): Promise<{ moved: string[]; failed: Array<{ key: string; error: string }> }> {
  const moved: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const key of keys) {
    try {
      await patchTestCase(cfg, key, { folder });
      moved.push(key);
    } catch (err) {
      failed.push({ key, error: perItemError(err) });
    }
  }
  return { moved, failed };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * clone_test_case
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Copy of a script for a new test case: same type/text, but steps without ids so they are created fresh.
 *
 * The steps are taken through existingWritableSteps, which orders them by their authoritative `index`
 * rather than by the order GET /testcase happens to serve them in — copying the arrival order silently
 * re-sequenced the clone (found live: a source stored as 0,3,1,2 produced a copy whose last step landed
 * in the middle), and the wrong order then travelled into every run built from that clone.
 */
function copyOfScript(rawScript: unknown): ApiObject | undefined {
  const script = asObject(rawScript);
  if (!script || typeof script.type !== 'string') return undefined;
  const steps = Array.isArray(script.steps)
    ? existingWritableSteps(script).map((step) => {
        const { id: _id, ...withoutId } = step;
        return withoutId;
      })
    : undefined;
  return compact({
    type: script.type,
    text: typeof script.text === 'string' ? script.text : undefined,
    steps,
  });
}

interface CloneOverrides {
  testCaseKey: string;
  name?: string | undefined;
  folder?: string | undefined;
  includeScript?: boolean | undefined;
}

/**
 * Name of the copy when the caller passed none: "<source name> (copy)", shortened to fit
 * MAX_TEST_CASE_NAME_LENGTH. Found live: a longer name is rejected with an opaque bodyless HTTP 500, so a
 * source named 249-255 characters used to make a plain clone_test_case call impossible. The "(copy)"
 * marker is always kept — only the copied source name is cut.
 */
function defaultCopyName(sourceName: string): { name: string; fullLength: number } {
  const fullLength = sourceName.length + COPY_NAME_SUFFIX.length;
  const base =
    fullLength <= MAX_TEST_CASE_NAME_LENGTH ? sourceName : cutToWholeCharacters(sourceName, MAX_TEST_CASE_NAME_LENGTH - COPY_NAME_SUFFIX.length);
  return { name: `${base}${COPY_NAME_SUFFIX}`, fullLength };
}

/**
 * Cut to at most `limit` UTF-16 code units WITHOUT splitting an astral character in two.
 *
 * Found live: a name whose 248th code unit was the high surrogate of an emoji was cut in the middle of the
 * pair, and the API stored the lone surrogate — a character no client can retype and that breaks TQL
 * `name = "…"` searches. One character shorter is strictly better than one broken character.
 */
function cutToWholeCharacters(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** POST /testcase body for a copy: writable fields only — read-only metadata is never echoed back. */
function cloneRequestBody(src: ApiObject, args: CloneOverrides, name: string): ApiObject {
  return compact({
    // Older builds omit projectKey from GET /testcase; the key prefix is the project key.
    projectKey: nonEmptyString(src.projectKey) ?? args.testCaseKey.split('-')[0],
    name,
    objective: nonEmptyString(src.objective),
    precondition: nonEmptyString(src.precondition),
    folder: args.folder ?? nonEmptyString(src.folder),
    status: nonEmptyString(src.status),
    priority: nonEmptyString(src.priority),
    component: nonEmptyString(src.component),
    owner: nonEmptyString(src.owner),
    estimatedTime: typeof src.estimatedTime === 'number' ? src.estimatedTime : undefined,
    labels: Array.isArray(src.labels) ? src.labels : undefined,
    customFields: asObject(src.customFields),
    parameters: asObject(src.parameters),
    testScript: (args.includeScript ?? true) ? copyOfScript(src.testScript) : undefined,
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * get_issue_test_coverage
 * ────────────────────────────────────────────────────────────────────────── */

/** Latest execution of a case, reduced to the fields a traceability report needs. */
function lastResultSummary(latest: ApiObject): ApiObject {
  return compact({
    status: latest.status,
    environment: latest.environment,
    // Older builds fill only the deprecated executionDate; actualEndDate is its replacement.
    actualEndDate: latest.actualEndDate ?? latest.executionDate,
    executedBy: latest.executedBy ?? undefined,
    comment: latest.comment ?? undefined,
  });
}

/**
 * One row of a coverage report. Deliberately fault-tolerant: a case the caller cannot read (deleted,
 * no permission) still appears with its key, and a case whose latest execution cannot be resolved
 * reports lastResult null.
 *
 * With includeLastResult false the lastResult key is OMITTED instead of nulled: reporting null there made
 * an executed case indistinguishable from a never-executed one (found live — Pass/Fail cases came back
 * as null exactly like an untested one).
 */
async function coverageRow(cfg: Config, testCaseKey: string, includeLastResult: boolean): Promise<ApiObject> {
  const info = await fetchTestCase(cfg, testCaseKey, COVERAGE_CASE_FIELDS).catch(() => ({}) as ApiObject);
  if (!includeLastResult) return compact({ key: testCaseKey, name: info.name, status: info.status });
  const latest = asObject(
    await zephyrFetch(cfg, {
      method: 'GET',
      path: atm(encodePath('/testcase', testCaseKey, 'testresult', 'latest')),
    }).catch(() => null),
  );
  return { key: testCaseKey, name: info.name, status: info.status, lastResult: latest ? lastResultSummary(latest) : null };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Tool-specific input schemas
 * ────────────────────────────────────────────────────────────────────────── */

/** Every create field made optional for partial updates (name included; projectKey cannot change). */
const updatableTestCaseFieldsShape = {
  ...testCaseFieldsShape,
  name: testCaseFieldsShape.name.optional(),
};

const bulkTestCaseSchema = z
  .object({
    // A fresh instance rather than the shared projectKeySchema: the same zod object used twice in one
    // tool schema is emitted as a `$ref`, which strict MCP clients reject (test/mcpSchemas.test.ts).
    projectKey: z
      .string()
      .optional()
      .describe('Jira project key for this item, e.g. "PROJ"; falls back to the shared projectKey, then ZEPHYR_DEFAULT_PROJECT_KEY'),
    ...testCaseFieldsShape,
  })
  .strict();

const issueLinkPairSchema = z
  .object({
    testCaseKey: testCaseKeySchema,
    issueKey: issueKeySchema,
  })
  .strict();

export function registerTestCaseTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_case',
    description:
      `Create a test case (POST /testcase). ${FOLDER_MUST_EXIST_NOTE} status, priority, component and custom field names must match ` +
      'the ones configured on the instance and are case-sensitive: an unknown or wrong-case value is rejected with 400 and nothing ' +
      `is created (unlike EXECUTION statuses, which the API silently ignores). owner: ${USER_KEY_NOTE} estimatedTime is in ` +
      `milliseconds. name is limited to ${MAX_TEST_CASE_NAME_LENGTH} characters — a longer one is refused locally, because the API ` +
      'answers it with an opaque bodyless HTTP 500. testScript is STEP_BY_STEP with steps, or PLAIN_TEXT/BDD with text; a step ' +
      'carrying testCaseKey is a "Call to Test" that inlines another case. BDD text is stored verbatim and must contain Gherkin step ' +
      'lines only — a "Feature:"/"Scenario:" header is rejected with 400 "Invalid BDD Script". Omitting testScript does NOT leave the ' +
      'case script-less: the server attaches an empty PLAIN_TEXT script, which add_test_steps treats as "no script yet". Returns ' +
      '{ key, url }.',
    inputSchema: {
      projectKey: projectKeySchema,
      ...testCaseFieldsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const { projectKey, ...fields } = args;
      assertNameFits(fields.name);
      return postTestCase(cfg, compact({ projectKey: resolveProjectKey(cfg, projectKey), ...fields }));
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_case',
    description:
      'Read one test case (GET /testcase/{testCaseKey}). A STEP_BY_STEP script comes back with a numeric id on every step; those ' +
      'ids are what update_test_case and set_test_script match on, so read them before editing steps by hand (add_test_steps does ' +
      'it for you). Returns the test case object as the API sends it, restricted to fields when given.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      fields: fieldsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: casePath(args.testCaseKey),
        query: { fields: fieldsParam(args.fields) },
      }),
  });

  defineTool(server, cfg, {
    name: 'search_test_cases',
    description: `Search test cases with a TQL query (GET /testcase/search). A query longer than ${SEARCH_POST_THRESHOLD} characters is sent as POST /testcase/search instead, which supports ONLY the fields projectKey, key and name and at most ${MAX_TQL_IN_VALUES} values per IN list. That POST endpoint is missing or broken on some Zephyr Scale Server builds, so prefer staying under ${SEARCH_POST_THRESHOLD} characters (split a long IN list across calls); when a POST search fails the error says which transport was used and why.

Unknown VALUES are validated inconsistently: an unknown status, priority, component or projectKey is rejected with 400, while an unknown label in an IN list and an unknown key inside key IN (…) are silently skipped and just shrink the result set — a typo there is indistinguishable from no match. isLast is a heuristic, so an exactly full page always reports isLast false even when it is the last one: stop when values is empty.

${TQL_CHEATSHEET}

${PAGINATION_NOTE}`,
    inputSchema: {
      query: z.string().min(1).describe('TQL query, e.g. projectKey = "PROJ" AND status = "Draft" (see the description for the syntax)'),
      fields: fieldsSchema,
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const { startAt, maxResults } = pageArgs(args);
      const values = await searchTestCases(cfg, { query: args.query, startAt, maxResults, fields: args.fields });
      return pageEnvelope(startAt, maxResults, values);
    },
  });

  defineTool(server, cfg, {
    name: 'update_test_case',
    description:
      'Update a test case (PUT /testcase/{testCaseKey}). PARTIAL: only the fields passed are changed and omitted fields keep their ' +
      'values, so never send empty placeholders. projectKey cannot be changed. issueLinks REPLACES the whole link set instead of ' +
      'adding to it — sending issueLinks: ["PROJ-1"] to a case already linked to PROJ-2 silently unlinks PROJ-2, so read the current ' +
      'links with get_test_case and send the complete final list (link_issues_to_test_cases is the additive alternative). ' +
      'testScript.steps is synchronized BY ID — a step without an id is created, a step with an id is updated, and every stored step ' +
      'whose id is missing from the list is DELETED; always send the complete final list, carrying over the ids from get_test_case. ' +
      `To only add steps use add_test_steps, which does that read-merge-write safely. A name longer than ` +
      `${MAX_TEST_CASE_NAME_LENGTH} characters is refused locally: the API stores the first ${MAX_TEST_CASE_NAME_LENGTH} characters ` +
      `and still reports success. A step whose "Call to Test" points at its own case is refused locally too: the API answers 2xx to ` +
      'such a write and stores NOTHING, throwing away the other steps of the same request with it. When (and only when) testScript ' +
      'is passed, the tool reads the case back afterwards (one extra GET) and compares the STORED script with the one sent — its ' +
      'type, the step count for STEP_BY_STEP, and that a non-empty text survived for PLAIN_TEXT/BDD (the text itself is not compared ' +
      'byte-for-byte); an update without testScript costs no extra request. ' +
      `${FOLDER_MUST_EXIST_NOTE} Returns { key, url }; when the stand accepted the write and kept the old script, the answer also ` +
      'carries storedType, storedSteps and a warning saying what is really stored, and a warning alone when the read-back itself ' +
      'failed. Only the script is verified: the other fields of a partial update are not read back.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      ...updatableTestCaseFieldsShape,
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const { testCaseKey, ...fields } = args;
      assertNameFits(fields.name);
      const script = fields.testScript;
      // This tool writes a testScript too, so it needs the same two guarantees as add_test_steps and
      // set_test_script: no self-referencing "Call to Test" (the stand silently voids the whole write),
      // and the stored script read back instead of the 2xx believed.
      if (script !== undefined) assertNoSelfCall(testCaseKey, script.steps ?? [], 'testScript.steps');
      await patchTestCase(cfg, testCaseKey, compact(fields));
      const answer = { key: testCaseKey, url: testCaseWebUrl(cfg, testCaseKey) };
      if (script === undefined) return answer;
      return { ...answer, ...(await reportStoredScript(cfg, testCaseKey, { type: script.type, text: script.text, steps: script.steps })) };
    },
  });

  defineTool(server, cfg, {
    name: 'add_test_steps',
    description:
      'Insert steps into a STEP_BY_STEP script without losing the existing ones (GET then PUT /testcase/{testCaseKey}): reads the ' +
      'current steps, keeps their ids, splices the new ones in and writes the whole list back — needed because PUT deletes every ' +
      'step missing from the list it receives. The stored steps are ordered by their authoritative `index` before merging, because ' +
      'GET /testcase serves them in an arbitrary array order once a case has been edited; only the insertion changes, existing step ' +
      'ids and their sequence are preserved. position selects the insertion point: "append" (the default), "prepend", or a 0-based ' +
      'index into that ordered sequence, clamped to the step count. Allowed when the current script is STEP_BY_STEP, and when the ' +
      'case has no script CONTENT yet — a case created without a testScript is reported by the API as an empty PLAIN_TEXT script ' +
      '(a stub with no text), and that counts as script-less: a STEP_BY_STEP script is then created. A PLAIN_TEXT or BDD script ' +
      'that really has text is refused; replace it with set_test_script. A step whose "Call to Test" points at its own case is ' +
      'refused too: the API answers 2xx to such a write and stores NOTHING. After the write the tool reads the case back (a second ' +
      'GET) and returns { key, totalSteps } where totalSteps is the count STORED on the case, not the count sent. When the two ' +
      'differ — the stand accepts a write and silently throws it away — the answer also carries stepsSent and a warning saying so; ' +
      'totalSteps is null with a warning when the read-back itself failed.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      steps: z
        .array(newStepSchema)
        .min(1)
        .describe('New steps in insertion order, without ids (ids belong to already stored steps). A step with testCaseKey is a "Call to Test".'),
      position: z
        .union([
          z.literal('append'),
          z.literal('prepend'),
          z.number().int().min(0),
          // Some MCP clients serialize a number inside a union as a string ("1"), which used to make
          // every numeric insertion fail; accept the digits form and coerce it.
          z
            .string()
            .regex(/^\d+$/, "position must be 'append', 'prepend' or a 0-based index")
            .transform(Number),
        ])
        .optional()
        .describe(
          "Where to insert: 'append' (default), 'prepend', or a 0-based index into the existing steps, clamped to the current step " +
            'count. A numeric index may be given as a number or as digits in a string ("2") — both mean the same position.',
        ),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      assertNoSelfCall(args.testCaseKey, args.steps);
      const existing = await fetchTestCase(cfg, args.testCaseKey);
      const script = asObject(existing.testScript);
      // An EMPTY script of another type is the stub every new case carries here: it holds nothing to lose,
      // so it is overwritten with the STEP_BY_STEP script the caller asked for.
      if (script && script.type !== 'STEP_BY_STEP' && hasScriptContent(script)) {
        throw new ToolInputError(
          `Test case ${args.testCaseKey} has a ${String(script.type)} script — add_test_steps only works with STEP_BY_STEP scripts. ` +
            `Use set_test_script to replace the script (this irreversibly deletes the current ${String(script.type)} content).`,
        );
      }
      const merged = mergeSteps(
        existingWritableSteps(script),
        args.steps.map((step) => compact(step)),
        args.position ?? 'append',
      );
      await patchTestCase(cfg, args.testCaseKey, { testScript: { type: 'STEP_BY_STEP', steps: merged } });
      // The count is READ BACK, never taken from the array that was sent: a 2xx here does not mean stored.
      return { key: args.testCaseKey, ...(await reportStoredSteps(cfg, args.testCaseKey, merged.length)) };
    },
  });

  defineTool(server, cfg, {
    name: 'set_test_script',
    description:
      "Replace a test case's whole script or change its format (PUT /testcase/{testCaseKey} with a full testScript). DESTRUCTIVE: " +
      'switching STEP_BY_STEP to PLAIN_TEXT or BDD irreversibly deletes all steps, and a STEP_BY_STEP replacement deletes every ' +
      'stored step whose id is absent from steps. text is required for PLAIN_TEXT and BDD, steps for STEP_BY_STEP — the pairing is ' +
      'validated locally, before any request — but steps: [] passes that check and DELETES every stored step, leaving an empty ' +
      'STEP_BY_STEP script. BDD text is stored verbatim and must contain Gherkin step lines only, no "Feature:"/"Scenario:" header ' +
      '(400 "Invalid BDD Script"). A step whose "Call to Test" points at its own case is refused locally: the API answers 2xx to ' +
      'such a write and stores NOTHING. After the write the tool reads the case back (a second GET) and compares the STORED script ' +
      'with the one sent — its type, the step count for STEP_BY_STEP, and that a non-empty text survived for PLAIN_TEXT/BDD (the ' +
      'text itself is not compared byte-for-byte). Returns { key, url }; when the stand accepted the write and kept the old script, ' +
      'the answer also carries storedType, storedSteps and a warning saying what is really stored, and a warning alone when the ' +
      'read-back itself failed.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
      type: testScriptTypeSchema.describe('New script format: STEP_BY_STEP, PLAIN_TEXT or BDD'),
      text: z
        .string()
        .optional()
        .describe('Script body — required for PLAIN_TEXT and BDD (Gherkin step lines only), rejected for STEP_BY_STEP'),
      steps: z
        .array(stepSchema)
        .optional()
        .describe(
          'Complete final list of steps — required for STEP_BY_STEP, rejected otherwise. Steps omitted here are deleted; keep the ids from get_test_case to update steps in place.',
        ),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (args, { cfg }) => {
      const testScript = testScriptSchema.parse(compact({ type: args.type, text: args.text, steps: args.steps }));
      assertNoSelfCall(args.testCaseKey, args.steps ?? []);
      await patchTestCase(cfg, args.testCaseKey, { testScript });
      // Same live defect as add_test_steps: a 2xx is not proof the script changed, so it is read back.
      return {
        key: args.testCaseKey,
        url: testCaseWebUrl(cfg, args.testCaseKey),
        ...(await reportStoredScript(cfg, args.testCaseKey, { type: args.type, text: args.text, steps: args.steps })),
      };
    },
  });

  defineTool(server, cfg, {
    name: 'delete_test_case',
    description:
      'Permanently delete a test case (DELETE /testcase/{testCaseKey}). Irreversible: the case, its script and its execution ' +
      'history cannot be restored through the API. Inbound references are NOT checked: a case that other cases invoke as a ' +
      '"Call to Test" step is deleted anyway and those steps keep pointing at a key that no longer resolves. Returns ' +
      '{ deleted: true, key }.',
    inputSchema: {
      testCaseKey: testCaseKeySchema,
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, { method: 'DELETE', path: casePath(args.testCaseKey) });
      return { deleted: true, key: args.testCaseKey };
    },
  });

  defineTool(server, cfg, {
    name: 'create_test_cases_bulk',
    description:
      'Create several test cases in one request (POST /testcase/bulk). Each item takes the same fields as create_test_case; an item ' +
      `without its own projectKey uses the shared projectKey, then ZEPHYR_DEFAULT_PROJECT_KEY. ${FOLDER_MUST_EXIST_NOTE} ` +
      'Some Server builds ship a broken bulk endpoint (any 5xx, or a JSON 404 — as opposed to the plugin-not-installed HTML 404) while single creation works: ' +
      'the tool then falls back to POST /testcase per item so partial progress survives — on such a build the fallback runs on every ' +
      'call and the bulk shape is never returned. A 4xx from the bulk endpoint is a payload error and is NOT retried. Returns ' +
      '[{ key, url }] on the bulk path, or { note, created: [{ key, url }], failed?: [{ index, name, error }] } when the fallback ran ' +
      '— also when SOME items failed, so always read failed[]. created[] is in input order but carries no index, and failed[] is ' +
      'omitted entirely when every item succeeded; index is the position in the testCases array. When EVERY item fails nothing was ' +
      'created and the call FAILS, with one line per item naming its index, its name and its error, so the payload can be fixed in ' +
      `one pass. A name longer than ${MAX_TEST_CASE_NAME_LENGTH} characters is rejected locally, naming the item.`,
    inputSchema: {
      projectKey: projectKeySchema.describe(
        'Shared Jira project key for items without their own, e.g. "PROJ"; defaults to ZEPHYR_DEFAULT_PROJECT_KEY',
      ),
      testCases: z.array(bulkTestCaseSchema).min(1).describe('Test cases to create, each shaped like create_test_case input'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const items: ApiObject[] = args.testCases.map((item, index) => {
        const { projectKey, ...fields } = item;
        assertNameFits(fields.name, `testCases[${index}].name`);
        return compact({ projectKey: resolveProjectKey(cfg, projectKey ?? args.projectKey), ...fields });
      });

      let raw: unknown;
      try {
        raw = await zephyrFetch(cfg, { method: 'POST', path: atm('/testcase/bulk'), body: items });
      } catch (err) {
        if (!bulkEndpointUnavailable(err)) throw err;
        const bulkFailure = `POST /testcase/bulk failed (HTTP ${err.status}) — the bulk endpoint may be unavailable on this Zephyr Scale Server version`;
        const { created, failed } = await createTestCasesOneByOne(cfg, items);
        if (created.length === 0) {
          // Nothing was created, so this is a failure — but it must carry EVERY per-item error, not just
          // the first one, which is what the caller needs in order to fix its payload.
          const details = failed.map((entry) => `  [${entry.index}] ${String(entry.name)}: ${entry.error}`).join('\n');
          throw new Error(
            `${bulkFailure}, and the one-by-one fallback via POST /testcase also failed for all ${items.length} test case` +
              `${items.length === 1 ? '' : 's'}. Nothing was created. Per-item errors:\n${details}`,
          );
        }
        return compact({
          note: `${bulkFailure}. Fell back to creating the test cases one by one: ${created.length}/${items.length} created.`,
          created,
          failed: failed.length > 0 ? failed : undefined,
        });
      }

      // The bulk endpoint answers with either [{ key, … }] or bare key strings, depending on the build.
      return (Array.isArray(raw) ? raw : [raw]).map((entry) => {
        const key = typeof entry === 'string' ? entry : asObject(entry)?.key;
        return typeof key === 'string' ? { key, url: testCaseWebUrl(cfg, key) } : entry;
      });
    },
  });

  defineTool(server, cfg, {
    name: 'link_issues_to_test_cases',
    description:
      'Link Jira issues to test cases in bulk (POST /testcase/link-issues). One entry links one test case to one issue; repeat a ' +
      `testCaseKey across entries to link it to several issues. At most ${MAX_UNIQUE_LINKED_TEST_CASES} UNIQUE test case keys per ` +
      'call — checked locally, before any request. Additive: it only creates links, never removes existing ones. KNOWN ISSUE: on ' +
      'many Server/DC builds this endpoint answers HTTP 500 with an empty body even for a single valid pair (verified live on such ' +
      "a stand); link through update_test_case (or create_test_case) with the issueLinks field instead — that field REPLACES the " +
      'case\'s whole link set, so send the complete final list. Returns the API payload, or { linked: <number of entries> } when the ' +
      'API answers with an empty body (the usual case).',
    inputSchema: {
      links: z.array(issueLinkPairSchema).min(1).describe('Pairs of { testCaseKey, issueKey }, e.g. [{ testCaseKey: "PROJ-T1", issueKey: "PROJ-123" }]'),
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const uniqueKeys = new Set(args.links.map((link) => link.testCaseKey));
      if (uniqueKeys.size > MAX_UNIQUE_LINKED_TEST_CASES) {
        throw new ToolInputError(
          `The API accepts at most ${MAX_UNIQUE_LINKED_TEST_CASES} unique test case keys per call, got ${uniqueKeys.size}. Split the links into smaller batches.`,
        );
      }
      const raw = await zephyrFetch(cfg, { method: 'POST', path: atm('/testcase/link-issues'), body: args.links });
      const noPayload = isEmptyResponse(raw);
      return noPayload ? { linked: args.links.length } : raw;
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_cases_linked_to_issue',
    description:
      'List the test cases linked to a Jira issue (GET /issuelink/{issueKey}/testcases) — traceability from a requirement or bug to ' +
      'its tests. Create such links with link_issues_to_test_cases, or with the issueLinks field of create_test_case. Use ' +
      'get_issue_test_coverage instead to also see the latest execution of each case. Returns the API array of test case objects, one ' +
      'entry per LINK: a case linked to the issue twice appears twice, and the order is not stable between calls — de-duplicate by key ' +
      'before counting. Entries carry the API fields, including lastTestResultStatus — a DENORMALIZED value that is absent while the ' +
      'case has never been executed and is reset to "Not Executed" (not cleared) when the test run holding its executions is deleted, ' +
      'so it can read "Not Executed" for a case that really ran Pass. get_issue_test_coverage resolves the execution live and reports ' +
      'lastResult null in that situation; prefer it when the distinction matters.',
    inputSchema: {
      issueKey: issueKeySchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => zephyrFetch(cfg, { method: 'GET', path: issueLinkPath(args.issueKey) }),
  });

  defineTool(server, cfg, {
    name: 'move_test_cases_to_folder',
    description:
      'Move test cases into another folder — one partial PUT /testcase/{key} per case that changes only the folder field. Select the ' +
      'cases with EITHER testCaseKeys OR fromFolder (resolved by GET /testcase/search on folder = "<fromFolder>"): exactly one of ' +
      `the two, checked before any request. fromFolder matches that folder EXACTLY — cases in its subfolders are not included, and an ` +
      `existing but empty fromFolder moves nothing. ${FOLDER_MUST_EXIST_NOTE} The TARGET folder is NOT checked before the requests: a ` +
      'path that does not exist still issues one PUT per case, every one of them fails with 400 and the call resolves with ' +
      'movedCount 0 — always read failed[], since the returned folder only echoes what was asked for. Folder paths are case-sensitive ' +
      'and the root "/" is not a valid target (400 "The value / was not found for field folder"), so a case cannot be moved out of ' +
      'all folders here. Duplicate testCaseKeys are de-duplicated: each case is moved once and movedCount counts distinct cases. ' +
      'maxCases caps both selection modes. A failing case does not abort the rest — it is reported in failed. Only the folder field ' +
      'is written (script, step ids, version, labels, status, priority, owner, objective and precondition are preserved) and moving ' +
      'is reversible (move them back the same way). De-duplication is by EXACT string: keys are neither trimmed nor upper-cased, so ' +
      '"PROJ-T1" and "proj-t1" are two candidates and the second one simply fails with 404 on this case-sensitive API. movedCount ' +
      'counts successful writes, so a case already sitting in the target folder counts as moved. maxCases is applied AFTER the ' +
      'duplicates are removed, and note appears only when something needs explaining (cap truncation, ignored duplicates) — a clean ' +
      'full move and an empty fromFolder both return no note. A fromFolder path that does not exist is different from an empty one: ' +
      'the underlying search fails with 400 "Value(s) not found for field folder". Each failed[] entry is { key, error }. Returns ' +
      '{ folder, movedCount, moved, failed?, note? }.',
    inputSchema: {
      folder: folderPathSchema.describe(
        'Target folder: full path from the root starting with "/", e.g. "/Regression/Payments"; it must already exist and "/" itself is rejected by the API',
      ),
      testCaseKeys: z
        .array(testCaseKeySchema)
        .min(1)
        .optional()
        .describe('Explicit list of test case keys to move, e.g. ["PROJ-T1", "PROJ-T2"]; duplicates are ignored'),
      fromFolder: folderPathSchema
        .optional()
        .describe('Move every case whose folder is EXACTLY this path (starting with "/"); subfolders are not included'),
      projectKey: projectKeySchema.describe(
        'Jira project key for the fromFolder search, e.g. "PROJ"; defaults to ZEPHYR_DEFAULT_PROJECT_KEY. Ignored with testCaseKeys, where each key carries its own project',
      ),
      maxCases: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          'Safety cap on how many cases one call moves, applied in BOTH modes: the fromFolder search stops there and a longer ' +
            `testCaseKeys list is truncated to its first distinct keys (default ${DEFAULT_MOVE_CAP}, integer >= 1)`,
        ),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      if ((args.testCaseKeys === undefined) === (args.fromFolder === undefined)) {
        throw new ToolInputError('Pass exactly ONE of testCaseKeys or fromFolder.');
      }
      const cap = args.maxCases ?? DEFAULT_MOVE_CAP;
      const notes: string[] = [];

      // Exactly one selector is set (checked above), so the explicit list wins whenever fromFolder is absent.
      const given =
        args.fromFolder === undefined
          ? (args.testCaseKeys ?? [])
          : await keysInFolder(cfg, resolveProjectKey(cfg, args.projectKey), args.fromFolder, cap);
      // The same key twice used to mean two PUTs and movedCount 2 for one relocated case (found live).
      const candidates = [...new Set(given)];
      const duplicates = given.length - candidates.length;
      if (duplicates > 0) {
        notes.push(`Ignored ${duplicates} duplicate key(s): movedCount counts distinct test cases.`);
      }

      const keys = candidates.slice(0, cap);
      const skipped = candidates.length - keys.length;
      if (skipped > 0) {
        notes.push(
          args.fromFolder === undefined
            ? `Stopped at the maxCases cap (${cap}): only the first ${cap} of ${candidates.length} distinct keys were moved — re-run with the remaining ones.`
            : `Stopped at the maxCases cap (${cap}): more cases match fromFolder — run the tool again to move the rest.`,
        );
      }

      const { moved, failed } = await moveEachToFolder(cfg, keys, args.folder);
      return compact({
        folder: args.folder,
        movedCount: moved.length,
        moved,
        failed: failed.length > 0 ? failed : undefined,
        note: notes.length > 0 ? notes.join(' ') : undefined,
      });
    },
  });

  defineTool(server, cfg, {
    name: 'clone_test_case',
    description:
      'Copy a test case inside its own project (GET /testcase/{testCaseKey}, then POST /testcase). Copies name, objective, ' +
      'precondition, folder, status, priority, component, owner, estimatedTime, labels, custom fields, parameters and — unless ' +
      'includeScript is false — the script; step ids are dropped so the copy owns its steps. Issue links, attachments and execution ' +
      `history are NOT copied. name defaults to "<source name> (copy)" and folder to the source folder. ${FOLDER_MUST_EXIST_NOTE} ` +
      `A test case name is limited to ${MAX_TEST_CASE_NAME_LENGTH} CHARACTERS, not bytes (the API rejects a longer one with an opaque ` +
      'HTTP 500): an explicit longer name is refused locally before any request, and the default name is shortened to fit — the copied ' +
      'source name is cut on a whole-character boundary (an astral character is dropped rather than split), the " (copy)" marker is ' +
      'kept, and note reports both lengths. An explicitly empty name ("") is sent as-is and rejected with 400 "The ' +
      'field name is required." — omit the parameter to get the default. Names are not deduplicated: cloning twice gives two cases ' +
      'with the same name, and cloning a copy gives "… (copy) (copy)" — unless the source name is already at the limit, where the ' +
      'shortening cuts exactly the previous " (copy)" off and the copy ends up named identically to its source (note says so; pass an ' +
      'explicit name to tell them apart). With includeScript=false the copy has no steps, but the API ' +
      'still reports an empty PLAIN_TEXT testScript — that is what every script-less case looks like here. Returns ' +
      '{ key, url, sourceKey, note? }.',
    inputSchema: {
      testCaseKey: testCaseKeySchema.describe('Key of the SOURCE test case, e.g. PROJ-T123'),
      name: z
        .string()
        .optional()
        .describe(`Name of the copy, at most ${MAX_TEST_CASE_NAME_LENGTH} characters (defaults to "<source name> (copy)", shortened to fit)`),
      folder: folderPathSchema.describe('Folder path for the copy, full path from the root starting with "/" (defaults to the source folder)').optional(),
      includeScript: z.boolean().optional().describe('Copy the test script too (default true)'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      assertNameFits(args.name);
      const src = await fetchTestCase(cfg, args.testCaseKey);
      const sourceName = nonEmptyString(src.name) ?? args.testCaseKey;
      const derived = defaultCopyName(sourceName);
      const shortened = args.name === undefined && derived.fullLength > MAX_TEST_CASE_NAME_LENGTH;
      const created = await postTestCase(cfg, cloneRequestBody(src, args, args.name ?? derived.name));
      return compact({
        ...created,
        sourceKey: args.testCaseKey,
        note: shortened
          ? `The default copy name would have been ${derived.fullLength} characters; it was shortened to ${derived.name.length} to fit the ` +
            `${MAX_TEST_CASE_NAME_LENGTH}-character limit, keeping the " (copy)" marker.` +
            (derived.name === sourceName
              ? ' The result is IDENTICAL to the source name, because the cut removed exactly the source\'s own " (copy)" suffix — pass an explicit name to tell the two apart.'
              : ' Pass an explicit name to control it.')
          : undefined,
      });
    },
  });

  defineTool(server, cfg, {
    name: 'get_issue_test_coverage',
    description:
      'Traceability report for a Jira issue: every linked test case with its latest execution (GET /issuelink/{issueKey}/testcases, ' +
      'then GET /testcase/{key} and GET /testcase/{key}/testresult/latest per case). Costs up to 2 requests per case, so maxCases ' +
      `(integer 1..200, default ${DEFAULT_COVERAGE_CASES}) caps the volume. totalLinked counts LINKS — the API returns one entry per ` +
      'link, so a case linked to the issue twice is counted twice — while cases[] holds one row per DISTINCT case, expanded once. ' +
      'The order the API supplies is not stable between calls, so which cases survive the maxCases cut may vary; the cap is applied ' +
      'AFTER duplicate links are collapsed, so it counts DISTINCT cases. lastResult is ' +
      '{ status, environment?, actualEndDate?, executedBy?, comment? } with the absent keys OMITTED, and it carries no execution ' +
      'id/key (use get_latest_result_for_test_case when you need the id). It is the most recently CREATED execution, not the one ' +
      'with the greatest actualEndDate, so a back-dated execution still wins and the date shown may be older than that of a ' +
      'suppressed one. lastResult null means no latest execution could be resolved — never executed, or its test run was deleted — ' +
      'not "untested" by itself; with includeLastResults=false (it defaults to true) the key is absent entirely. Fault-tolerant: a ' +
      'case that cannot be read still appears with its key. An issue with no linked cases returns totalLinked 0 and an empty ' +
      'cases[]; an issue key that does not exist raises 404 (Jira resolves issue keys case-insensitively, and issueKey is echoed ' +
      'back exactly as passed). note is present only when something was truncated or collapsed. Returns ' +
      '{ issueKey, totalLinked, returned, note?, cases: [{ key, name, status, lastResult? }] }.',
    inputSchema: {
      issueKey: issueKeySchema,
      includeLastResults: z
        .boolean()
        .optional()
        .describe('Fetch the latest execution of each case (default true); false skips those reads and omits lastResult from every row'),
      maxCases: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(`Maximum number of DISTINCT linked cases to expand, integer 1..200 (default ${DEFAULT_COVERAGE_CASES})`),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const linked = await zephyrFetch(cfg, { method: 'GET', path: issueLinkPath(args.issueKey) });
      const links = testCaseKeysOf(linked);
      // Found live: the endpoint answers one entry per LINK, so a case linked twice arrived twice and was
      // read twice against the "up to 2 requests per case" budget, for two identical rows.
      const distinct = [...new Set(links)];
      const includeLastResults = args.includeLastResults ?? true;

      const cases: ApiObject[] = [];
      for (const key of distinct.slice(0, args.maxCases ?? DEFAULT_COVERAGE_CASES)) {
        cases.push(await coverageRow(cfg, key, includeLastResults));
      }

      const notes: string[] = [];
      if (distinct.length > cases.length) {
        notes.push(`Expanded only the first ${cases.length} of ${distinct.length} distinct linked cases (maxCases).`);
      }
      if (links.length > distinct.length) {
        notes.push(`${links.length - distinct.length} duplicate link(s) collapsed: cases[] has one row per distinct test case.`);
      }
      return compact({
        issueKey: args.issueKey,
        totalLinked: links.length,
        returned: cases.length,
        note: notes.length > 0 ? notes.join(' ') : undefined,
        cases,
      });
    },
  });
}
