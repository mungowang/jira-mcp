import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

const started = z.string().describe('start time, e.g. 2026-01-01T09:00:00.000+0800');

export const worklog = {
  jira_list_worklogs: defineTool({
    readOnly: true, returns: E.worklogs, desc: 'List the worklogs of an issue',
    input: { key: T.issueKey },
    run: ({ key }) => jira('GET', `/issue/${key}/worklog`),
  }),
  jira_add_worklog: defineTool({
    returns: E.worklog, desc: 'Log work against an issue',
    input: { key: T.issueKey, timeSpentSeconds: T.number.describe('time spent in SECONDS'), started, comment: z.string().optional().describe('optional worklog comment (wiki markup)') },
    run: ({ key, timeSpentSeconds, started, comment }) =>
      jira('POST', `/issue/${key}/worklog`, { body: { timeSpentSeconds, started, ...(comment && { comment }) } }),
  }),
  jira_update_worklog: defineTool({
    returns: E.worklog, desc: 'Update a worklog',
    input: { key: T.issueKey, worklogId: z.string().describe('worklog id, from jira_list_worklogs'), timeSpentSeconds: T.number.describe('time spent in SECONDS').optional(), started: started.optional(), comment: z.string().optional().describe('optional worklog comment (wiki markup)') },
    run: ({ key, worklogId, ...body }) => jira('PUT', `/issue/${key}/worklog/${worklogId}`, { body }),
  }),
  jira_delete_worklog: defineTool({
    destructive: true, desc: 'Delete a worklog',
    input: { key: T.issueKey, worklogId: z.string().describe('worklog id, from jira_list_worklogs') },
    run: ({ key, worklogId }) => jira('DELETE', `/issue/${key}/worklog/${worklogId}`),
  }),
};
