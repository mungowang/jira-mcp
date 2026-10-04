/**
 * Discovery phase for the live verification run.
 *
 * Extracted from live-verify.mjs so it can be tested: without real ids, most tools can only
 * be skipped, and a silent regression here would quietly shrink the verified surface.
 */
export const parse = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

/** Jira answers a bare array from some endpoints and {values:[]} from others. */
export const asList = (v) => (Array.isArray(v) ? v : Array.isArray(v?.values) ? v.values : []);

export async function discoverContext(srv, log = () => {}) {
  const ctx = {
    projectKey: null, issueKey: null, username: null, boardId: null, sprintId: null,
    attachmentId: null, zephyrAttachmentId: null, zephyrAttachmentUrl: null, serviceDeskId: null,
    testCaseKey: null, testRunKey: null, testPlanKey: null, testResultId: null,
    issueTypeName: 'Task',
  };

  const me = parse(await srv.callTool('jira_get_current_user', {})) ?? {};
  ctx.username = me.name ?? me.key ?? null;
  log(`  ${ctx.username ? 'ok' : '-'} current user ${ctx.username ?? '?'}`);

  const projects = asList(parse(await srv.callTool('jira_list_projects', {})));
  if (projects.length) {
    ctx.projectKey = projects[0].key;
    log(`  ok ${projects.length} project(s), using ${ctx.projectKey}`);
  } else {
    log('  x could not list projects');
  }

  const issues = parse(await srv.callTool('jira_search_issues', { jql: 'order by created DESC', maxResults: 1 }))?.issues ?? [];
  if (issues.length) {
    ctx.issueKey = issues[0].key;
    log(`  ok found issue ${ctx.issueKey}`);
  } else {
    log('  x could not find an issue (JQL failed or no browse permission)');
  }

  if (ctx.issueKey) {
    const attachments = parse(await srv.callTool('jira_list_attachments', { key: ctx.issueKey }));
    const first = attachments?.fields?.attachment?.[0];
    if (first?.id) { ctx.attachmentId = first.id; log(`  ok found attachment ${ctx.attachmentId}`); }
    else log('  - the sampled issue has no attachments');
  }

  const desks = asList(parse(await srv.callTool('jira_request', { method: 'GET', path: '/rest/servicedeskapi/servicedesk' })));
  if (desks.length) { ctx.serviceDeskId = String(desks[0].id ?? ''); log(`  ok found service desk ${ctx.serviceDeskId}`); }
  else log('  - no service desks (JSM may not be installed)');

  const keyOf = (r) => asList(parse(r)).find((x) => x && typeof x === 'object' && typeof x.key === 'string')?.key ?? null;
  if (ctx.projectKey) {
    const tql = `projectKey = "${ctx.projectKey}"`;
    ctx.testCaseKey = keyOf(await srv.callTool('search_test_cases', { query: tql, maxResults: 2 }));
    ctx.testRunKey = keyOf(await srv.callTool('search_test_runs', { query: tql, maxResults: 2 }));
    ctx.testPlanKey = keyOf(await srv.callTool('search_test_plans', { query: tql, maxResults: 2 }));
    const found = [ctx.testCaseKey, ctx.testRunKey, ctx.testPlanKey].filter(Boolean).length;
    log(found ? `  ok found ${found}/3 Zephyr key(s)` : '  - no Zephyr test cases/cycles/plans in that project');
  }

  // Zephyr addresses attachments by its own numeric id / url - feeding it a Jira attachment id
  // is a 404 on /rest/tests/1.0/attachment/{id}, which is how this was found.
  // They can hang off a case, a run or a result, and the sampled case often has none (it did on
  // the real instance), so all three are tried before giving up.
  if (ctx.testRunKey) {
    const results = asList(parse(await srv.callTool('get_test_run_results', { testRunKey: ctx.testRunKey, maxResults: 1 })));
    ctx.testResultId = results.find((x) => x && typeof x === 'object' && x.id !== undefined)?.id ?? null;
  }
  const zephyrTargets = [
    ctx.testCaseKey && { target: 'test_case', testCaseKey: ctx.testCaseKey },
    ctx.testRunKey && { target: 'test_run', testRunKey: ctx.testRunKey },
    ctx.testResultId && { target: 'test_result', testResultId: ctx.testResultId },
  ].filter(Boolean);
  for (const target of zephyrTargets) {
    const list = asList(parse(await srv.callTool('list_attachments', target)));
    const first = list.find((x) => x && typeof x === 'object' && (x.id !== undefined || x.url));
    if (!first) continue;
    if (first.id !== undefined) ctx.zephyrAttachmentId = first.id;
    if (first.url) ctx.zephyrAttachmentUrl = first.url;
    log(`  ok found Zephyr attachment ${ctx.zephyrAttachmentId ?? ctx.zephyrAttachmentUrl} (${target.target})`);
    break;
  }
  if (ctx.zephyrAttachmentId === null && ctx.zephyrAttachmentUrl === null) {
    log('  - no Zephyr attachments on the sampled case/run/result');
  }

  const boards = asList(parse(await srv.callTool('jira_list_boards', {})));
  if (boards.length) {
    ctx.boardId = boards[0].id;
    log(`  ok found board ${ctx.boardId}`);
    const sprints = asList(parse(await srv.callTool('jira_list_sprints', { boardId: ctx.boardId })));
    if (sprints.length) { ctx.sprintId = sprints[0].id; log(`  ok found sprint ${ctx.sprintId}`); }
    else log('  - no sprints on that board');
  } else {
    log('  - no boards (Jira Software may not be installed)');
  }

  return ctx;
}
