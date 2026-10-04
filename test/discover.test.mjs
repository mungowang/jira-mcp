import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { discoverContext, asList } from './discover.mjs';

describe('discovery chain', () => {
  const PORT = 18103;
  let mock, srv, ctx;

  before(async () => {
    mock = await startMock(PORT);
    srv = await startServer({
      JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong', ZEPHYR_ALLOW_INTERNAL_API: 'true',
    });
    ctx = await discoverContext(srv);
  });
  after(() => { srv?.stop(); mock?.server.close(); });

  test('asList tolerates both envelope shapes', () => {
    assert.deepEqual(asList([1, 2]), [1, 2]);
    assert.deepEqual(asList({ values: [1] }), [1]);
    assert.deepEqual(asList(null), []);
    assert.deepEqual(asList({ nope: 1 }), []);
  });

  test('every id a tool needs is discovered, not left for the operator', () => {
    // Each of these unlocks at least one tool that would otherwise be skipped.
    assert.ok(ctx.username, 'username');
    assert.ok(ctx.projectKey, 'projectKey');
    assert.ok(ctx.issueKey, 'issueKey');
    assert.ok(ctx.attachmentId, 'attachmentId -> jira_get_attachment_meta');
    assert.ok(ctx.serviceDeskId, 'serviceDeskId -> jira_jsm_queues');
    assert.ok(ctx.testCaseKey, 'testCaseKey -> get_test_case');
    assert.ok(ctx.testRunKey, 'testRunKey -> get_test_run');
    assert.ok(ctx.testPlanKey, 'testPlanKey -> get_test_plan');
    assert.ok(ctx.boardId, 'boardId -> jira_list_sprints');
    assert.ok(ctx.sprintId, 'sprintId -> jira_get_sprint');
  });

  test('discovery needs only read-only traffic', async () => {
    // jira_request is used for the service-desk probe; make sure it stays a GET.
    const writes = mock.log.filter((l) => !['GET', 'HEAD'].includes(l.method));
    assert.deepEqual(writes.map((l) => `${l.method} ${l.url}`), [], 'discovery must not write');
  });
});
