import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { atm, zephyrFetch } from '../http.ts';
import {
  customFieldsSchema,
  fieldsSchema,
  FOLDER_MUST_EXIST_NOTE,
  folderPathSchema,
  maxResultsSchema,
  PAGINATION_NOTE,
  projectKeySchema,
  startAtSchema,
  testPlanKeySchema,
  TQL_CHEATSHEET,
  USER_KEY_NOTE,
} from '../schemas.ts';
import { compact, defineTool, encodePath, fieldsParam, pageArgs, pageEnvelope, resolveProjectKey } from '../toolkit.ts';

/** Fields shared by create_test_plan / update_test_plan; `name` is required on create only. */
const testPlanFieldsShape = {
  name: z.string().min(1).describe('Test plan name'),
  objective: z.string().optional().describe('Objective (HTML allowed)'),
  folder: folderPathSchema
    .describe(`Full path of a TEST_PLAN folder from the root starting with "/", e.g. "/Releases/2026". ${FOLDER_MUST_EXIST_NOTE}`)
    .optional(),
  status: z
    .string()
    .optional()
    .describe(
      "Test plan status. Defaults: 'Draft', 'Approved', 'Deprecated' — case-sensitive; instances may define custom ones. " +
        'Plan statuses are their OWN option set: get_status_options cannot list them (it has no test_plan optionSet) and the test ' +
        'CASE statuses it returns are rejected here with 400 "The value <x> was not found for field status."',
    ),
  owner: z.string().optional().describe(`Owner. ${USER_KEY_NOTE}`),
  labels: z.array(z.string()).optional().describe('Labels; the API replaces spaces with underscores'),
  issueLinks: z.array(z.string()).optional().describe('Jira issue keys to link, e.g. ["PROJ-123"]'),
  customFields: customFieldsSchema().optional().describe('Custom field values keyed by field name'),
};

/** Every create field made optional for partial updates (name included; projectKey cannot change). */
const updatableTestPlanFieldsShape = {
  ...testPlanFieldsShape,
  name: testPlanFieldsShape.name.optional(),
};

/** Shared tail of create_test_plan / update_test_plan: the constraints a caller cannot guess. */
const TEST_PLAN_FIELD_NOTES =
  `folder must be a TEST_PLAN folder (create_folder with type TEST_PLAN) — ${FOLDER_MUST_EXIST_NOTE} ` +
  `status is a case-sensitive internal name. owner: ${USER_KEY_NOTE}`;

const testPlanPath = (testPlanKey: string): string => encodePath(atm('/testplan'), testPlanKey);

export function registerTestPlanTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_test_plan',
    description:
      `Create a test plan (POST /testplan). ${TEST_PLAN_FIELD_NOTES} ` +
      'Returns { key } (e.g. "PROJ-P123") — no UI url, because the test plan page has no stable address across Zephyr Scale versions.',
    inputSchema: {
      projectKey: projectKeySchema,
      ...testPlanFieldsShape,
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const { projectKey, ...fields } = args;
      const res = (await zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/testplan'),
        body: compact({ projectKey: resolveProjectKey(cfg, projectKey), ...fields }),
      })) as { key: string };
      return { key: res.key };
    },
  });

  defineTool(server, cfg, {
    name: 'get_test_plan',
    description:
      'Read a test plan by key (GET /testplan/{testPlanKey}). The payload embeds the linked test runs and Jira issues when the ' +
      'plan has any; narrow it with fields. Returns the test plan object as the API sends it.',
    inputSchema: {
      testPlanKey: testPlanKeySchema,
      fields: fieldsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: testPlanPath(args.testPlanKey),
        query: { fields: fieldsParam(args.fields) },
      }),
  });

  defineTool(server, cfg, {
    name: 'update_test_plan',
    description:
      'Update a test plan (PUT /testplan/{testPlanKey}). PARTIAL update: only the fields you pass are written and omitted fields ' +
      'keep their current value, so never send empty placeholders — they overwrite real data. projectKey cannot be changed. ' +
      `${TEST_PLAN_FIELD_NOTES} Returns { key }.`,
    inputSchema: {
      testPlanKey: testPlanKeySchema,
      ...updatableTestPlanFieldsShape,
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      const { testPlanKey, ...fields } = args;
      await zephyrFetch(cfg, { method: 'PUT', path: testPlanPath(testPlanKey), body: compact(fields) });
      return { key: testPlanKey };
    },
  });

  defineTool(server, cfg, {
    name: 'delete_test_plan',
    description:
      'Permanently delete a test plan (DELETE /testplan/{testPlanKey}). Irreversible — there is no trash and no undo. ' +
      'NOT idempotent and it never confirms a deletion it did not perform: an unknown, mistyped or already-deleted key answers 404 ' +
      'and this tool fails instead of returning { deleted: true } (verified live). The key is not reused afterwards — the next ' +
      'create_test_plan gets a fresh number. ' +
      'Does NOT cascade to the test runs linked to the plan (verified live): the runs survive with their names, testCaseCount and ' +
      'status intact, only the plan↔run trace links die. Delete the runs separately with delete_test_run if that is what you meant. ' +
      'Returns { deleted: true, key }.',
    inputSchema: {
      testPlanKey: testPlanKeySchema,
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, { method: 'DELETE', path: testPlanPath(args.testPlanKey) });
      return { deleted: true, key: args.testPlanKey };
    },
  });

  defineTool(server, cfg, {
    name: 'search_test_plans',
    description: `Search test plans with a TQL query (GET /testplan/search). For test plans the searchable fields include projectKey, folder, name, status, key, owner and labels (verified live) — the exact set varies by Zephyr Scale version, and an unsupported field fails with 400 "Unrecognized field: <name>".

folder matches EXACTLY: plans in a subfolder of the given path are NOT returned. A folder path that does not exist is not an error here — it comes back as an empty page (count 0), unlike search_test_cases and search_test_runs, which answer 400 for the same path.

${TQL_CHEATSHEET}

${PAGINATION_NOTE}`,
    inputSchema: {
      query: z.string().min(1).describe('TQL query, e.g. projectKey = "PROJ" AND folder = "/Releases"'),
      fields: fieldsSchema,
      startAt: startAtSchema,
      maxResults: maxResultsSchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const { startAt, maxResults } = pageArgs(args);
      const raw = await zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/testplan/search'),
        query: { query: args.query, startAt, maxResults, fields: fieldsParam(args.fields) },
      });
      return pageEnvelope(startAt, maxResults, Array.isArray(raw) ? raw : []);
    },
  });
}
