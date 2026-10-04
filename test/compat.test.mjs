import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, isReadOnly, ROOT } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { argsFor } from './args.mjs';

/**
 * Jira Server 8.5.7 only exposes REST API v2 (and the Agile 1.0 endpoints).
 * /rest/api/3 does not exist there, so hitting it would fail on every call.
 * This file is the regression guard for that promise.
 */

const readSources = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'zephyr') continue;          // vendored upstream, covered by its own tests
      out.push(...readSources(p));
    } else if (e.name.endsWith('.ts')) {
      out.push([p, readFileSync(p, 'utf8')]);
    }
  }
  return out;
};

describe('8.5.7 compatibility: no v3 endpoints', () => {
  test('no source file references /rest/api/3', () => {
    const offenders = readSources(resolve(ROOT, 'src')).filter(([, s]) => s.includes('rest/api/3'));
    assert.deepEqual(offenders.map(([p]) => p), []);
  });

  test('no tool declaration in tools.d references /rest/api/3', () => {
    const dir = resolve(ROOT, 'tools.d');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => readFileSync(resolve(dir, f), 'utf8').includes('rest/api/3'));
    assert.deepEqual(offenders, []);
  });

  test('every request a tool makes goes to a v2/agile/plugin path', async () => {
    const PORT = 18098;
    const mock = await startMock(PORT);
    const srv = await startServer({
      JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong',
      ZEPHYR_ALLOW_INTERNAL_API: 'true',
    });
    const tmpFile = resolve(ROOT, 'test', '.tmp-upload.txt');
    writeFileSync(tmpFile, 'hello');

    const WRITES = {
      jira_create_issue: { fields: { summary: 'x' } },
      jira_update_issue: { key: 'PROJ-1', fields: { summary: 'x' } },
      jira_delete_issue: { key: 'PROJ-1' },
      jira_assign_issue: { key: 'PROJ-1', assignee: 'alice' },
      jira_transition_issue: { key: 'PROJ-1', transitionId: '31' },
      jira_add_comment: { key: 'PROJ-1', body: 'x' },
      jira_update_comment: { key: 'PROJ-1', commentId: '1', body: 'x' },
      jira_delete_comment: { key: 'PROJ-1', commentId: '1' },
      jira_add_worklog: { key: 'PROJ-1', timeSpentSeconds: 60, started: '2026-01-01T09:00:00.000+0800' },
      jira_update_worklog: { key: 'PROJ-1', worklogId: '1' },
      jira_delete_worklog: { key: 'PROJ-1', worklogId: '1' },
      jira_delete_attachment: { id: '9' },
      jira_upload_attachment: { key: 'PROJ-1', filePath: tmpFile },
      jira_link_issues: { type: 'Blocks', inwardIssue: 'PROJ-1', outwardIssue: 'PROJ-2' },
      jira_delete_link: { linkId: '10000' },
      jira_add_watcher: { key: 'PROJ-1', username: 'alice' },
      jira_remove_watcher: { key: 'PROJ-1', username: 'alice' },
      jira_scriptrunner_run: { name: 'runJob', payload: { a: 1 } },
      jira_jsm_queues: { serviceDeskId: '5' },
    };

    const CTX = { projectKey: 'PROJ', issueKey: 'PROJ-1', username: 'alice', boardId: 7, issueTypeName: 'Task' };
    const tools = await srv.listTools();
    const errors = [];
    try {
      for (const t of tools) {
        const args = isReadOnly(t) ? argsFor(t.name, CTX) : WRITES[t.name];
        if (args === undefined) continue;
        const r = await srv.callTool(t.name, args);
        // Being refused by the mock is fine; what matters is where the request went.
        if (!r.ok && !/Jira |MCP error/.test(r.text)) errors.push(`${t.name}: ${r.text.slice(0, 80)}`);
      }
    } finally {
      srv.stop(); mock.server.close(); rmSync(tmpFile, { force: true });
    }

    const urls = mock.log.map((l) => l.url);
    assert.ok(urls.length > 20, `expected a meaningful number of requests, got ${urls.length}`);
    assert.deepEqual(urls.filter((u) => u.includes('/rest/api/3')), [], 'no call may target API v3');

    const PLUGIN_PREFIXES = [
      // core
      '/rest/api/2/', '/rest/agile/1.0/', '/rest/plugins/1.0/',
      // declared plugin examples
      '/rest/scriptrunner/', '/rest/tempo-timesheets/', '/rest/servicedeskapi/',
      // Zephyr Scale Server: public API v1 plus its internal API
      '/rest/atm/1.0/', '/rest/tests/1.0/',
    ];
    const stray = urls.filter((u) => !PLUGIN_PREFIXES.some((p) => u.startsWith(p)));
    assert.deepEqual(stray, [], 'every request must go to a core v2/agile or a declared plugin path');
    assert.deepEqual(errors, []);
  });
});
