/**
 * Shared plumbing for the UNOFFICIAL internal Zephyr Scale API (`/rest/tests/1.0`) — the API the
 * Jira UI itself calls. Tools built on it are registered only when ZEPHYR_ALLOW_INTERNAL_API=true.
 *
 * Everything here exists because the internal API speaks NUMERIC ids while the public API (and our
 * tools) speak human keys, so every internal tool needs the same key→id resolution, the same error
 * decoration and the same run-item plumbing.
 */
import type { Config } from './config.ts';
import { addHint, zephyrFetch } from './http.ts';
import { ToolInputError } from './toolkit.ts';

/** Base path of the internal API. */
export const INTERNAL_BASE = '/rest/tests/1.0';

/** Prefix a path with the internal API base: internal('/testrun/5') -> '/rest/tests/1.0/testrun/5'. */
export const internal = (path: string): string => `${INTERNAL_BASE}${path}`;

/** Standard opening for the description of every internal-API tool (keeps the warning identical). */
export const INTERNAL_NOTE =
  `UNOFFICIAL — internal API: this tool calls ${INTERNAL_BASE}, the same undocumented API the Jira UI uses. ` +
  'The vendor does NOT support it: endpoints may differ or be absent on another Zephyr Scale version. ' +
  'Registered only because ZEPHYR_ALLOW_INTERNAL_API=true.';

/** Suffix for internal tools whose request shape was confirmed against a real instance. */
export const VERIFIED_NOTE = 'Verified live against a legacy Zephyr Scale Server build.';

/** Suffix for internal tools whose request shape was captured from the browser traffic of the Jira UI. */
export const CAPTURED_NOTE = 'The request shape was captured live from the Jira UI, not guessed.';

const INTERNAL_ERROR_HINT =
  `This tool uses the UNOFFICIAL internal API (${INTERNAL_BASE}) — an error here usually means the endpoint ` +
  'differs or is absent on this Zephyr Scale version.';

/** Decorate an error with the internal-API hint (plus an optional tool-specific note). */
export function withInternalHint(err: unknown, extra?: string): unknown {
  return addHint(err, extra ? `${INTERNAL_ERROR_HINT}\n${extra}` : INTERNAL_ERROR_HINT);
}

/** Run `fn`, decorating any failure with the internal-API hint. */
export async function internalCall<T>(fn: () => Promise<T>, extraHint?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw withInternalHint(err, extraHint);
  }
}

/** Entity families addressable by key in the internal API. */
export type InternalEntity = 'testrun' | 'testcase' | 'testplan';

/** Path segment used by the internal API for each entity type (foldertree, customfields, …). */
export const ENTITY_SEGMENT = { test_case: 'testcase', test_plan: 'testplan', test_run: 'testrun' } as const;

export type EntityKind = keyof typeof ENTITY_SEGMENT;

/**
 * Coerce an API value to a numeric id, accepting only a finite number or a non-blank numeric string.
 * Plain Number() would turn null / '' / [] / false into 0 and address entity 0 downstream.
 */
export function asNumericId(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Read one entity by key with a `fields` projection (the internal API accepts keys here, not only ids). */
export async function fetchEntity(
  cfg: Config,
  entity: InternalEntity,
  key: string,
  fields = 'id',
): Promise<Record<string, unknown>> {
  const res = (await zephyrFetch(cfg, {
    method: 'GET',
    path: internal(`/${entity}/${encodeURIComponent(key)}`),
    query: { fields },
  })) as unknown;
  return res !== null && typeof res === 'object' ? (res as Record<string, unknown>) : {};
}

/** Resolve a human key (PROJ-T1 / PROJ-R1 / PROJ-P1) to the numeric id the internal API needs. */
export async function resolveEntityId(cfg: Config, entity: InternalEntity, key: string): Promise<number> {
  const res = await fetchEntity(cfg, entity, key);
  const id = asNumericId(res.id);
  if (id === undefined) {
    throw new Error(`Could not resolve the numeric id of ${entity} '${key}' (response: ${JSON.stringify(res)})`);
  }
  return id;
}

/** Resolve a Jira project key to its numeric project id (via the public Jira REST API). */
export async function resolveProjectId(cfg: Config, projectKey: string): Promise<number> {
  const project = (await zephyrFetch(cfg, {
    method: 'GET',
    path: `/rest/api/2/project/${encodeURIComponent(projectKey)}`,
  })) as { id?: unknown };
  const id = asNumericId(project?.id);
  if (id === undefined) {
    throw new Error(`Could not resolve the numeric id of project '${projectKey}' from Jira (response: ${JSON.stringify(project)})`);
  }
  return id;
}

/** One item of a test run as the internal API returns it (dollar-prefixed last result included). */
export type RunItem = Record<string, unknown> & { id: number };

/**
 * Read the items of a run.
 *
 * NOTE: no `fields` projection on purpose — a narrow projection drops the item `id` and hides the
 * test case behind `$lastTestResult`, which silently broke item matching on a real instance.
 */
export async function fetchRunItems(cfg: Config, runId: number): Promise<RunItem[]> {
  const res = (await zephyrFetch(cfg, { method: 'GET', path: internal(`/testrun/${runId}/testrunitems`) })) as {
    testRunItems?: unknown;
  };
  const items = Array.isArray(res?.testRunItems) ? (res.testRunItems as Array<Record<string, unknown>>) : [];
  // Coerce rather than typeof-check: a build that serializes item ids as strings would otherwise have
  // every item silently dropped here, and the caller would report an empty run.
  return items.flatMap((item) => {
    const id = asNumericId(item.id);
    return id === undefined ? [] : [{ ...item, id }];
  });
}

const lastResultOf = (item: Record<string, unknown>): Record<string, unknown> | undefined =>
  (item.$lastTestResult ?? item.lastTestResult) as Record<string, unknown> | undefined;

/** Test case key of a run item — it can hide in several places depending on the version. */
export function runItemCaseKey(item: Record<string, unknown>): string | undefined {
  const key = (lastResultOf(item)?.testCase as Record<string, unknown> | undefined)?.key ?? item.testCaseKey;
  return typeof key === 'string' ? key : undefined;
}

/** Numeric test case id of a run item — same story as the key. */
export function runItemCaseId(item: Record<string, unknown>): number | undefined {
  const last = lastResultOf(item);
  const raw = item.testCaseId ?? last?.testCaseId ?? (last?.testCase as Record<string, unknown> | undefined)?.id;
  return asNumericId(raw);
}

/** Position of a run item in the run (used when reordering). */
export function runItemIndex(item: Record<string, unknown>): number {
  return asNumericId(item.index) ?? 0;
}

export interface RunItemChanges {
  added?: Array<Record<string, unknown>>;
  /** Item ids to delete (their execution results die with them). */
  deleted?: number[];
  /** New positions: [{ id, index }]. */
  indexes?: Array<{ id: number; index: number }>;
}

/**
 * Save run-item changes through the single endpoint the UI uses for adding, removing and reordering
 * items. All four arrays must be present — the endpoint rejects partial bodies on some builds — and
 * `index` inside `addedTestRunItems` is 0-based WITHIN the added batch (an absolute position is
 * rejected with "Invalid: index value out of range").
 */
export async function saveRunItems(cfg: Config, runId: number, changes: RunItemChanges): Promise<void> {
  await zephyrFetch(cfg, {
    method: 'PUT',
    path: internal('/testrunitem/bulk/save'),
    body: {
      testRunId: runId,
      addedTestRunItems: changes.added ?? [],
      updatedTestRunItems: [],
      updatedTestRunItemsIndexes: changes.indexes ?? [],
      deletedTestRunItems: (changes.deleted ?? []).map((id) => ({ id })),
      autoReorder: false,
    },
  });
}

/** Read the execution-status option set of a project ([{ id, name, … }]). */
export async function fetchResultStatuses(cfg: Config, projectId: number): Promise<Array<{ id?: number; name?: string }>> {
  const statuses = await zephyrFetch(cfg, { method: 'GET', path: internal(`/project/${projectId}/testresultstatus`) });
  return Array.isArray(statuses) ? (statuses as Array<{ id?: number; name?: string }>) : [];
}

/** Resolve a case-sensitive execution status NAME to the internal status id, listing the valid names on a miss. */
export async function resolveResultStatusId(cfg: Config, projectKey: string, statusName: string): Promise<number> {
  const projectId = await resolveProjectId(cfg, projectKey);
  const statuses = await fetchResultStatuses(cfg, projectId);
  const match = statuses.find((status) => status.name === statusName);
  if (!match || typeof match.id !== 'number') {
    const names = statuses.map((status) => status.name).filter(Boolean).join(', ');
    // ToolInputError, not a generic Error: this is a caller mistake, and toolkit's errorText prints
    // its message bare instead of prefixing it with "Error: ".
    throw new ToolInputError(
      `Unknown execution status '${statusName}' (names are case-sensitive). Available in ${projectKey}: ${names || '(none returned)'}`,
    );
  }
  return match.id;
}
