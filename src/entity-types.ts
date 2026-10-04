import { z } from 'zod';

/**
 * Entity *return type* registry - the mirror image of `T` (src/types.ts) on the output side.
 *
 * Design rule: declare only the stable part of the envelope (id / key / array field names)
 * and leave business fields to `fields`, plus `.passthrough()`. Jira's response fields vary
 * by instance, plugin and version; pinning them down would be a lie and would make the
 * outputSchema fail against a real instance.
 *
 * These types feed two things:
 *   1. the MCP `outputSchema` (so the model knows what it will get back)
 *   2. `structuredContent` (so clients can render typed results)
 *
 * Note: tools that can return an empty 204 (update/delete/assign/transition) must NOT declare
 * `returns` - a declared outputSchema requires structuredContent, and an empty body violates it.
 *
 * Rule for `required`: only keys that have actually been observed on a real instance.
 * A required key the server does not send turns a working call into an MCP output-validation
 * error, which is worse than a slightly vaguer schema. `jira_get_attachment_meta` failed on a
 * real 8.5.7 instance exactly this way, so the write-path and attachment envelopes - which no
 * write verification has exercised yet - require nothing and merely document the properties.
 */

const anyRecord = z.record(z.string(), z.any());

/** Envelope: a few fixed keys, everything else allowed. */
const envelope = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();

/** A user reference as it appears in author/assignee/reporter. */
const userRef = anyRecord.describe('user reference; Server uses `name`, Cloud uses `accountId`');

export const E = {
  // -- issue ---------------------------------------------------------------
  issue: envelope({
    id: z.string(),
    key: z.string().describe('issue key, e.g. PROJ-123'),
    self: z.string().optional(),
    fields: anyRecord.describe('business fields; custom and plugin fields are keyed customfield_xxxxx and their value shape varies by field type'),
  }).describe('Jira issue'),

  // UNVERIFIED: no write verification run yet -> nothing required.
  createdIssue: envelope({
    id: z.string().optional(),
    key: z.string().optional(),
    self: z.string().optional(),
  }).describe('result of creating an issue'),

  searchResult: envelope({
    startAt: z.number(),
    maxResults: z.number(),
    total: z.number().describe('total number of matches, may exceed the number returned'),
    issues: z.array(z.unknown()).describe('issue array; each item has the shape of jira_get_issue'),
  }).describe('JQL search result'),

  transitions: envelope({
    transitions: z.array(envelope({
      id: z.string().describe('pass this as transitionId to jira_transition_issue'),
      name: z.string(),
      to: anyRecord.optional(),
    })).describe('currently available transitions'),
  }).describe('available transitions for an issue'),

  // -- comment -------------------------------------------------------------
  // UNVERIFIED (add/update not exercised yet) -> nothing required.
  comment: envelope({
    id: z.string().optional(),
    body: z.string().optional().describe('on Server this is wiki markup, not Markdown'),
    author: userRef.optional(),
    updateAuthor: userRef.optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  }).describe('comment'),

  comments: envelope({
    comments: z.array(z.unknown()).describe('comment array; each item has the shape returned by jira_add_comment'),
    total: z.number().optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
  }).describe('comment list'),

  // -- worklog -------------------------------------------------------------
  // UNVERIFIED (add/update not exercised yet) -> nothing required.
  worklog: envelope({
    id: z.string().optional(),
    timeSpentSeconds: z.number().optional(),
    started: z.string().optional(),
    comment: z.string().optional(),
    author: userRef.optional(),
  }).describe('worklog entry'),

  worklogs: envelope({
    worklogs: z.array(z.unknown()),
    total: z.number().optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
  }).describe('worklog list'),

  // -- attachment ----------------------------------------------------------
  // UNVERIFIED: /rest/api/2/attachment/{id} failed output validation on a real 8.5.7 instance,
  // so the shape this project assumed is wrong in some detail -> nothing required.
  attachment: envelope({
    id: z.union([z.string(), z.number()]).optional(),
    filename: z.string().optional(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    content: z.string().optional().describe('download URL (absolute)'),
    author: userRef.optional(),
    created: z.string().optional(),
  }).describe('attachment'),

  attachmentList: envelope({
    id: z.union([z.string(), z.number()]).optional(),
    key: z.string().optional(),
    fields: envelope({ attachment: z.array(z.unknown()).optional() }).optional(),
  }).describe('attachments of an issue (fields.attachment)'),

  // -- project / user / meta -----------------------------------------------
  project: envelope({
    id: z.string(),
    key: z.string(),
    name: z.string().optional(),
    projectTypeKey: z.string().optional(),
  }).describe('project'),

  user: envelope({
    name: z.string().optional().describe('Server login name'),
    key: z.string().optional(),
    accountId: z.string().optional().describe('Cloud only'),
    displayName: z.string().optional(),
    emailAddress: z.string().optional(),
    active: z.boolean().optional(),
  }).describe('user'),

  serverInfo: envelope({
    version: z.string().optional(),
    versionNumbers: z.array(z.number()).optional(),
    deploymentType: z.string().optional().describe('Server / Cloud'),
    buildNumber: z.number().optional(),
    serverTitle: z.string().optional(),
  }).describe('Jira version information'),

  plugins: envelope({
    plugins: z.array(envelope({
      key: z.string().optional(),
      name: z.string().optional(),
      version: z.string().optional(),
      enabled: z.boolean().optional(),
    })).describe('installed plugins; empty when UPM refuses or is absent'),
    pluginInventory: z.string().optional().describe('"ok", or why the UPM list is unavailable'),
    attempts: z.array(z.unknown()).optional().describe('per-path outcomes when UPM was tried'),
    inferredFromFields: z.array(envelope({
      pluginKey: z.string().optional().describe('prefix of the field schema, e.g. com.example.greenhopper'),
      fieldCount: z.number().optional(),
      sampleFields: z.array(z.string()).optional(),
    })).optional().describe('plugins inferred from custom field schemas when UPM is unavailable'),
    note: z.string().optional(),
  }).describe('UPM plugin list, or a field-derived inference when UPM is unavailable'),

  sprint: envelope({
    id: z.number(),
    name: z.string().optional(),
    state: z.string().optional().describe('future | active | closed'),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    completeDate: z.string().optional(),
    originBoardId: z.number().optional(),
  }).describe('Agile sprint'),

  /**
   * Jira Agile *issue list* envelope - board issues, sprint issues and the backlog share
   * this one (`issues`). Deliberately lenient: verified against a real 8.5.7 instance where
   * the backlog response does not carry the same key set as /search.
   */
  agileIssues: envelope({
    issues: z.array(z.unknown()).describe('issue array; each item has the shape of jira_get_issue'),
    total: z.number().optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    isLast: z.boolean().optional(),
    expand: z.string().optional(),
  }).describe('Agile issue list'),

  linkTypes: envelope({
    issueLinkTypes: z.array(envelope({
      id: z.string().optional(),
      name: z.string().describe('pass this as `type` when linking issues, e.g. Blocks / Relates'),
      inward: z.string().optional().describe('label shown on the destination issue'),
      outward: z.string().optional().describe('label shown on the source issue'),
    })).describe('available issue link types'),
  }).describe('issue link types'),

  watchers: envelope({
    isWatching: z.boolean().optional().describe('whether the authenticated user is watching'),
    watchCount: z.number().optional(),
    watchers: z.array(z.unknown()).describe('user array; each item has the shape of jira_get_user'),
  }).describe('watchers of an issue'),

  /** Jira Agile paging envelope: boards and sprints use `values`. */
  paged: envelope({
    values: z.array(z.unknown()).describe('page contents'),
    isLast: z.boolean().optional(),
    maxResults: z.number().optional(),
    startAt: z.number().optional(),
    total: z.number().optional(),
  }).describe('Agile paged result'),

  /**
   * Escape hatch for plugin endpoints whose payload shape is not known. MCP requires an object
   * root, so this is the loosest honest declaration: "an object, contents unspecified".
   */
  anyObject: z.object({}).passthrough().describe('any JSON object; only the envelope is known'),

  // -- Zephyr Scale --------------------------------------------------------
  // The 54 Zephyr tools come from vendored upstream code with its own zod schemas and
  // contract tests, and their return shapes (custom fields included) vary per instance.
  // These entries register the envelope for documentation; they are not forced onto the
  // upstream tools.
  testCase: envelope({
    id: z.number().optional(),
    key: z.string().optional().describe('e.g. PROJ-T1'),
    name: z.string().optional(),
    projectKey: z.string().optional(),
    status: z.string().optional(),
    testScript: anyRecord.optional().describe('type: STEP_BY_STEP | PLAIN_TEXT | BDD'),
  }).describe('Zephyr test case'),

  testRun: envelope({
    id: z.number().optional(),
    key: z.string().optional().describe('e.g. PROJ-R1'),
    name: z.string().optional(),
    projectKey: z.string().optional(),
    status: z.string().optional(),
    items: z.array(z.unknown()).optional(),
  }).describe('Zephyr test cycle (immutable; changes require recreating it)'),

  testResult: envelope({
    id: z.number().optional(),
    status: z.string().optional().describe('case-sensitive internal status name'),
    testCaseKey: z.string().optional(),
    executionDate: z.string().optional(),
  }).describe('Zephyr test execution result'),
} as const;

export type EntityName = keyof typeof E;
export const ENTITY_NAMES = Object.keys(E) as EntityName[];
