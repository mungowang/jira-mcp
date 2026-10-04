import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

export const user = {
  jira_get_current_user: defineTool({
    readOnly: true, returns: E.user, desc: 'Get the authenticated user', input: {},
    run: () => jira('GET', '/myself'),
  }),
  jira_get_user: defineTool({
    readOnly: true, returns: E.user, desc: 'Get a user by username',
    input: { username: T.username },
    run: ({ username }) => jira('GET', '/user', { query: { username } }),
  }),
  jira_search_users: defineTool({
    readOnly: true, desc: 'Search users (Server matches on username, not accountId)',
    input: { query: z.string(), maxResults: T.number.optional() },
    run: ({ query, maxResults }) => jira('GET', '/user/search', { query: { username: query, maxResults: maxResults ?? 20 } }),
  }),
  jira_search_assignable: defineTool({
    readOnly: true, desc: 'Search users assignable to an issue',
    input: { key: T.issueKey, query: z.string().optional() },
    run: ({ key, query }) => jira('GET', '/user/assignable/search', { query: { issueKey: key, username: query ?? '' } }),
  }),
};
