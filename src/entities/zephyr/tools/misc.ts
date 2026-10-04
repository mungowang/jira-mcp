import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { atm, zephyrFetch, ZephyrApiError } from '../http.ts';
import { projectKeySchema } from '../schemas.ts';
import { compact, defineTool, ToolInputError } from '../toolkit.ts';

/** The subset of a Jira user we expose; `key` is what the owner / executedBy / assignedTo fields need. */
interface JiraUserSummary {
  key: unknown;
  name: unknown;
  displayName: unknown;
  emailAddress: unknown;
}

function toUserSummary(user: Record<string, unknown>): JiraUserSummary {
  return { key: user.key, name: user.name, displayName: user.displayName, emailAddress: user.emailAddress };
}

/**
 * Effective project key for the environment tools, with a BLANK argument treated as "not given".
 *
 * Found live: `projectKey: ""` is not undefined, so it never reached the ZEPHYR_DEFAULT_PROJECT_KEY
 * fallback — the tool answered "no ZEPHYR_DEFAULT_PROJECT_KEY is configured" on a server that had
 * one, i.e. it asserted something about the deployment that the empty argument had never
 * established; a whitespace-only key went the other way and was sent to Jira, whose reply then got
 * read as evidence about the plugin. Blankness is therefore resolved here, before any HTTP call, and
 * the message only ever describes the input and the setting that would supply it.
 */
function resolveEnvironmentProjectKey(cfg: Config, projectKey: string | undefined): string {
  const given = projectKey?.trim();
  const key = given !== undefined && given !== '' ? given : cfg.defaultProjectKey?.trim();
  if (key === undefined || key === '') {
    throw new ToolInputError(
      'projectKey is required: no project key was given (an empty or whitespace-only value counts as none) and no ' +
        'ZEPHYR_DEFAULT_PROJECT_KEY is configured. Pass projectKey explicitly, or set ZEPHYR_DEFAULT_PROJECT_KEY.',
    );
  }
  return key;
}

/**
 * Is the Zephyr Scale plugin answering on /rest/atm/1.0?
 *
 * A JSON API error (400/403/404 produced by the plugin itself) still proves the plugin handled the
 * request, so it counts as reachable. Only two things mean "not installed / wrong base URL": Jira's
 * generic HTML 404 page (no handler is mounted on that path) and a network-level failure.
 */
async function isZephyrPluginReachable(cfg: Config, projectKey: string): Promise<boolean> {
  try {
    const answer = await zephyrFetch(cfg, { method: 'GET', path: atm('/environments'), query: { projectKey } });
    // A 2xx is not proof either: this Jira serves its LOGIN PAGE with status 200 for an unmounted path,
    // and a body that does not parse as JSON comes back from zephyrFetch as a raw string (measured live).
    return !(typeof answer === 'string' && answer.trimStart().startsWith('<'));
  } catch (err) {
    // Reachable means THE PLUGIN answered, which it only proves by answering as an API. Everything else is
    // the container talking: an HTML page (this Jira serves its login page for an unmounted path, even with
    // 200), an XML <status> document, or a body that is not JSON at all. Only the second and third were
    // covered before, and the XML case had to be added — separating XML from HTML for the error hints had
    // quietly made this probe unable to answer false at all.
    if (err instanceof ZephyrApiError) return !(err.htmlBody || err.xmlBody);
    // A non-API failure (JSON parse error on an HTML 200, a network error) is not an answer from the plugin.
    return false;
  }
}

export function registerMiscTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'list_environments',
    description:
      'List the Zephyr Scale environments of a project (GET /environments?projectKey=…). Environments are per-project and are ' +
      'referenced BY NAME (case-sensitive) in test run items and test results, so use this to get the exact spelling. ' +
      'Returns the raw array of environment objects ([{ id, name, description }]); an empty array means the project defines none.',
    inputSchema: {
      projectKey: projectKeySchema,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'GET',
        path: atm('/environments'),
        query: { projectKey: resolveEnvironmentProjectKey(cfg, args.projectKey) },
      }),
  });

  defineTool(server, cfg, {
    name: 'create_environment',
    description:
      'Create a Zephyr Scale environment in a project (POST /environments). The name must be unique within the project — a ' +
      'duplicate is rejected with 400 — and is the string other tools use to reference the environment, so create it with the ' +
      'exact casing you intend to pass to test results. Returns the created environment object as the API sends it.',
    inputSchema: {
      projectKey: projectKeySchema,
      name: z.string().min(1).describe('Environment name, unique within the project and case-sensitive, e.g. "Chrome"'),
      description: z.string().optional().describe('Free-text description of the environment'),
    },
    annotations: {},
    handler: async (args, { cfg }) =>
      zephyrFetch(cfg, {
        method: 'POST',
        path: atm('/environments'),
        body: compact({
          projectKey: resolveEnvironmentProjectKey(cfg, args.projectKey),
          name: args.name,
          description: args.description,
        }),
      }),
  });

  defineTool(server, cfg, {
    name: 'find_jira_user',
    description:
      'Search Jira users (GET /rest/api/2/user/search). Use it to resolve the Jira USER KEY (e.g. "JIRAUSER10000") that the ' +
      'owner / executedBy / assignedTo fields of the other tools require — those fields reject usernames and e-mail addresses. ' +
      'Needs the Jira "Browse users" permission, otherwise Jira answers 403. Returns an array of ' +
      '{ key, name, displayName, emailAddress }, empty when nothing matches; emailAddress is absent when Jira hides it.',
    inputSchema: {
      query: z.string().min(1).describe('Substring matched against username, display name and e-mail, e.g. "pupkin"'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum number of users to return; when omitted Jira applies its own default (50 on Server/DC)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const users = await zephyrFetch(cfg, {
        method: 'GET',
        path: '/rest/api/2/user/search',
        query: { username: args.query, maxResults: args.maxResults },
      });
      // Some Jira configurations answer 200 with an error object instead of a list; fail loudly
      // rather than returning [] and letting the caller think the user does not exist.
      if (!Array.isArray(users)) {
        throw new Error(`Unexpected response from Jira user search (expected an array): ${JSON.stringify(users).slice(0, 300)}`);
      }
      return (users as Array<Record<string, unknown>>).map(toUserSummary);
    },
  });

  defineTool(server, cfg, {
    name: 'health_check',
    description:
      'Verify connectivity and credentials (GET /rest/api/2/myself) and, when ZEPHYR_DEFAULT_PROJECT_KEY is configured, whether ' +
      'the Zephyr Scale plugin answers on /rest/atm/1.0 (GET /environments). Any JSON error from the plugin — including 403 for a ' +
      'project without Zephyr — still counts as reachable; only Jira\'s generic HTML 404 page or a network failure counts as ' +
      'unreachable. The tool itself fails only when Jira does not answer or rejects the credentials. ' +
      'Returns { ok: true, jiraUser, baseUrl, zephyrPluginReachable } — zephyrPluginReachable is omitted when no default project key is set.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async (_args, { cfg }) => {
      const me = (await zephyrFetch(cfg, { method: 'GET', path: '/rest/api/2/myself' })) as Record<string, unknown>;
      return compact({
        ok: true,
        jiraUser: (me.name ?? me.key ?? me.displayName) as string | undefined,
        baseUrl: cfg.baseUrl,
        zephyrPluginReachable: cfg.defaultProjectKey ? await isZephyrPluginReachable(cfg, cfg.defaultProjectKey) : undefined,
      });
    },
  });
}
