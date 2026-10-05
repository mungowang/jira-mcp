import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

export const meta = {
  jira_get_fields: defineTool({
    readOnly: true, desc: 'List every field, plugin-provided ones included. Use it to obtain field ids',
    input: {}, run: () => jira('GET', '/field'),
  }),
  jira_get_issue_types: defineTool({
    readOnly: true, desc: 'List issue types', input: {}, run: () => jira('GET', '/issuetype'),
  }),
  jira_get_priorities: defineTool({
    readOnly: true, desc: 'List priorities', input: {}, run: () => jira('GET', '/priority'),
  }),
  jira_server_info: defineTool({
    readOnly: true, returns: E.serverInfo,
    desc: 'Get Jira version information (useful to confirm the Server version and deployment type)',
    input: {}, run: () => jira('GET', '/serverInfo'),
  }),
  jira_request: defineTool({
    desc: 'Raw Jira REST call. The escape hatch for plugin modules that have no dedicated tool yet',
    input: {
      method: T.httpMethod.describe('HTTP method on the Jira REST API'), path: T.restPath,
      query: T.object.describe('query string parameters as an object').optional(),
      body: z.any().optional().describe('request body for POST/PUT/PATCH; JSON-encoded'),
    },
    run: ({ method, path, query, body }) => jira(method, path, { query, body }),
  }),
};
