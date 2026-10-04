import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { atm, zephyrFetch, ZephyrApiError } from '../http.ts';
import { customFieldsSchema, FOLDER_LISTING_NOTE, folderPathSchema, projectKeySchema } from '../schemas.ts';
import { compact, defineTool, encodePath, resolveProjectKey, ToolInputError } from '../toolkit.ts';

const folderTypeSchema = z
  .enum(['TEST_CASE', 'TEST_PLAN', 'TEST_RUN'])
  .describe('Folder kind: TEST_CASE (test case folders), TEST_PLAN (test plan folders) or TEST_RUN (test cycle folders)');

type FolderType = z.infer<typeof folderTypeSchema>;

/** Response of POST /folder — `id` is the only handle the API ever gives out for a folder. */
interface CreatedFolder {
  id?: number;
}

/** Create exactly one folder; `name` is always a full path from the root. */
async function postFolder(cfg: Config, projectKey: string, name: string, type: FolderType): Promise<CreatedFolder> {
  return (await zephyrFetch(cfg, { method: 'POST', path: atm('/folder'), body: { projectKey, name, type } })) as CreatedFolder;
}

const isBadRequest = (err: unknown): boolean => err instanceof ZephyrApiError && err.status === 400;

/** A 400 whose body says the path is already taken — there is nothing left for the parent fallback to fix. */
const isAlreadyExists = (err: unknown): boolean => err instanceof ZephyrApiError && /already exists/i.test(err.responseBody);

/**
 * Reject a path with empty or blank segments before any HTTP call.
 *
 * Found live: the API accepts "/", "/A//B" and a trailing "/" and creates a folder whose name is the
 * EMPTY string — it then shows up nameless in the folder tree and can never be addressed by path
 * again. A WHITESPACE-ONLY segment ("/A/ ") reaches the same end state by another route: it was
 * accepted live and produced folder id 9161 with the name " ", which renders blank in the Jira UI —
 * so `trim()`, not `length`, decides here. Spaces AROUND real characters stay untouched: "/A/ B " is
 * a legal (if confusing) folder and is still sent verbatim. The leading "/" is required by
 * folderPathSchema.
 */
function assertFolderPathSegments(name: string): void {
  const segments = name.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => segment.trim().length === 0)) {
    throw new ToolInputError(
      `Invalid folder path '${name}': every segment between slashes must be non-empty and not blank, and the path must have at ` +
        'least one segment. "/" alone, an empty segment ("/A//B"), a trailing "/" and a whitespace-only segment ("/A/ ") all make ' +
        'the API create a permanently NAMELESS folder (verified live), so they are rejected here — pass e.g. "/Regression/Payments". ' +
        'Spaces around a real name are still allowed and are not trimmed ("/A/ B " is a different folder from "/A/B").',
    );
  }
}

/**
 * Create every ancestor of `path` from the root: "/a/b/c" -> "/a", then "/a/b".
 *
 * A 400 on a prefix is ignored — the folder is normally already there and the API offers no way to
 * check first. Every other status propagates, so a permission problem is never swallowed.
 */
async function createAncestorFolders(cfg: Config, projectKey: string, path: string, type: FolderType): Promise<void> {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  for (let depth = 1; depth < segments.length; depth++) {
    const prefix = `/${segments.slice(0, depth).join('/')}`;
    try {
      await postFolder(cfg, projectKey, prefix, type);
    } catch (err) {
      if (!isBadRequest(err)) throw err;
    }
  }
}

export function registerFolderTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'create_folder',
    description:
      'Create a folder for test cases, test plans or test runs / test cycles (POST /folder). ' +
      'name is the FULL path from the root, not a single segment, and every segment must be non-empty and not blank — "/" alone, ' +
      '"/A//B", a trailing "/" and a whitespace-only segment ("/A/ ") are rejected before any HTTP call because the API would ' +
      'create a permanently nameless folder from them. Spaces around a real name are legal and are NOT trimmed. ' +
      'The two rules surface differently: a missing leading "/" is caught by the input schema (an MCP input-validation error), ' +
      'while empty or blank segments are caught by the tool itself (a plain "Invalid folder path ..." message). ' +
      'The other tools never create folders implicitly: create_test_case, create_test_run and create_test_plan fail with 400 on an ' +
      'unknown folder. Not idempotent: an existing path fails with 400 "The folder <path> already exists" and no retry is attempted. ' +
      'With recursive=true (the default) any OTHER 400 on the full path triggers the fallback — every parent prefix is created from ' +
      'the root and the full path is retried once; 403, 409 and 5xx propagate unchanged, so a permission problem is never ' +
      'mistaken for a missing parent. On builds where POST /folder already creates missing ancestors itself that fallback never ' +
      'fires — the reference build is one of them: a two-level-deep new path succeeds even with recursive=false, so recursive is ' +
      'effectively a no-op there. Each folder type has its own tree, so the same path must be created once per type. ' +
      `${FOLDER_LISTING_NOTE} Returns { id, name, type } — id is the id of the LAST segment only, so ancestors created along the ` +
      'way have ids this call never reports (find them with get_folder_tree).',
    inputSchema: {
      projectKey: projectKeySchema,
      name: folderPathSchema.describe(
        'Full path of the folder to create, from the root, starting with "/", e.g. "/Regression/Payments" — every segment is a folder ' +
          'level and must contain at least one non-whitespace character. Segments are stored verbatim: leading and trailing spaces are ' +
          'NOT trimmed, so "/A/ B " and "/A/B" are different folders, but a segment made only of spaces is rejected.',
      ),
      type: folderTypeSchema,
      recursive: z
        .boolean()
        .optional()
        .describe('Create missing parent folders after a 400 on the full path (default true). Client-side only — never sent to the API.'),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const projectKey = resolveProjectKey(cfg, args.projectKey);
      assertFolderPathSegments(args.name);
      let created: CreatedFolder;
      try {
        created = await postFolder(cfg, projectKey, args.name, args.type);
      } catch (err) {
        // A missing parent folder comes back as a bare 400, indistinguishable from any other bad
        // request — so 400 is the only status worth retrying after creating the ancestors, and
        // 403/409/5xx must reach the caller untouched. "already exists" is the one 400 that says the
        // fallback is pointless: creating the ancestors and retrying only repeats the same error.
        if (args.recursive === false || !isBadRequest(err) || isAlreadyExists(err)) throw err;
        await createAncestorFolders(cfg, projectKey, args.name, args.type);
        created = await postFolder(cfg, projectKey, args.name, args.type);
      }
      return { id: created.id, name: args.name, type: args.type };
    },
  });

  defineTool(server, cfg, {
    name: 'rename_folder',
    description:
      'Rename a folder and/or set its custom fields (PUT /folder/{folderId}). name replaces the name of that ONE folder segment — ' +
      'it is not a path, so it cannot move the folder to another parent, and an empty or whitespace-only name, or "/" or "\\" in it, ' +
      'is rejected before any HTTP call. ' +
      'The rename changes the full path of this folder and of every folder below it, so paths held elsewhere (the folder argument of ' +
      'create_test_case / create_test_run, TQL folder filters) must be updated afterwards. ' +
      'The API does NOT enforce sibling-name uniqueness here (verified live): renaming a folder to the name of an existing sibling ' +
      'succeeds and leaves two siblings with one name — an ambiguous path — even though create_folder rejects that same path with ' +
      '400 "already exists". ' +
      `${FOLDER_LISTING_NOTE} Returns { id, name }, where name is the new SINGLE segment — unlike create_folder, which echoes the full path.`,
    inputSchema: {
      folderId: z
        .number()
        .int()
        .min(1, 'folderId must be a positive numeric folder id')
        .describe('Numeric folder id, as returned by create_folder (the public API cannot list folders)'),
      name: z
        .string()
        .min(1, 'name must not be empty — pass the new name of this one folder segment, e.g. "Payments"')
        .regex(/^[^/\\]*$/, 'name is the new folder segment name, not a path — it must not contain "/" or "\\"')
        // A blank name renames the folder to whitespace, which renders as a nameless folder in the
        // Jira UI — the same dead end create_folder rejects for a whitespace-only path segment.
        .regex(/\S/, 'name must not be blank — a whitespace-only name renders as a NAMELESS folder in the Jira UI')
        .describe(
          'New name of this one folder — a single segment without "/" or "\\" and with at least one non-whitespace character, ' +
            'e.g. "Payments". Surrounding spaces are kept verbatim.',
        ),
      customFields: customFieldsSchema().optional().describe('Custom field values keyed by field name; omit to leave them untouched'),
    },
    annotations: { idempotentHint: true },
    handler: async (args, { cfg }) => {
      await zephyrFetch(cfg, {
        method: 'PUT',
        path: encodePath(atm('/folder'), args.folderId),
        body: compact({ name: args.name, customFields: args.customFields }),
      });
      return { id: args.folderId, name: args.name };
    },
  });
}
