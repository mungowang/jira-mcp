import { z } from 'zod';
import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

export const link = {
  jira_get_link_types: defineTool({
    readOnly: true, returns: E.linkTypes,
    desc: 'List issue link types. Use the returned `name` as the link type when linking issues',
    input: {}, run: () => jira('GET', '/issueLinkType'),
  }),

  // Jira answers 201 with an empty body, so no `returns` and no link id comes back.
  // The new link id can be read from the issue's `issuelinks` field afterwards.
  jira_link_issues: defineTool({
    desc: 'Link two issues. `type` is a link type name from jira_get_link_types. '
      + 'The response carries no id - read the issue\'s issuelinks field to get it',
    input: {
      type: z.string().describe('link type name, e.g. Blocks'),
      inwardIssue: T.issueKey.describe('the issue that the link points inward to'),
      outwardIssue: T.issueKey.describe('the issue the link points outward from'),
      comment: z.string().optional().describe('optional comment to add on the outward issue'),
    },
    run: ({ type, inwardIssue, outwardIssue, comment }) => jira('POST', '/issueLink', {
      body: {
        type: { name: type },
        inwardIssue: { key: inwardIssue },
        outwardIssue: { key: outwardIssue },
        ...(comment && { comment: { body: comment } }),
      },
    }),
  }),

  jira_delete_link: defineTool({
    destructive: true,
    desc: 'Delete an issue link by its id (find ids in the issue\'s issuelinks field)',
    input: { linkId: z.string() },
    run: ({ linkId }) => jira('DELETE', `/issueLink/${linkId}`),
  }),

  // Remote links (usually Confluence pages). GET returns an array, so no return type.
  jira_get_remote_links: defineTool({
    readOnly: true,
    desc: 'List the remote links (e.g. Confluence pages) attached to an issue',
    input: { key: T.issueKey },
    run: ({ key }) => jira('GET', `/issue/${key}/remotelink`),
  }),

  jira_create_remote_link: defineTool({
    desc: 'Attach a remote link (e.g. a Confluence page) to an issue',
    input: {
      key: T.issueKey,
      url: z.string().describe('target URL'),
      title: z.string().describe('link text shown on the issue'),
      relationship: z.string().optional().describe('e.g. "is documented by"'),
    },
    run: ({ key, url, title, relationship }) => jira('POST', `/issue/${key}/remotelink`, {
      body: { object: { url, title }, ...(relationship && { relationship }) },
    }),
  }),
};
