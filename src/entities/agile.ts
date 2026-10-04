import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

const issueKeys = z.array(z.string()).min(1).describe('issue keys, e.g. ["PROJ-1","PROJ-2"]');
const sprintId = z.number().int().positive().describe('numeric sprint id (from jira_list_sprints)');

export const agile = {
  jira_list_boards: defineTool({
    readOnly: true, returns: E.paged, desc: 'List boards',
    input: { projectKey: T.projectKey.optional() },
    run: ({ projectKey }) => jira('GET', '/rest/agile/1.0/board', { query: projectKey ? { projectKeyOrKey: projectKey } : {} }),
  }),
  jira_list_sprints: defineTool({
    readOnly: true, returns: E.paged, desc: 'List the sprints of a board',
    input: { boardId: T.boardId, state: z.enum(['future', 'active', 'closed']).optional() },
    run: ({ boardId, state }) => jira('GET', `/rest/agile/1.0/board/${boardId}/sprint`, { query: state ? { state } : {} }),
  }),
  jira_get_sprint: defineTool({
    readOnly: true, returns: E.sprint, desc: 'Get a sprint by id',
    input: { sprintId },
    run: ({ sprintId }) => jira('GET', `/rest/agile/1.0/sprint/${sprintId}`),
  }),
  jira_list_backlog: defineTool({
    readOnly: true, returns: E.agileIssues, desc: 'List the backlog of a board',
    input: { boardId: T.boardId },
    run: ({ boardId }) => jira('GET', `/rest/agile/1.0/board/${boardId}/backlog`),
  }),
  jira_get_board_issues: defineTool({
    readOnly: true, returns: E.agileIssues, desc: 'List the issues on a board',
    input: { boardId: T.boardId, jql: T.jql.optional(), maxResults: T.number.optional() },
    run: ({ boardId, jql, maxResults }) => jira('GET', `/rest/agile/1.0/board/${boardId}/issue`, {
      query: { maxResults: maxResults ?? 50, ...(jql && { jql }) },
    }),
  }),
  jira_get_sprint_issues: defineTool({
    readOnly: true, returns: E.agileIssues, desc: 'List the issues in a sprint',
    input: { sprintId, jql: T.jql.optional(), maxResults: T.number.optional() },
    run: ({ sprintId, jql, maxResults }) => jira('GET', `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      query: { maxResults: maxResults ?? 50, ...(jql && { jql }) },
    }),
  }),
  // Both of these answer 204 with an empty body, so they deliberately declare no return type.
  jira_add_issues_to_sprint: defineTool({
    desc: 'Move issues into a sprint',
    input: { sprintId, issues: issueKeys },
    run: ({ sprintId, issues }) => jira('POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, { body: { issues } }),
  }),
  jira_move_issues_to_backlog: defineTool({
    desc: 'Move issues to the backlog',
    input: { issues: issueKeys },
    run: ({ issues }) => jira('POST', '/rest/agile/1.0/backlog/issue', { body: { issues } }),
  }),
};
