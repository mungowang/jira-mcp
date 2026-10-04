import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

export const watcher = {
  jira_get_watchers: defineTool({
    readOnly: true, returns: E.watchers,
    desc: 'List the watchers of an issue, and whether the authenticated user is watching',
    input: { key: T.issueKey },
    run: ({ key }) => jira('GET', `/issue/${key}/watchers`),
  }),

  // Jira takes the username as a bare JSON string in the body, and answers 204.
  jira_add_watcher: defineTool({
    desc: 'Add a user as a watcher of an issue',
    input: { key: T.issueKey, username: T.username },
    run: ({ key, username }) => jira('POST', `/issue/${key}/watchers`, { body: username }),
  }),

  jira_remove_watcher: defineTool({
    destructive: true,
    desc: 'Remove a user from the watchers of an issue',
    input: { key: T.issueKey, username: T.username },
    run: ({ key, username }) => jira('DELETE', `/issue/${key}/watchers`, { query: { username } }),
  }),
};
