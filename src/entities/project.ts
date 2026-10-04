import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { T } from '../types.ts';
import { E } from '../entity-types.ts';

export const project = {
  jira_list_projects: defineTool({ readOnly: true, desc: 'List projects', input: {}, run: () => jira('GET', '/project') }),
  jira_get_project: defineTool({
    readOnly: true, returns: E.project, desc: 'Get project details',
    input: { key: T.projectKey },
    run: ({ key }) => jira('GET', `/project/${key}`),
  }),
  jira_get_components: defineTool({
    readOnly: true, desc: 'List the components of a project',
    input: { key: T.projectKey },
    run: ({ key }) => jira('GET', `/project/${key}/components`),
  }),
  jira_get_versions: defineTool({
    readOnly: true, desc: 'List the versions of a project',
    input: { key: T.projectKey },
    run: ({ key }) => jira('GET', `/project/${key}/versions`),
  }),
  jira_get_statuses: defineTool({
    readOnly: true, desc: 'List the statuses of a project',
    input: { key: T.projectKey },
    run: ({ key }) => jira('GET', `/project/${key}/statuses`),
  }),
};
