/**
 * The schema dump is how a plugin author checks what a declaration actually produces, so it
 * should not rot silently.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT } from './harness.mjs';

const run = (argv = []) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [resolve(ROOT, 'scripts/dump-tools.mjs'), ...argv], {
    cwd: ROOT,
    env: { ...process.env, JIRA_BASE_URL: 'http://127.0.0.1:1', JIRA_AUTH: 'basic', JIRA_USERNAME: 'a', JIRA_PASSWORD: 'b' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolveRun({ status, stdout, stderr }));
});

describe('tools:describe', () => {
  test('lists input and output structure, and marks JSON-declared tools', async () => {
    const r = await run(['jira_jsm']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NAME/);
    assert.match(r.stdout, /jira_jsm_queues\s+json/);
    assert.match(r.stdout, /serviceDeskId\*:string/, 'required inputs are starred');
    assert.match(r.stdout, /values\*:array/, 'the declared return type is shown');
  });

  test('shows a tool with no output schema as text-only', async () => {
    const r = await run(['jira_delete_comment']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /jira_delete_comment\s+code\s+del\s+.*\s+-$/m);
  });

  test('--json emits the schemas verbatim and flags a text-only tool', async () => {
    const r = await run(['--json', 'jira_delete_comment']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /=== jira_delete_comment\s+\[code\]/);
    assert.match(r.stdout, /input : \{"type":"object"/);
    // update/delete style tools deliberately declare no output schema (204 with an empty body).
    assert.match(r.stdout, /output: \(none\)/);
  });

  test('--json shows an output schema when one is declared', async () => {
    const r = await run(['--json', 'jira_jsm']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /=== jira_jsm_queues\s+\[json\]/);
    assert.match(r.stdout, /output: \{"type":"object"/);
  });
});
