import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { renderResult } from '../src/tool.ts';
import { E, ENTITY_NAMES } from '../src/entity-types.ts';

describe('empty responses (204)', () => {
  test('renderResult never yields undefined (that would fail MCP result validation)', () => {
    assert.equal(renderResult(undefined), 'ok');
    assert.equal(renderResult(null), 'ok');
    assert.equal(typeof renderResult(undefined), 'string');
  });

  test('a real 204 call succeeds instead of raising a protocol error', async () => {
    const srv204 = http.createServer((req, res) => { res.writeHead(204); res.end(); });
    await new Promise((ok) => srv204.listen(18096, ok));
    const s = await startServer({
      JIRA_BASE_URL: 'http://127.0.0.1:18096', JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'a', JIRA_PASSWORD: 's3cretlong',
    });
    try {
      const r = await s.callTool('jira_delete_comment', { key: 'PROJ-1', commentId: '5' });
      assert.equal(r.ok, true, r.text);
      assert.equal(r.text.trim(), 'ok');
      const t = await s.callTool('jira_update_issue', { key: 'PROJ-1', fields: { summary: 'x' } });
      assert.equal(t.ok, true, t.text);
    } finally { s.stop(); srv204.close(); }
  });
});

describe('return type declarations', () => {
  const PORT = 18097;
  const ENV = { JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic', JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong' };
  let mock, srv, tools;
  before(async () => {
    mock = await startMock(PORT);
    srv = await startServer(ENV);
    tools = await srv.listTools();
  });
  after(() => { srv?.stop(); mock?.server.close(); });

  test('the entity registry covers issue / comment / testcase', () => {
    for (const n of ['issue', 'comment', 'worklogs', 'attachment', 'project', 'user', 'serverInfo', 'paged', 'linkTypes', 'watchers', 'testCase', 'testRun', 'testResult']) {
      assert.ok(ENTITY_NAMES.includes(n), `missing entity type ${n}`);
    }
  });

  test('outputSchema shows up in tools/list as an open envelope', () => {
    const get = tools.find((t) => t.name === 'jira_get_issue');
    assert.ok(get.outputSchema, 'jira_get_issue should carry an outputSchema');
    assert.equal(get.outputSchema.type, 'object');
    assert.deepEqual(get.outputSchema.required, ['id', 'key', 'fields']);
    assert.equal(get.outputSchema.additionalProperties, true, 'undeclared fields must pass (Jira varies per instance)');
    assert.match(JSON.stringify(get.outputSchema), /customfield_xxxxx/);
  });

  test('tools with an outputSchema return structuredContent', async () => {
    const r = await srv.callTool('jira_get_issue', { key: 'PROJ-1' });
    assert.equal(r.ok, true, r.text);
    assert.ok(r.structuredContent, 'structuredContent is present');
    assert.equal(r.structuredContent.key, 'PROJ-1');
  });

  test('204-style tools declare no outputSchema (an empty body would violate it)', () => {
    for (const n of ['jira_delete_comment', 'jira_delete_issue', 'jira_update_issue', 'jira_transition_issue', 'jira_delete_worklog', 'jira_delete_attachment', 'jira_assign_issue']) {
      const t = tools.find((x) => x.name === n);
      assert.equal(t?.outputSchema, undefined, `${n} must not declare an outputSchema`);
    }
  });

  test('a JSON-declared plugin tool declares an output schema like any other', () => {
    // The DSL mirrors the code path: `returns` in tools.d/ produces outputSchema +
    // structuredContent, so plugin tools are not second-class.
    const jsm = tools.find((t) => t.name === 'jira_jsm_queues');
    assert.ok(jsm?.outputSchema, 'jira_jsm_queues is declared in tools.d/ and declares paged');
    assert.deepEqual(jsm.outputSchema.required, ['values']);
  });

  test('a JSON-declared tool returns structuredContent', async () => {
    const r = await srv.callTool('jira_jsm_queues', { serviceDeskId: '5' });
    assert.equal(r.ok, true, r.text);
    assert.ok(r.structuredContent, 'structuredContent is present');
  });

  test('anyObject accepts any object, which is the honest plugin escape hatch', () => {
    assert.equal(E.anyObject.safeParse({ anything: [1, 2, { nested: true }] }).success, true);
    assert.equal(E.anyObject.safeParse([1, 2]).success, false, 'the root must still be an object');
    assert.equal(E.anyObject.safeParse('text').success, false);
  });

  test('array-root tools declare no outputSchema (MCP requires an object root)', () => {
    for (const n of ['jira_list_projects', 'jira_get_fields', 'jira_search_users', 'jira_get_components']) {
      const t = tools.find((x) => x.name === n);
      assert.equal(t?.outputSchema, undefined, `${n} returns an array root and must not declare one`);
    }
  });

  test('envelopes that no real instance has exercised require nothing', () => {
    // The rule that came out of the first real run: a required key the server does not send
    // turns a working call into an MCP output-validation error. jira_get_attachment_meta failed
    // on a real 8.5.7 instance for exactly this reason, so unverified envelopes document their
    // properties but require none of them.
    for (const name of ['attachment', 'attachmentList', 'createdIssue', 'comment', 'worklog']) {
      const schema = E[name];
      assert.equal(schema.safeParse({}).success, true, `${name} must accept an arbitrary object`);
    }
  });

  test('jira_get_attachment_meta survives a response missing the assumed keys', async () => {
    // Stands in for the real instance's answer, which did not match what this project assumed.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ self: 'http://x/rest/api/2/attachment/5' }));
    });
    await new Promise((ok) => server.listen(18104, ok));
    const s = await startServer({
      JIRA_BASE_URL: 'http://127.0.0.1:18104', JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'a', JIRA_PASSWORD: 's3cretlong',
    });
    try {
      const r = await s.callTool('jira_get_attachment_meta', { id: '5' });
      assert.equal(r.ok, true, r.text);
    } finally { s.stop(); server.close(); }
  });

  test('entity schemas accept realistic payloads but reject obviously wrong ones', () => {
    assert.equal(E.issue.safeParse({ id: '1', key: 'PROJ-1', fields: {}, someFutureField: 1 }).success, true);
    assert.equal(E.issue.safeParse({ key: 'PROJ-1' }).success, false, 'missing id/fields must be rejected');
    assert.equal(E.searchResult.safeParse({ startAt: 0, maxResults: 50, total: 3, issues: [], extra: true }).success, true);
  });
});
