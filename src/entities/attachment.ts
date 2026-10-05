import { z } from 'zod';
import { jira, jiraUpload } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const attachment = {
  jira_list_attachments: defineTool({
    readOnly: true, returns: E.attachmentList,
    desc: 'List the attachments of an issue (id and download url included)',
    input: { key: T.issueKey },
    run: ({ key }) => jira('GET', `/issue/${key}`, { query: { fields: 'attachment' } }),
  }),
  jira_get_attachment_meta: defineTool({
    readOnly: true, returns: E.attachment,
    desc: 'Get attachment metadata (filename/size/author/download url)',
    input: { id: z.string().describe('attachment id, from jira_list_attachments') },
    run: ({ id }) => jira('GET', `/attachment/${id}`),
  }),
  jira_upload_attachment: defineTool({
    desc: 'Upload a local file as an issue attachment (multipart)',
    input: { key: T.issueKey, filePath: z.string().describe('absolute path to a local file') },
    run: async ({ key, filePath }) => {
      const buf = await readFile(filePath);
      return jiraUpload(`/issue/${key}/attachments`, buf, basename(filePath));
    },
  }),
  jira_delete_attachment: defineTool({
    destructive: true, desc: 'Delete an attachment',
    input: { id: z.string().describe('attachment id, from jira_list_attachments') },
    run: ({ id }) => jira('DELETE', `/attachment/${id}`),
  }),
};
