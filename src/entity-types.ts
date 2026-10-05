import { z } from 'zod';

/**
 * Entity *return type* registry - the mirror image of `T` (src/types.ts) on the output side.
 *
 * Design rule: declare only the stable part of the envelope (id / key / array field names)
 * and leave business fields to `fields`, plus `.passthrough()`. Jira's response fields vary
 * by instance, plugin and version; pinning them down would be a lie and would make the
 * outputSchema fail against a real instance.
 *
 * ## Rule for `required`
 *
 * 1. Only keys observed on a **real instance** may be required. A required key the server does
 *    not send turns a working call into an MCP output-validation error, which is strictly worse
 *    than a vaguer schema.
 * 2. Even then, require only the key that gives the object its identity or carries its payload -
 *    `id`, `key`, `fields`, `issues`, `values`, `comments` and so on. Payload keys stay optional.
 *
 * `npm run capture:instance` checks these schemas against real payloads and reports mismatches,
 * so a wrong assumption shows up as a failed check rather than as a broken tool call.
 *
 * Note: tools that can return an empty 204 (update/delete/assign/transition) must NOT declare
 * `returns` - a declared outputSchema requires structuredContent, and an empty body violates it.
 */

const anyRecord = z.record(z.string(), z.any());

/** Envelope: a few fixed keys, everything else allowed. */
const envelope = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();

/**
 * Fields that recur across entities are built by a **function**, never shared as one instance.
 * Two reasons, and the first is mechanical: reusing a single Zod instance inside a schema makes the
 * MCP SDK emit a `$ref` to its first occurrence, and a client that does not resolve `$ref` then
 * sees no type and no description for the second one. The second is that the model has to read
 * these values, so each carries the hint that makes it unambiguous.
 */
const jiraId = () => z.string().describe('Jira id; Server sends ids as strings, numeric ones included');
const resourceUrl = () => z.string().describe('absolute URL of this resource on the instance');
const expandField = () => z.string().describe('which optional sections the server inlined in this response');
const createdStamp = () => z.string().describe('creation time, ISO 8601 with offset');
const updatedStamp = () => z.string().describe('last-modified time, ISO 8601 with offset');
const pageStart = () => z.number().describe('0-based index of the first item in this page');
const pageSize = () => z.number().describe('page size the server applied');
const pageTotal = () => z.number().describe('total matches, which may exceed the items returned');
const pageIsLast = () => z.boolean().describe('true when this is the last page');
const avatarUrls = () => anyRecord.describe('avatar URLs keyed by size: 16x16, 24x24, 32x32, 48x48');

/** A user reference as it appears in author/assignee/reporter/creator. Fresh per call (see above). */
const userRef = () => envelope({
  self: resourceUrl().optional(),
  name: z.string().optional().describe('Server login name; Server uses this where Cloud uses accountId'),
  key: z.string().optional().describe('user key; on Server it is usually the lower-cased login name'),
  accountId: z.string().optional().describe('Cloud only'),
  emailAddress: z.string().optional().describe('absent when Jira hides e-mail addresses'),
  displayName: z.string().optional().describe('full name as shown in the UI'),
  active: z.boolean().optional().describe('false for a deactivated account'),
  timeZone: z.string().optional().describe('time zone from the user profile'),
  avatarUrls: avatarUrls().optional(),
}).describe('user reference; Server uses `name`, Cloud uses `accountId`');

export const E = {
  // -- issue ---------------------------------------------------------------
  // Verified over 5 sampled issues: id / key / fields / self / expand were present in all.
  issue: envelope({
    id: z.string().describe('Jira id; Server sends ids as strings, numeric ones included'),
    key: z.string().describe('issue key, e.g. PROJ-123'),
    self: resourceUrl().optional(),
    expand: expandField().optional(),
    fields: anyRecord.describe('business fields; custom and plugin fields are keyed customfield_xxxxx and their value shape varies by field type'),
  }).describe('Jira issue'),

  // UNVERIFIED: no write verification run yet -> nothing required.
  createdIssue: envelope({
    id: jiraId().optional(),
    key: z.string().optional().describe('issue key of the new issue, e.g. PROJ-123'),
    self: resourceUrl().optional(),
  }).describe('result of creating an issue'),

  searchResult: envelope({
    startAt: pageStart(),
    maxResults: pageSize(),
    total: pageTotal(),
    issues: z.array(z.unknown()).describe('issue array; each item has the shape of jira_get_issue'),
  }).describe('JQL search result'),

  transitions: envelope({
    expand: expandField().optional(),
    transitions: z.array(envelope({
      id: z.string().describe('pass this as transitionId to jira_transition_issue'),
      name: z.string().describe('transition name as shown in the UI'),
      to: envelope({
        self: resourceUrl().optional(),
        id: jiraId().optional(),
        name: z.string().optional().describe('status name the issue moves to'),
        description: z.string().optional().describe('status description, when the instance sets one'),
        iconUrl: z.string().optional().describe('URL of the status icon'),
        statusCategory: envelope({
          self: resourceUrl().optional(),
          id: z.number().optional().describe('numeric status-category id'),
          key: z.string().optional().describe('to do | in progress | done'),
          colorName: z.string().optional().describe('colour name the UI uses for this category'),
          name: z.string().optional().describe('display name of the status category'),
        }).optional().describe('the coarse category (to do / in progress / done)'),
      }).optional().describe('the status this transition moves the issue to'),
    })).describe('currently available transitions'),
  }).describe('available transitions for an issue'),

  // -- comment / worklog ---------------------------------------------------
  // UNVERIFIED on the write path (add/update) -> nothing required.
  comment: envelope({
    self: resourceUrl().optional(),
    id: jiraId().optional(),
    body: z.string().optional().describe('on Server this is wiki markup, not Markdown'),
    author: userRef().optional(),
    updateAuthor: userRef().describe('the user who last edited the comment, when it was edited').optional(),
    created: createdStamp().optional(),
    updated: updatedStamp().optional(),
  }).describe('comment'),

  comments: envelope({
    comments: z.array(z.unknown()).describe('comment array; each item has the shape returned by jira_add_comment'),
    total: pageTotal().optional(),
    startAt: pageStart().optional(),
    maxResults: pageSize().optional(),
  }).describe('comment list'),

  // UNVERIFIED: the sampled issue had no worklogs.
  worklog: envelope({
    id: jiraId().optional(),
    self: resourceUrl().optional(),
    timeSpentSeconds: z.number().optional().describe('time logged, in seconds'),
    started: z.string().optional().describe('when the work began, ISO 8601 with offset'),
    comment: z.string().optional().describe('worklog comment (wiki markup)'),
    author: userRef().optional(),
  }).describe('worklog entry'),

  worklogs: envelope({
    worklogs: z.array(z.unknown()).describe('worklog array; each item has the shape returned by jira_add_worklog'),
    total: pageTotal().optional(),
    startAt: pageStart().optional(),
    maxResults: pageSize().optional(),
  }).describe('worklog list'),

  // -- attachment ----------------------------------------------------------
  /**
   * Deliberately permissive for a specific reason: the items inside `fields.attachment[]` were
   * captured and do carry id/filename, but `GET /rest/api/2/attachment/{id}` returned something
   * that did not match the assumed shape on a real 8.5.7 instance. The two endpoints disagree,
   * so nothing is required here.
   */
  attachment: envelope({
    self: resourceUrl().optional(),
    id: z.union([z.string(), z.number()]).optional().describe('attachment id, as a string or a number depending on the endpoint'),
    filename: z.string().optional().describe('file name as uploaded'),
    size: z.number().optional().describe('size in bytes'),
    mimeType: z.string().optional().describe('content type the server detected'),
    content: z.string().optional().describe('download URL (absolute)'),
    thumbnail: z.string().optional().describe('thumbnail URL, when the server generated one'),
    author: userRef().optional(),
    created: createdStamp().optional(),
  }).describe('attachment'),

  attachmentList: envelope({
    expand: expandField().optional(),
    id: jiraId().optional(),
    self: resourceUrl().optional(),
    key: z.string().optional().describe('issue key, e.g. PROJ-123'),
    fields: envelope({
      attachment: z.array(z.unknown()).optional().describe('attachment array; each item has the shape of jira_get_attachment_meta'),
    }).optional().describe('the single field this call asked for'),
  }).describe('attachments of an issue (fields.attachment)'),

  // -- project / user / meta -----------------------------------------------
  project: envelope({
    id: jiraId(),
    key: z.string().describe('project key, e.g. PROJ'),
    self: resourceUrl().optional(),
    name: z.string().optional().describe('project name'),
    description: z.string().optional().describe('project description, when set'),
    expand: expandField().optional(),
    projectTypeKey: z.string().optional().describe('software | service_desk | business'),
    archived: z.boolean().optional().describe('true when the project is archived'),
    assigneeType: z.string().optional().describe('default assignee rule for the project'),
    lead: userRef().optional(),
    avatarUrls: avatarUrls().describe('project avatar URLs keyed by size').optional(),
    projectCategory: envelope({
      self: resourceUrl().optional(),
      id: jiraId().optional(),
      name: z.string().optional().describe('category name'),
      description: z.string().optional().describe('category description, when set'),
    }).optional().describe('the category this project belongs to, when it has one'),
    components: z.array(z.unknown()).optional().describe('component array, when the response expands it'),
    issueTypes: z.array(z.unknown()).optional().describe('issue-type array, when the response expands it'),
    versions: z.array(z.unknown()).optional().describe('version array, when the response expands it'),
    roles: z.record(z.string(), z.string()).optional().describe('role name -> role URL'),
  }).describe('project'),

  user: envelope({
    self: resourceUrl().optional(),
    name: z.string().optional().describe('Server login name; Server uses this where Cloud uses accountId'),
    key: z.string().optional().describe('user key; on Server it is usually the lower-cased login name'),
    accountId: z.string().optional().describe('Cloud only'),
    displayName: z.string().optional().describe('full name as shown in the UI'),
    emailAddress: z.string().optional().describe('absent when Jira hides e-mail addresses'),
    active: z.boolean().optional().describe('false for a deactivated account'),
    timeZone: z.string().optional().describe('time zone from the user profile'),
    locale: z.string().optional().describe('UI locale, e.g. zh_CN'),
    avatarUrls: avatarUrls().optional(),
    expand: expandField().optional(),
  }).describe('user'),

  serverInfo: envelope({
    baseUrl: z.string().optional().describe('instance root URL, as the server sees itself'),
    version: z.string().optional().describe('Jira version, e.g. 8.5.7'),
    versionNumbers: z.array(z.number()).optional().describe('version split into numbers, e.g. [8, 5, 7]'),
    deploymentType: z.string().optional().describe('Server / Cloud'),
    buildNumber: z.number().optional().describe('build number of the running Jira'),
    buildDate: z.string().optional().describe('when this build was produced'),
    databaseBuildNumber: z.number().optional().describe('build number of the database schema'),
    serverTime: z.string().optional().describe('the server clock at the moment of the call'),
    scmInfo: z.string().optional().describe('git revision of the running build'),
    serverTitle: z.string().optional().describe('title configured for this instance'),
  }).describe('Jira version information'),

  plugins: envelope({
    plugins: z.array(envelope({
      key: z.string().optional().describe('plugin key, e.g. com.example.agile'),
      name: z.string().optional().describe('plugin name as UPM reports it'),
      version: z.string().optional().describe('installed version'),
      enabled: z.boolean().optional().describe('false when the plugin is installed but disabled'),
    })).describe('installed plugins; empty when UPM refuses or is absent'),
    pluginInventory: z.string().optional().describe('"ok", or why the UPM list is unavailable'),
    attempts: z.array(z.unknown()).optional().describe('per-path outcomes when UPM was tried'),
    inferredFromFields: z.array(envelope({
      pluginKey: z.string().optional().describe('prefix of the field schema, e.g. com.example.agile'),
      fieldCount: z.number().optional().describe('how many custom fields carry this prefix'),
      sampleFields: z.array(z.string()).optional().describe('a few field ids with this prefix, as examples'),
    })).optional().describe('plugins inferred from custom field schemas when UPM is unavailable'),
    note: z.string().optional().describe('what to do when the list is empty or inferred'),
  }).describe('UPM plugin list, or a field-derived inference when UPM is unavailable'),

  /** Jira Agile paging envelope: boards and sprints use `values`. */
  paged: envelope({
    values: z.array(z.unknown()).describe('page contents'),
    isLast: pageIsLast().optional(),
    maxResults: pageSize().optional(),
    startAt: pageStart().optional(),
    total: pageTotal().optional(),
  }).describe('Agile paged result'),

  /**
   * Jira Agile *issue list* envelope - board issues, sprint issues and the backlog share this one
   * (`issues`). Deliberately lenient: verified on a real 8.5.7 instance, where the backlog
   * response does not carry the same key set as /search.
   */
  agileIssues: envelope({
    issues: z.array(z.unknown()).describe('issue array; each item has the shape of jira_get_issue'),
    total: pageTotal().optional(),
    startAt: pageStart().optional(),
    maxResults: pageSize().optional(),
    isLast: pageIsLast().optional(),
    expand: expandField().optional(),
  }).describe('Agile issue list'),

  linkTypes: envelope({
    issueLinkTypes: z.array(envelope({
      id: jiraId().optional(),
      name: z.string().describe('pass this as `type` when linking issues, e.g. Blocks / Relates'),
      inward: z.string().optional().describe('label shown on the destination issue'),
      outward: z.string().optional().describe('label shown on the source issue'),
    })).describe('available issue link types'),
  }).describe('issue link types'),

  watchers: envelope({
    self: resourceUrl().optional(),
    isWatching: z.boolean().optional().describe('whether the authenticated user is watching'),
    watchCount: z.number().optional().describe('how many users watch the issue'),
    watchers: z.array(z.unknown()).describe('user array; each item has the shape of jira_get_user'),
  }).describe('watchers of an issue'),

  /** Verified over 40 sampled sprints; `goal` was missing from some, so it stays optional. */
  sprint: envelope({
    id: z.number().describe('numeric sprint id, as a number here'),
    self: resourceUrl().optional(),
    name: z.string().optional().describe('sprint name'),
    state: z.string().optional().describe('future | active | closed'),
    startDate: z.string().optional().describe('planned or actual start, ISO 8601 with offset'),
    endDate: z.string().optional().describe('planned or actual end, ISO 8601 with offset'),
    completeDate: z.string().optional().describe('when the sprint completed; absent while it is not closed'),
    originBoardId: z.number().optional().describe('the board this sprint was created from'),
    goal: z.string().optional().describe('sprint goal; absent when none was set'),
  }).describe('Agile sprint'),

  /**
   * Escape hatch for plugin endpoints whose payload shape is not known. MCP requires an object
   * root, so this is the loosest honest declaration: "an object, contents unspecified".
   */
  anyObject: z.object({}).passthrough().describe('any JSON object; only the envelope is known'),

  // -- Zephyr Scale --------------------------------------------------------
  /**
   * Zephyr's tools come from vendored upstream code that returns text, so these shapes are
   * **reference documentation**, not yet attached as outputSchema. They were derived from a real
   * instance by `npm run capture:instance`, which also checks captured payloads against them.
   */
  testCase: envelope({
    id: z.number().optional(),
    key: z.string().describe('e.g. PROJ-T1'),
    name: z.string().optional(),
    projectKey: z.string().optional(),
    folder: z.string().optional().describe('folder path, e.g. "/Regression/Login"'),
    status: z.string().optional(),
    priority: z.string().optional(),
    objective: z.string().optional(),
    precondition: z.string().optional(),
    createdBy: z.string().optional(),
    createdOn: z.string().optional(),
    updatedBy: z.string().optional(),
    updatedOn: z.string().optional(),
    majorVersion: z.number().optional(),
    latestVersion: z.boolean().optional(),
    lastTestResultStatus: z.string().optional(),
    customFields: anyRecord.optional().describe('field NAME -> value; the names are instance-specific'),
    testScript: envelope({
      id: z.number().optional(),
      type: z.string().optional().describe('STEP_BY_STEP | PLAIN_TEXT | BDD'),
      text: z.string().optional().describe('PLAIN_TEXT and BDD scripts carry text instead of steps'),
      steps: z.array(envelope({
        id: z.number().optional().describe('needed for read-merge-write step edits'),
        index: z.number().optional(),
        description: z.string().optional(),
        expectedResult: z.string().optional(),
      })).optional(),
    }).optional(),
    parameters: envelope({
      variables: z.array(z.unknown()).optional(),
      entries: z.array(z.unknown()).optional(),
    }).optional(),
  }).describe('Zephyr test case'),

  testRunItem: envelope({
    id: z.number().optional(),
    testCaseKey: z.string().optional(),
    status: z.string().optional().describe('case-sensitive internal status name'),
    assignedTo: z.string().optional(),
    userKey: z.string().optional().describe('Jira user key, not a username'),
    executedBy: z.string().optional(),
    environment: z.string().optional(),
    executionDate: z.string().optional(),
    actualStartDate: z.string().optional(),
    actualEndDate: z.string().optional(),
  }).describe('one test case inside a test cycle'),

  testRun: envelope({
    id: z.number().optional(),
    key: z.string().describe('e.g. PROJ-R1'),
    name: z.string().optional(),
    projectKey: z.string().optional(),
    folder: z.string().optional(),
    status: z.string().optional(),
    issueKey: z.string().optional().describe('the Jira issue the cycle is linked to, when there is one'),
    createdBy: z.string().optional(),
    createdOn: z.string().optional(),
    updatedBy: z.string().optional(),
    updatedOn: z.string().optional(),
    plannedStartDate: z.string().optional(),
    plannedEndDate: z.string().optional(),
    estimatedTime: z.number().optional(),
    executionTime: z.number().optional(),
    issueCount: z.number().optional(),
    testCaseCount: z.number().optional(),
    executionSummary: z.record(z.string(), z.number()).optional().describe('status name -> count'),
    items: z.array(z.unknown()).optional().describe('testRunItem array'),
  }).describe('Zephyr test cycle (immutable; changes require recreating it)'),

  testResult: envelope({
    id: z.number().optional(),
    key: z.string().optional(),
    testCaseKey: z.string().optional(),
    projectId: z.number().optional(),
    status: z.string().optional().describe('case-sensitive internal status name'),
    assignedTo: z.string().optional(),
    userKey: z.string().optional(),
    executedBy: z.string().optional(),
    environment: z.string().optional(),
    automated: z.boolean().optional(),
    executionDate: z.string().optional(),
    actualStartDate: z.string().optional(),
    actualEndDate: z.string().optional(),
    scriptResults: z.array(envelope({
      index: z.number().optional(),
      status: z.string().optional(),
      description: z.string().optional(),
      expectedResult: z.string().optional(),
    })).optional().describe('per-step outcome; the step is identified by index here, not by id'),
  }).describe('Zephyr test execution result'),

  testRunSummary: envelope({
    key: z.string(),
    name: z.string().optional(),
    runStatus: z.string().optional(),
    itemCount: z.number().optional(),
    latestResults: z.number().optional(),
    executed: z.number().optional(),
    executionProgressPct: z.number().optional(),
    passRatePct: z.number().optional(),
    byStatus: z.record(z.string(), z.number()).optional().describe('status name -> count'),
    note: z.string().optional(),
  }).describe('Zephyr execution summary for a cycle'),

  testPlan: envelope({
    id: z.number().optional(),
    key: z.string().describe('e.g. PROJ-P1'),
    name: z.string().optional(),
    projectKey: z.string().optional(),
    folder: z.string().optional(),
    status: z.string().optional(),
    owner: z.string().optional(),
    objective: z.string().optional(),
    createdBy: z.string().optional(),
    createdOn: z.string().optional(),
    updatedBy: z.string().optional(),
    updatedOn: z.string().optional(),
    comments: z.array(z.unknown()).optional(),
    issueLinks: z.array(z.unknown()).optional(),
    testRuns: z.array(z.unknown()).optional().describe('embedded cycle summaries'),
  }).describe('Zephyr test plan'),

  /** The Zephyr page envelope used by paged reads such as get_test_run_results. */
  zephyrPage: envelope({
    values: z.array(z.unknown()).describe('page contents'),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
    count: z.number().optional().describe('number of items in this page'),
    isLast: z.boolean().optional(),
    note: z.string().optional(),
  }).describe('Zephyr paged result'),

  /**
   * The root of a folder tree: it is the project, not a folder, so it has no `id`.
   * `children` is optional because a project with no folders may simply omit it.
   */
  folderTree: envelope({
    projectId: z.number().optional(),
    itemsCount: z.number().optional(),
    children: z.array(z.unknown()).optional().describe('folderNode array; recursively nested'),
  }).describe('Zephyr folder tree root'),

  folderNode: envelope({
    id: z.number(),
    name: z.string().optional(),
    projectId: z.number().optional(),
    parentId: z.number().optional(),
    index: z.number().optional(),
    itemsCount: z.number().optional(),
    createdBy: z.string().optional(),
    createdOn: z.string().optional(),
    updatedBy: z.string().optional(),
    updatedOn: z.string().optional(),
    children: z.array(z.unknown()).optional().describe('nested folderNode array'),
  }).describe('Zephyr folder tree node'),

  statusOptions: envelope({
    source: z.string().optional().describe('which option set was read'),
    values: z.array(envelope({
      id: z.number().optional(),
      name: z.string().optional().describe('the case-sensitive value the API expects'),
      index: z.number().optional(),
      color: z.string().optional(),
      i18nKey: z.string().optional(),
      isDefault: z.boolean().optional(),
      projectId: z.number().optional(),
    })).describe('allowed values for the requested option set'),
  }).describe('Zephyr status/priority option set'),

  /** The tool returns an *array* of these, so this is the item shape, not a tool return type. */
  customFieldDefinition: envelope({
    id: z.number().optional(),
    name: z.string().optional().describe('the field name to use in customFields'),
    type: z.string().optional(),
    index: z.number().optional(),
    projectId: z.number().optional(),
    required: z.boolean().optional(),
    archived: z.boolean().optional(),
    options: z.array(envelope({
      id: z.number().optional(),
      name: z.string().optional(),
      index: z.number().optional(),
      archived: z.boolean().optional(),
    })).optional(),
  }).describe('Zephyr custom field definition (returned inside an array)'),
} as const;

export type EntityName = keyof typeof E;
export const ENTITY_NAMES = Object.keys(E) as EntityName[];
