import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { zephyrFetch, ZephyrApiError } from '../http.ts';
import {
  ENTITY_SEGMENT,
  internal,
  internalCall,
  INTERNAL_NOTE,
  resolveProjectId,
  withInternalHint,
  type EntityKind,
} from '../internal.ts';
import { FOLDER_LISTING_NOTE, projectKeySchema, RESULT_STATUS_NOTE } from '../schemas.ts';
import { defineTool, resolveProjectKey } from '../toolkit.ts';

/**
 * Project metadata the public API v1 does not expose at all (folder trees, status option sets,
 * custom field definitions) plus folder deletion. All of it is backed by the UNOFFICIAL internal
 * API, so the whole file is gated behind ZEPHYR_ALLOW_INTERNAL_API.
 */

/** Entity families the internal API addresses folder trees and custom fields by (`satisfies` keeps them in sync). */
const ENTITY_KINDS = ['test_case', 'test_plan', 'test_run'] as const satisfies readonly EntityKind[];
const entityKindSchema = z.enum(ENTITY_KINDS);

/** Option sets addressable per project, and the internal path segment of each. */
const OPTION_SEGMENT = {
  test_result: 'testresultstatus',
  test_case: 'testcasestatus',
  test_case_priority: 'testcasepriority',
} as const;

type OptionKind = keyof typeof OPTION_SEGMENT;

/**
 * Read a per-project option set. The internal paths differ between plugin versions, so the known
 * variants are tried in order and the one that answered is reported back as `source`; only a 404
 * moves on to the next variant, any other failure is surfaced immediately.
 */
async function readOptionSet(cfg: Config, projectId: number, kind: OptionKind): Promise<{ source: string; values: unknown }> {
  const segment = OPTION_SEGMENT[kind];
  const candidates: Array<{ path: string; query?: Record<string, string | number> }> = [
    { path: internal(`/project/${projectId}/${segment}`) },
    { path: internal(`/${segment}`), query: { projectId } },
  ];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return { source: candidate.path, values: await zephyrFetch(cfg, { method: 'GET', path: candidate.path, query: candidate.query }) };
    } catch (err) {
      if (!(err instanceof ZephyrApiError) || err.status !== 404) throw err;
      lastErr = err;
    }
  }
  throw withInternalHint(
    lastErr,
    'None of the known internal endpoint variants exist on this Zephyr Scale version. The names can still be looked up in the UI: Project settings → Zephyr Scale → Statuses.',
  );
}

/** Statuses in which the response judges the REQUEST — it is the plugin answering, about this call. */
const REQUEST_LEVEL_STATUSES = new Set([400, 401, 403, 404]);

/**
 * Does this failure say anything about the ENDPOINT, as opposed to about the id or the caller?
 *
 * delete_folder used to append the blanket internal-API trailer ("an error here usually means the
 * endpoint differs or is absent on this Zephyr Scale version") to every failure. On a 404 that
 * contradicted the tool's own hint one line above it — and reality: folder deletion works on the
 * reference build, where the 404 came from an id that had been cascade-deleted with its parent. The
 * trailer is therefore kept only where the response really is evidence about the endpoint: a 405,
 * Jira's own HTML 404 page (nothing is mounted on that path at all), a 5xx, and transport failures.
 */
function saysSomethingAboutTheEndpoint(err: unknown): boolean {
  if (!(err instanceof ZephyrApiError)) return true; // network / unexpected failure: nothing better to offer
  if (err.status === 404 && err.htmlBody) return true;
  return !REQUEST_LEVEL_STATUSES.has(err.status);
}

const FOLDER_DELETE_405_HINT =
  'A 405 here means folder deletion does not exist on this Zephyr Scale version — delete the folder in the Jira UI instead.';

export function registerInternalRefsTools(server: McpServer, cfg: Config): void {
  if (!cfg.allowInternalApi) return;

  defineTool(server, cfg, {
    name: 'get_folder_tree',
    description:
      `${INTERNAL_NOTE} List the complete folder tree of a project ` +
      '(GET /rest/api/2/project/{projectKey} for the numeric project id, then GET /project/{id}/foldertree/{testcase|testplan|testrun}) — ' +
      'the public API v1 cannot list folders at all. Each entity type has its OWN tree: test case folders are not test run folders, ' +
      'so a path that exists for one entity type may not exist for another. ' +
      'entity is OPTIONAL and defaults to test_case, so a call that omits it — or that misspells the parameter name, which MCP ' +
      'clients drop silently — returns the TEST CASE tree without saying so. ' +
      'Returns the raw tree: nested folders carrying the numeric ids that rename_folder, delete_folder and update_test_run need, ' +
      'plus their item counts. itemsCount is CUMULATIVE — a folder counts its own entities PLUS every descendant\'s — while a TQL ' +
      '`folder = "/path"` filter matches that path EXACTLY, so the two numbers agree only for leaf folders. The ROOT node\'s ' +
      'itemsCount is the project-wide total for that entity type, not the number of entities sitting outside any folder.',
    inputSchema: {
      projectKey: projectKeySchema,
      entity: entityKindSchema.optional().describe('Which entity type\'s folder tree to read: test_case (default), test_plan or test_run'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const projectId = await resolveProjectId(cfg, resolveProjectKey(cfg, args.projectKey));
      return internalCall(() =>
        zephyrFetch(cfg, {
          method: 'GET',
          path: internal(`/project/${projectId}/foldertree/${ENTITY_SEGMENT[args.entity ?? 'test_case']}`),
        }),
      );
    },
  });

  defineTool(server, cfg, {
    name: 'get_status_options',
    description:
      `${INTERNAL_NOTE} List the EXACT internal names of a project's execution statuses, test case statuses or test case ` +
      'priorities (GET /rest/api/2/project/{projectKey}, then GET /project/{id}/testresultstatus | testcasestatus | testcasepriority, ' +
      'falling back to GET /{segment}?projectId={id} on older builds). The public API v1 has no such endpoint, so this is the only ' +
      'way to discover the values create_test_result, update_last_test_result, update_test_result_by_id and create_test_case need. ' +
      'On the reference build an unknown execution status is REJECTED with 400 "The value <x> was not found for field status on ' +
      'project <KEY>" (verified live on POST /testresult and on create_test_run items[]); other builds are reported to ignore it ' +
      `silently and write nothing. Names must be passed verbatim — they are case-sensitive. ${RESULT_STATUS_NOTE} ` +
      'optionSet defaults to test_result, so a call that omits it — or that misspells the parameter name, which MCP clients drop ' +
      'silently — returns EXECUTION statuses, not test case statuses: check the returned `source` before trusting the list. ' +
      'There is NO option set for test PLAN statuses: the plan statuses create_test_plan/update_test_plan accept cannot be ' +
      "discovered here (the test case set is a different set and the API rejects its values for a plan's status). " +
      'When every known endpoint variant 404s the error points to the UI instead (Project settings → Zephyr Scale → Statuses). ' +
      'Returns { source, values }: the endpoint path that answered, and the raw option list ([{ id, name, … }]).',
    inputSchema: {
      projectKey: projectKeySchema,
      optionSet: z
        .enum(['test_result', 'test_case', 'test_case_priority'])
        .optional()
        .describe(
          'Which option set to read: test_result (execution statuses, the default), test_case (test case statuses) or ' +
            'test_case_priority (test case priorities). Not an entity type — priorities are a separate option set.',
        ),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const projectId = await resolveProjectId(cfg, resolveProjectKey(cfg, args.projectKey));
      return readOptionSet(cfg, projectId, args.optionSet ?? 'test_result');
    },
  });

  defineTool(server, cfg, {
    name: 'get_custom_field_definitions',
    description:
      `${INTERNAL_NOTE} List the custom field DEFINITIONS of a project — names, types, required flags and allowed options ` +
      '(GET /rest/api/2/project/{projectKey}, then GET /project/{id}/customfields/{testcase|testplan|testrun}) — so the customFields ' +
      'parameter of the create/update tools can be filled with valid keys and values. The public API v1 has no such endpoint. ' +
      'Custom fields are defined per entity type, and customFields is keyed by the field NAME, not by its numeric id. ' +
      'entity is OPTIONAL and defaults to test_case, so a call that omits it — or that misspells the parameter name, which MCP ' +
      'clients drop silently — describes TEST CASE fields without saying so. ' +
      'Returns the raw definition list; an empty array means the project defines no custom fields for that entity type, and ' +
      'every customFields key is then rejected with 400 "The custom field <name> was not found."',
    inputSchema: {
      projectKey: projectKeySchema,
      entity: entityKindSchema.optional().describe('Which entity type the custom fields belong to: test_case (default), test_plan or test_run'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const projectId = await resolveProjectId(cfg, resolveProjectKey(cfg, args.projectKey));
      return internalCall(() =>
        zephyrFetch(cfg, {
          method: 'GET',
          path: internal(`/project/${projectId}/customfields/${ENTITY_SEGMENT[args.entity ?? 'test_case']}`),
        }),
      );
    },
  });

  defineTool(server, cfg, {
    name: 'delete_folder',
    description:
      `${INTERNAL_NOTE} Permanently delete a Zephyr Scale folder by its numeric id (DELETE /folder/{id}) — ` +
      'the public API v1 cannot delete folders at all. CANNOT BE UNDONE. ' +
      'CAUTION: what happens to a NON-empty folder is version-specific (its contents may be deleted or orphaned). Verified live on ' +
      'the reference build: CHILD FOLDERS are deleted with it (the whole subtree goes, and their ids then answer 404), while the ' +
      'test cases, plans and runs inside SURVIVE and are silently moved to the project root — they keep their keys and lose the ' +
      '`folder` field entirely (it is absent, not "/"), so TQL folder = "/" finds them again. Other versions may delete them, so ' +
      'move the test entities out first (e.g. update_test_case with another folder) and prefer folders that get_folder_tree reports with ' +
      `itemsCount 0 and no children. ${FOLDER_LISTING_NOTE} ` +
      'A 405 means the endpoint is absent on this build and folders can then only be deleted in the Jira UI. A 404 means the id is ' +
      'wrong, already deleted, or was destroyed together with its parent — it is NOT evidence that folder deletion is unsupported. ' +
      'Not idempotent: deleting the same id twice answers 404 the second time. ' +
      'Returns { deleted: true, id }.',
    inputSchema: {
      folderId: z
        .number()
        .int()
        .positive()
        .describe('Numeric folder id from create_folder or get_folder_tree (the API cannot resolve a folder by path)'),
    },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      try {
        await zephyrFetch(cfg, { method: 'DELETE', path: internal(`/folder/${args.folderId}`) });
      } catch (err) {
        // Only a 405 says the endpoint itself is missing. A 404 is almost always a wrong, already
        // deleted or cascade-deleted id — found live, where a folder deleted with its parent then
        // produced this 404 and the old blanket trailer sent the user to the Jira UI for an
        // operation that had just succeeded over the API. The shared 404/403 hints already name the
        // right cause, so a rejection of THIS REQUEST gets no version talk appended at all.
        if (err instanceof ZephyrApiError && err.status === 405) throw withInternalHint(err, FOLDER_DELETE_405_HINT);
        throw saysSomethingAboutTheEndpoint(err) ? withInternalHint(err) : err;
      }
      return { deleted: true, id: args.folderId };
    },
  });
}
