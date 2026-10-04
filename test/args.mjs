/**
 * Argument synthesis for the read-only sweep.
 *
 * Invariant: an entry returns `undefined` (meaning "skip this tool") whenever a value it needs
 * was not discovered. It must never synthesise a placeholder - `attachmentId: 0` built from a
 * missing id produced an input-validation error on a real run, which reads as a broken tool
 * rather than a tool that could not be exercised.
 *
 * `test/contract.test.mjs` enforces this by sweeping every read-only tool with an empty context
 * and asserting that nothing invalid is produced.
 */
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** Build args only when every required discovered value is present. */
const need = (values, build) => {
  const list = Array.isArray(values) ? values : [values];
  if (list.some((v) => v === null || v === undefined || v === '')) return undefined;
  return build(...list);
};

const out = (prefix) => resolve(tmpdir(), `mcp-verify-${prefix}-${Date.now()}`);

export function argsFor(name, c) {
  const M = {
    // -- issue / comment / worklog / attachment ---------------------------------
    jira_get_issue: need(c.issueKey, (key) => ({ key })),
    jira_search_issues: need(c.jql ?? 'order by created DESC', (jql) => ({ jql, maxResults: 1 })),
    jira_describe_create: need([c.projectKey, c.issueTypeName ?? 'Task'],
      (projectKey, issueTypeName) => ({ projectKey, issueTypeName })),
    jira_describe_edit: need(c.issueKey, (key) => ({ key })),
    jira_get_transitions: need(c.issueKey, (key) => ({ key })),
    jira_list_comments: need(c.issueKey, (key) => ({ key })),
    jira_list_worklogs: need(c.issueKey, (key) => ({ key })),
    jira_list_attachments: need(c.issueKey, (key) => ({ key })),
    jira_get_attachment_meta: need(c.attachmentId, (id) => ({ id: String(id) })),

    // -- project / user / meta --------------------------------------------------
    jira_list_projects: {},
    jira_get_project: need(c.projectKey, (key) => ({ key })),
    jira_get_components: need(c.projectKey, (key) => ({ key })),
    jira_get_versions: need(c.projectKey, (key) => ({ key })),
    jira_get_statuses: need(c.projectKey, (key) => ({ key })),
    jira_get_current_user: {},
    jira_get_user: need(c.username, (username) => ({ username })),
    jira_search_users: need(c.username, (query) => ({ query })),
    jira_search_assignable: need(c.issueKey, (key) => ({ key })),
    jira_get_fields: {},
    jira_get_issue_types: {},
    jira_get_priorities: {},
    jira_get_link_types: {},
    jira_server_info: {},
    jira_list_plugins: {},

    // -- link / watcher / agile -------------------------------------------------
    jira_get_remote_links: need(c.issueKey, (key) => ({ key })),
    jira_get_watchers: need(c.issueKey, (key) => ({ key })),
    jira_list_boards: {},
    jira_list_sprints: need(c.boardId, (boardId) => ({ boardId })),
    jira_get_sprint: need(c.sprintId, (sprintId) => ({ sprintId })),
    jira_list_backlog: need(c.boardId, (boardId) => ({ boardId })),
    jira_get_board_issues: need(c.boardId, (boardId) => ({ boardId })),
    jira_get_sprint_issues: need(c.sprintId, (sprintId) => ({ sprintId })),

    // -- declared plugin examples ----------------------------------------------
    jira_jsm_queues: need(c.serviceDeskId, (serviceDeskId) => ({ serviceDeskId })),
    // jira_request / jira_scriptrunner_run are escape hatches and are not auto-verified.

    // -- Zephyr Scale -----------------------------------------------------------
    health_check: {},
    get_test_case: need(c.testCaseKey, (testCaseKey) => ({ testCaseKey })),
    search_test_cases: need(c.projectKey, (projectKey) => ({ query: `projectKey = "${projectKey}"`, maxResults: 1 })),
    search_test_runs: need(c.projectKey, (projectKey) => ({ query: `projectKey = "${projectKey}"`, maxResults: 1 })),
    search_test_plans: need(c.projectKey, (projectKey) => ({ query: `projectKey = "${projectKey}"`, maxResults: 1 })),
    get_test_cases_linked_to_issue: need(c.issueKey, (issueKey) => ({ issueKey })),
    get_issue_test_coverage: need(c.issueKey, (issueKey) => ({ issueKey, maxCases: 1 })),
    get_test_run: need(c.testRunKey, (testRunKey) => ({ testRunKey })),
    get_test_run_results: need(c.testRunKey, (testRunKey) => ({ testRunKey, maxResults: 1 })),
    get_test_run_summary: need(c.testRunKey, (testRunKey) => ({ testRunKey })),
    get_latest_result_for_test_case: need(c.testCaseKey, (testCaseKey) => ({ testCaseKey })),
    get_test_plan: need(c.testPlanKey, (testPlanKey) => ({ testPlanKey })),
    get_folder_tree: need(c.projectKey, (projectKey) => ({ projectKey, entity: 'test_case' })),
    get_status_options: need(c.projectKey, (projectKey) => ({ projectKey, optionSet: 'test_result' })),
    get_custom_field_definitions: need(c.projectKey, (projectKey) => ({ projectKey, entity: 'test_case' })),
    list_environments: need(c.projectKey, (projectKey) => ({ projectKey })),
    list_attachments: need(c.testCaseKey, (testCaseKey) => ({ target: 'test_case', testCaseKey })),
    // Zephyr addresses attachments by ITS OWN id or url; a Jira attachment id is a 404 there.
    download_attachment: (() => {
      if (Number.isFinite(c.zephyrAttachmentId) && c.zephyrAttachmentId > 0) {
        return { attachmentId: c.zephyrAttachmentId, outputPath: out('zatt') };
      }
      if (typeof c.zephyrAttachmentUrl === 'string' && c.zephyrAttachmentUrl) {
        return { url: c.zephyrAttachmentUrl, outputPath: out('zatt') };
      }
      return undefined;
    })(),
    // download_feature_files pulls an archive and is deliberately left to a manual run.
    find_jira_user: need(c.username, (query) => ({ query })),
  };
  return M[name];
}
