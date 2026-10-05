import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';
import { expand } from '../aliases.ts';
import { describeCreate, describeEdit } from '../describe.ts';

export const issue = {
  // These two discovery tools are the reason custom fields need no static mapping:
  // the field knowledge is read from Jira at call time.
  jira_describe_create: defineTool({
    readOnly: true,
    desc: 'Call before creating an issue. Returns the fields writable for this project/type, which are required, their value shapes and allowed values',
    input: { projectKey: T.projectKey, issueTypeName: T.string.describe('issue type name, e.g. Task; list them with jira_get_issue_types') },
    run: ({ projectKey, issueTypeName }) => describeCreate(projectKey, issueTypeName),
  }),

  jira_describe_edit: defineTool({
    readOnly: true,
    desc: 'Call before updating an issue. Returns the fields editable on this issue right now (already filtered by workflow/screen)',
    input: { key: T.issueKey },
    run: ({ key }) => describeEdit(key),
  }),

  jira_get_issue: defineTool({
    readOnly: true, returns: E.issue,
    desc: 'Get an issue. Returns all fields by default, custom fields included. '
      + 'Use expand to pull extra sections in the same call (e.g. changelog, renderedFields, transitions)',
    input: {
      key: T.issueKey,
      fields: T.fieldIds.optional(),
      expand: z.string().optional().describe('comma-separated, e.g. changelog,renderedFields,names,schema'),
    },
    run: ({ key, fields, expand }) => jira('GET', `/issue/${key}`, {
      query: { fields: fields?.join(',') ?? '*all', ...(expand && { expand }) },
    }),
  }),

  jira_search_issues: defineTool({
    readOnly: true, returns: E.searchResult,
    desc: 'Search issues with JQL',
    input: {
      jql: T.jql, fields: T.fieldIds.optional(),
      // Separate instances on purpose: reusing one makes the SDK emit a $ref to the first, and a
      // client that does not resolve $ref then sees no type at all for the second.
      maxResults: T.number.describe('page size (default 50)').optional(),
      startAt: T.number.describe('0-based index of the first result to return').optional(),
    },
    run: ({ jql, fields, maxResults, startAt }) => jira('GET', '/search', {
      query: { jql, maxResults: maxResults ?? 50, startAt: startAt ?? 0, ...(fields && { fields: fields.join(',') }) } }),
  }),

  jira_create_issue: defineTool({
    returns: E.createdIssue,
    desc: 'Create an issue. Call jira_describe_create first for the field template; keys may be field ids or business aliases',
    input: { fields: T.fields },
    run: ({ fields }) => jira('POST', '/issue', { body: { fields: expand(fields) } }),
  }),

  jira_update_issue: defineTool({
    desc: 'Update an issue. Call jira_describe_edit first; use `update` for add/remove on multi-value fields',
    input: {
      key: T.issueKey, fields: T.fields.optional(),
      // A record built here rather than reusing T.fields: two record params in one tool would share
      // the inner value schema and the second would be emitted as a $ref.
      update: z.record(z.string(), z.any()).describe('per-field add/remove operations, e.g. { labels: [{ add: "x" }] }; use this to change a multi-value field instead of replacing it').optional(),
    },
    run: ({ key, fields, update }) =>
      jira('PUT', `/issue/${key}`, { body: { ...(fields && { fields: expand(fields) }), ...(update && { update }) } }),
  }),

  jira_delete_issue: defineTool({
    destructive: true, desc: 'Delete an issue',
    input: { key: T.issueKey, deleteSubtasks: T.boolean.describe('also delete its subtasks (default false)').optional() },
    run: ({ key, deleteSubtasks }) => jira('DELETE', `/issue/${key}`, { query: { deleteSubtasks: deleteSubtasks ?? false } }),
  }),

  jira_assign_issue: defineTool({
    desc: 'Assign an issue',
    input: { key: T.issueKey, assignee: T.username.nullable().describe('username; null unassigns') },
    run: ({ key, assignee }) => jira('PUT', `/issue/${key}/assignee`, { body: { name: assignee } }),
  }),

  jira_get_transitions: defineTool({
    readOnly: true, returns: E.transitions,
    desc: 'List the transitions currently available for this issue',
    input: { key: T.issueKey },
    run: ({ key }) => jira('GET', `/issue/${key}/transitions`),
  }),

  jira_transition_issue: defineTool({
    desc: 'Apply a workflow transition',
    input: {
      key: T.issueKey,
      transitionId: z.string().describe('transition id, from jira_get_transitions for this issue'),
      fields: T.fields.optional(),
    },
    run: ({ key, transitionId, fields }) =>
      jira('POST', `/issue/${key}/transitions`, { body: { transition: { id: transitionId }, ...(fields && { fields: expand(fields) }) } }),
  }),
};
