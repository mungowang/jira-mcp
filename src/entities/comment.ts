import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

export const comment = {
  jira_list_comments: defineTool({
    readOnly: true, returns: E.comments, desc: 'List the comments of an issue',
    input: { key: T.issueKey },
    run: ({ key }) => jira('GET', `/issue/${key}/comment`),
  }),
  jira_add_comment: defineTool({
    returns: E.comment,
    desc: 'Add a comment (Server takes wiki markup, not Markdown)',
    input: { key: T.issueKey, body: z.string() },
    run: ({ key, body }) => jira('POST', `/issue/${key}/comment`, { body: { body } }),
  }),
  jira_update_comment: defineTool({
    returns: E.comment, desc: 'Update a comment',
    input: { key: T.issueKey, commentId: z.string(), body: z.string() },
    run: ({ key, commentId, body }) => jira('PUT', `/issue/${key}/comment/${commentId}`, { body: { body } }),
  }),
  jira_delete_comment: defineTool({
    destructive: true, desc: 'Delete a comment',
    input: { key: T.issueKey, commentId: z.string() },
    run: ({ key, commentId }) => jira('DELETE', `/issue/${key}/comment/${commentId}`),
  }),
};
