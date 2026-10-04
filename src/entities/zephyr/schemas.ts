import { z } from 'zod';

/* ─────────────────────────────────────────────────────────────────────────────
 * Reusable parameter schemas. Every tool takes its entity keys, project key,
 * `fields` projection and folder paths from here, so the wording an LLM sees is
 * identical everywhere and a fix lands in one place.
 * ────────────────────────────────────────────────────────────────────────── */

export const projectKeySchema = z
  .string()
  .optional()
  .describe('Jira project key, e.g. "PROJ"; defaults to ZEPHYR_DEFAULT_PROJECT_KEY when omitted');

export const testCaseKeySchema = z.string().min(1).describe('Test case key, e.g. PROJ-T123');
export const testRunKeySchema = z.string().min(1).describe('Test run (cycle) key, e.g. PROJ-R123 (PROJ-C123 on older instances)');
export const testPlanKeySchema = z.string().min(1).describe('Test plan key, e.g. PROJ-P123');
export const issueKeySchema = z.string().min(1).describe('Jira issue key, e.g. PROJ-123');

export const testResultIdSchema = z
  .number()
  .int()
  .positive()
  .describe(
    'Numeric test result (execution) id — an id, NOT a key; returned by create_test_result, update_last_test_result and get_test_run_results',
  );

export const attachmentIdSchema = z
  .number()
  .int()
  .positive()
  .describe('Numeric attachment id, as returned by list_attachments or by an upload_attachment response');

export const fieldsSchema = z
  .array(z.string())
  .optional()
  .describe('Return only these fields, e.g. ["key","name","status"]; sent to the API as one comma-separated parameter');

/** Full folder path from the root; the API has no notion of relative paths. */
export const folderPathSchema = z
  .string()
  .regex(/^\//, 'must be a full path from the root starting with "/"')
  .describe('Full folder path from the root starting with "/", e.g. "/Regression/Payments"');

export const FOLDER_MUST_EXIST_NOTE =
  'The folder MUST already exist — the API never creates folders implicitly (use create_folder first).';

export const FOLDER_LISTING_NOTE =
  'The public Server/DC API v1 cannot LIST folders, so keep the numeric id returned by create_folder — rename_folder and ' +
  'delete_folder need it (otherwise it can only be found in the Jira UI, or with get_folder_tree when the internal API is enabled).';

/** Custom field values keyed by the custom field name as configured on the instance. */
/**
 * Custom field values keyed by field name.
 *
 * A FACTORY, not a constant: the MCP SDK serializes tool schemas with a converter that turns a zod
 * instance appearing twice inside one tool schema into a `$ref`, and strict clients (Gemini function
 * declarations, several MCP hosts) reject or mis-render `$ref`. A fresh instance per use site keeps
 * every published schema self-contained and inline — test/mcpSchemas.test.ts pins that.
 */
export const customFieldsSchema = (): z.ZodRecord<z.ZodString, z.ZodUnknown> => z.record(z.unknown());

export const stepSchema = z
  .object({
    id: z
      .number()
      .int()
      .optional()
      .describe(
        'Existing step id (returned by get_test_case). On update, steps with an id are updated, steps without an id are created, and existing steps missing from the list are DELETED.',
      ),
    description: z.string().optional().describe('Step action (HTML allowed)'),
    testData: z.string().optional().describe('Test data for the step (HTML allowed)'),
    expectedResult: z.string().optional().describe('Expected result of the step (HTML allowed)'),
    testCaseKey: z
      .string()
      .optional()
      .describe('Key of another test case to invoke as this step ("Call to Test"), e.g. PROJ-T45'),
  })
  .strict();

/** Step shape for creation flows where ids must not be supplied. */
export const newStepSchema = stepSchema.omit({ id: true }).strict();

export type Step = z.infer<typeof stepSchema>;

export const testScriptTypeSchema = z.enum(['STEP_BY_STEP', 'PLAIN_TEXT', 'BDD']);

function validateScriptShape(
  val: { type: 'STEP_BY_STEP' | 'PLAIN_TEXT' | 'BDD'; text?: string | undefined; steps?: unknown[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (val.type === 'STEP_BY_STEP') {
    if (!val.steps) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'testScript.steps is required when type is STEP_BY_STEP' });
    }
    if (val.text !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'testScript.text is not allowed when type is STEP_BY_STEP' });
    }
  } else {
    if (val.text === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `testScript.text is required when type is ${val.type}` });
    }
    if (val.steps !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `testScript.steps is not allowed when type is ${val.type}` });
    }
  }
}

export const testScriptSchema = z
  .object({
    type: testScriptTypeSchema.describe('Script format'),
    text: z
      .string()
      .optional()
      .describe(
        'Script body for PLAIN_TEXT, or the Gherkin scenario body for BDD: ONLY Given/When/Then/And/But step lines — Server/DC rejects texts wrapped in "Feature:"/"Scenario:" headers with 400 "Invalid BDD Script" (a BDD test case IS a single scenario; the feature wrapper is generated on export).',
      ),
    steps: z.array(stepSchema).optional().describe('Steps for STEP_BY_STEP'),
  })
  .strict()
  .superRefine(validateScriptShape);

export const parametersSchema = z
  .object({
    variables: z
      .array(
        z.union([
          z
            .object({
              name: z.string().describe('Variable name as referenced from the steps, e.g. "login"'),
              type: z.literal('FREE_TEXT').describe('FREE_TEXT: values are typed into the entries below'),
            })
            .strict(),
          z
            .object({
              name: z.string().describe('Variable name as referenced from the steps, e.g. "login"'),
              type: z.literal('DATA_SET').describe('DATA_SET: values come from a named data set in the project'),
              dataSet: z.string().describe('Name of the data set supplying the values; created automatically when unknown'),
            })
            .strict(),
        ]),
      )
      .describe('Declared parameters: each is either FREE_TEXT (values live in entries) or DATA_SET (values come from a data set)'),
    entries: z
      .array(z.record(z.string()))
      .describe('Each entry maps variable names to values; unknown data sets / values are created automatically'),
  })
  .strict();

export const scriptResultSchema = z
  .object({
    index: z.number().int().min(0).describe('0-based index of the step'),
    status: z.string().describe('Step execution status (case-sensitive)'),
    comment: z.string().optional().describe('Comment recorded on this step (HTML allowed)'),
  })
  .strict();

export const RESULT_STATUS_NOTE =
  "Default statuses: 'Not Executed', 'In Progress', 'Pass', 'Fail', 'Blocked' — case-sensitive internal names; instances may define custom ones.";

export const USER_KEY_NOTE =
  "Jira *user key* (e.g. 'JIRAUSER10000'), NOT a username or e-mail — resolve it with find_jira_user.";

/**
 * Common fields of a test execution result (§7.4), shared by test run items and result tools.
 * Deprecated API fields are intentionally not exposed: issueKey -> issueLinks,
 * executionDate -> actualEndDate, userKey -> executedBy.
 */
export const testResultFieldsShape = {
  status: z.string().optional().describe(`Execution status. ${RESULT_STATUS_NOTE}`),
  environment: z.string().optional().describe('Environment name as configured in the project (case-sensitive), e.g. "Chrome"'),
  comment: z.string().optional().describe('Comment (HTML allowed)'),
  assignedTo: z.string().optional().describe(`Assignee. ${USER_KEY_NOTE}`),
  executedBy: z.string().optional().describe(`Executor. ${USER_KEY_NOTE}`),
  executionTime: z.number().int().optional().describe('Execution duration in milliseconds'),
  actualStartDate: z.string().optional().describe('ISO 8601, e.g. 2026-07-20T14:00:00Z'),
  actualEndDate: z.string().optional().describe('ISO 8601'),
  iteration: z
    .string()
    .optional()
    .describe('Iteration name as configured in the project (case-sensitive), for runs executed in iterations'),
  version: z
    .string()
    .optional()
    .describe('Jira release version name the execution belongs to, e.g. "2026.7" (case-sensitive)'),
  customFields: customFieldsSchema().optional().describe('Custom field values keyed by field name'),
  issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
  scriptResults: z.array(scriptResultSchema).optional().describe('Per-step results (STEP_BY_STEP scripts)'),
};

/**
 * Fields shared by create_test_case / update_test_case / bulk items (§7.1).
 * `name` is required on create; update tools relax it via .partial() equivalents.
 */
export const testCaseFieldsShape = {
  name: z.string().min(1).describe('Test case name'),
  objective: z.string().optional().describe('Objective (HTML allowed)'),
  precondition: z.string().optional().describe('Precondition (HTML allowed)'),
  folder: folderPathSchema
    .describe(`Full folder path from the root starting with "/", e.g. "/Regression/Payments". ${FOLDER_MUST_EXIST_NOTE}`)
    .optional(),
  status: z
    .string()
    .optional()
    .describe("Test case status. Defaults: 'Draft', 'Approved', 'Deprecated' — case-sensitive; instances may define custom ones."),
  priority: z
    .string()
    .optional()
    .describe("Priority. Defaults: 'High', 'Normal', 'Low' — case-sensitive; instances may define custom ones."),
  component: z.string().optional().describe('Name of a Jira component of the project'),
  owner: z.string().optional().describe(`Owner. ${USER_KEY_NOTE}`),
  estimatedTime: z.number().int().optional().describe('Estimated duration in milliseconds'),
  labels: z.array(z.string()).optional().describe('Labels; the API replaces spaces with underscores'),
  issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
  customFields: customFieldsSchema().optional().describe('Custom field values keyed by field name'),
  parameters: parametersSchema
    .optional()
    .describe('Test case parameters: { variables: [{name, type: FREE_TEXT | DATA_SET, dataSet?}], entries: [{<variable>: <value>}] }'),
  testScript: testScriptSchema
    .optional()
    .describe(
      'Test script. STEP_BY_STEP: {type, steps: [{description?, testData?, expectedResult?, testCaseKey?}]}; PLAIN_TEXT/BDD: {type, text}.',
    ),
};


export const PAGINATION_NOTE =
  'Returns { startAt, maxResults, count, isLast, values }; isLast is the heuristic count < maxResults. ' +
  'Paginate with startAt (default 0) and maxResults (default 50; the API server-side default is 200).';

export const RUN_IMMUTABILITY_NOTE =
  'API v1 limitation: a test run is IMMUTABLE — there is no PUT /testrun, so it cannot be renamed, moved or have cases ' +
  'added/removed through the public API; its items are fixed at creation and the run status is derived from item statuses. ' +
  'Escape hatches: recreate_test_run_with_items (public, new key) or the internal-API tools update_test_run / ' +
  'add_test_cases_to_run / remove_test_cases_from_run (same key, require ZEPHYR_ALLOW_INTERNAL_API=true).';

/**
 * One item of a test run: the test case plus, optionally, the full execution result for it. Used by
 * create_test_run (import a run together with its results), create_test_results_bulk and the
 * internal add-items tool — all three take entries of exactly this shape.
 */
export const runItemSchema = z
  .object({
    testCaseKey: testCaseKeySchema,
    ...testResultFieldsShape,
  })
  .strict();

/**
 * Optional run-item selectors for the result tools. They are QUERY parameters (`environment`,
 * `userKey`) and must never reach the request body, where the same names mean "values to record".
 */
export const itemSelectorsShape = {
  matchEnvironment: z
    .string()
    .optional()
    .describe(
      "Run-item selector, sent as the 'environment' QUERY parameter (never in the body): targets the run item with this environment " +
        "(case-sensitive). Distinct from the 'environment' body field, which sets the environment recorded on the result.",
    ),
  matchUserKey: z
    .string()
    .optional()
    .describe(
      "Run-item selector, sent as the 'userKey' QUERY parameter (never in the body): targets the run item by its executor's Jira user " +
        "key, e.g. 'JIRAUSER10000'.",
    ),
};

/** Map the item selectors onto the query parameter names the API expects. */
export function selectorQuery(args: { matchEnvironment?: string | undefined; matchUserKey?: string | undefined }): {
  environment: string | undefined;
  userKey: string | undefined;
} {
  return { environment: args.matchEnvironment, userKey: args.matchUserKey };
}

export const startAtSchema = z.number().int().min(0).optional().describe('0-based index of the first result to return (default 0)');
export const maxResultsSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Maximum number of results to return (default 50; the API server-side default is 200)');

export const TQL_CHEATSHEET = `TQL quick reference:
- Test case fields: projectKey, key, name, status, priority, component, folder, estimatedTime, labels, owner, issueKeys + custom fields (field name in double quotes).
- Test run (cycle) fields: ONLY projectKey and folder.
- Operators: =, >, >=, <, <=, IN; the only logical connector is AND (no OR).
- Syntax is strict: spaces around operators are mandatory, string values in double quotes. Folder paths start with "/" ("/" is the root). For single/multi-choice custom fields '=' does not work — use IN.
- Examples:
  projectKey = "PROJ" AND status = "Draft" AND priority = "High"
  projectKey = "PROJ" AND folder = "/Regression/Payments"
  projectKey = "PROJ" AND labels IN ("smoke", "ui")
  projectKey = "PROJ" AND "My Field" IN ("Value")
  key IN ("PROJ-T50", "PROJ-T90")
  projectKey = "PROJ" AND issueKeys IN ("PROJ-5")`;
