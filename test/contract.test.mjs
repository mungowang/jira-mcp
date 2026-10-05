import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, isReadOnly } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { argsFor } from './args.mjs';

const PORT = 18091;
const ENV = {
  JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
  JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong',
  ZEPHYR_ALLOW_INTERNAL_API: 'true', ZEPHYR_DEFAULT_PROJECT_KEY: 'PROJ',
};
const CTX = { projectKey: 'PROJ', issueKey: 'PROJ-1', username: 'alice', boardId: 7, issueTypeName: 'Task' };

let mock, srv, tools;
before(async () => {
  mock = await startMock(PORT);
  srv = await startServer(ENV);
  tools = await srv.listTools();
});
after(() => { srv?.stop(); mock?.server.close(); });

describe('tool surface', () => {
  test('Zephyr mounts without JIRA_AUTH, because 8.5.7 has no PAT', async () => {
    // The vendored loader defaults JIRA_AUTH to 'pat'. Every other test passes JIRA_AUTH=basic, so
    // that default was never exercised - and a user following the README (base URL + username +
    // password, the only path 8.5.7 supports) silently got 55 tools instead of 109. The default is
    // now inferred in register.ts, which keeps the vendored copy identical to upstream.
    const { JIRA_AUTH: _omitted, ...withoutAuth } = ENV;
    const bare = await startServer(withoutAuth);
    try {
      const names = (await bare.listTools()).map((t) => t.name);
      assert.ok(
        names.includes('create_test_case'),
        `Zephyr must mount without JIRA_AUTH (got ${names.length} tools)`,
      );
      assert.equal(names.filter((n) => n.startsWith('jira_')).length, 55, 'core tools unaffected');
    } finally {
      bare.stop();
    }
  });

  test('core and Zephyr share one server', () => {
    const names = tools.map((t) => t.name);
    assert.equal(names.filter((n) => n.startsWith('jira_')).length, 55, 'jira_* tool count');
    assert.ok(names.includes('create_test_case'), 'Zephyr tools are mounted');
    assert.equal(new Set(names).size, names.length, 'no duplicate names');
  });

  test('read-only and destructive annotations are complete', () => {
    const ro = tools.filter(isReadOnly);
    assert.ok(ro.length >= 45, `readOnlyHint covers ${ro.length} tools`);
    const de = tools.filter((t) => t.annotations?.destructiveHint);
    assert.ok(de.length >= 10, `destructiveHint covers ${de.length} tools`);
    assert.ok(de.every((t) => !isReadOnly(t)), 'a destructive tool must not be read-only');
  });

  test('JSON-declared plugin tools reuse registry types', () => {
    const jsm = tools.find((t) => t.name === 'jira_jsm_queues');
    assert.ok(jsm, 'jira_jsm_queues is loaded from tools.d/');
    // `numericId` comes from src/types.ts, so the registry regex reaches a JSON-declared tool.
    assert.equal(jsm.inputSchema.properties.serviceDeskId.pattern, '^\\d+$');
    assert.deepEqual(jsm.inputSchema.required, ['serviceDeskId']);
  });

  test('the tempo declaration is not enabled (its endpoint answered 405 on a real instance)', () => {
    assert.equal(tools.find((t) => t.name === 'jira_tempo_worklogs'), undefined);
  });
});

describe('field discovery (no static mapping)', () => {
  test('describe_create renders shapes, allowed values and requiredness', async () => {
    const r = await srv.callTool('jira_describe_create', CTX);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /customfield_20001\(Department\)/, 'field carries its business alias');
    assert.match(r.text, /\{"id":"\.\.\."\}/, 'option value shape');
    assert.match(r.text, /Platform\(10101\)/, 'allowed values include ids');
    assert.match(r.text, /Required/);
    assert.ok(!r.text.includes('attachment'), 'non-writable fields are filtered out');
  });

  test('describe_edit only reports fields editable on this issue', async () => {
    const r = await srv.callTool('jira_describe_edit', { key: 'PROJ-1' });
    assert.match(r.text, /customfield_20003\(Story points\)/);
    assert.match(r.text, /123/, 'number value shape');
  });
});

describe('writes', () => {
  test('aliases are translated to field ids before the request goes out', async () => {
    mock.log.length = 0;
    const r = await srv.callTool('jira_create_issue', {
      fields: { summary: 'x', Department: { id: '10101' }, 'Release date': '2026-03-01' },
    });
    assert.ok(r.ok, r.text);
    const sent = mock.log.find((l) => l.url === '/rest/api/2/issue');
    const body = JSON.parse(sent.body);
    assert.deepEqual(body.fields.customfield_20001, { id: '10101' });
    assert.equal(body.fields.customfield_20002, '2026-03-01');
    assert.ok(!('Department' in body.fields), 'aliases never reach Jira');
  });

  test('unknown fields pass through untouched (plugin fields for free)', async () => {
    mock.log.length = 0;
    await srv.callTool('jira_create_issue', { fields: { summary: 'x', customfield_99999: 'anything' } });
    const body = JSON.parse(mock.log.find((l) => l.url === '/rest/api/2/issue').body);
    assert.equal(body.fields.customfield_99999, 'anything');
  });

  test('jira_request does not double-prefix absolute REST paths', async () => {
    mock.log.length = 0;
    const r = await srv.callTool('jira_request', { method: 'POST', path: '/rest/scriptrunner/latest/custom/runJob', body: { a: 1 } });
    assert.ok(r.ok, r.text);
    assert.ok(mock.log.some((l) => l.url.startsWith('/rest/scriptrunner/')), 'plugin path passes through');
    assert.ok(!mock.log.some((l) => l.url.includes('/rest/api/2/rest/')), 'not rewritten to /rest/api/2/rest/...');
  });
});

describe('input validation', () => {
  test('a malformed issue key is rejected at the tool boundary', async () => {
    const r = await srv.callTool('jira_get_issue', { key: 'nope' });
    assert.equal(r.ok, false);
    assert.match(r.text, /PROJ-123/);
  });

  test('a missing required argument produces a readable error', async () => {
    const r = await srv.callTool('jira_jsm_queues', {});
    assert.equal(r.ok, false);
    assert.match(r.text, /serviceDeskId/);
  });
});

describe('read-only mode', () => {
  test('JIRA_READ_ONLY constrains core and Zephyr alike', async () => {
    const ro = await startServer({ ...ENV, JIRA_READ_ONLY: 'true' });
    try {
      const names = (await ro.listTools()).map((t) => t.name);
      assert.ok(names.includes('jira_get_issue'));
      assert.ok(!names.includes('jira_create_issue'), 'core write tools are filtered out');
      // Zephyr registers all tools and rejects writes at call time; assert the call result.
      const w = await ro.callTool('delete_test_case', { testCaseKey: 'PROJ-T1' });
      assert.equal(w.ok, false);
      assert.match(w.text, /read-only/i, 'Zephyr writes are refused in read-only mode');
    } finally { ro.stop(); }
  });
});

describe('sweep every read-only tool', () => {
  test('agile issue lists accept the shapes a real 8.5.7 instance returns', async () => {
    // The backlog answers with `issues`, not the `values` envelope boards use - a mock that
    // got this wrong is what let this fail on a real instance.
    const backlog = await srv.callTool('jira_list_backlog', { boardId: 7 });
    assert.ok(backlog.ok, backlog.text);
    const boardIssues = await srv.callTool('jira_get_board_issues', { boardId: 7 });
    assert.ok(boardIssues.ok, boardIssues.text);
    const sprints = await srv.callTool('jira_list_sprints', { boardId: 7 });
    assert.ok(sprints.ok, sprints.text);
  });

  test('with nothing discovered, arg synthesis skips instead of inventing placeholders', async () => {
    // Regression guard: a missing attachment id once produced `attachmentId: 0`, which surfaced
    // as an input-validation failure on a real run and looked like a broken tool.
    const offenders = [];
    for (const t of tools.filter(isReadOnly)) {
      const args = argsFor(t.name, {});
      if (args === undefined) continue;
      const r = await srv.callTool(t.name, args);
      if (/Input validation error/.test(r.text)) offenders.push(`${t.name}: ${r.text.slice(0, 140)}`);
    }
    assert.deepEqual(offenders, [], 'a tool with undiscovered inputs must be skipped, not called');
  });

  test('every read-only tool with synthesizable args runs clean', async () => {
    const ro = tools.filter(isReadOnly);
    const failures = [];
    let ran = 0;
    for (const t of ro) {
      const args = argsFor(t.name, CTX);
      if (args === undefined) continue;
      ran++;
      const r = await srv.callTool(t.name, args);
      if (!r.ok) failures.push(`${t.name}: ${r.text.split('\n')[0].slice(0, 110)}`);
    }
    assert.ok(ran >= 30, `ran ${ran} tools`);
    assert.deepEqual(failures, [], `failures:\n${failures.join('\n')}`);
  });
});
