import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';

/**
 * ZEPHYR_OUTPUT_CHECKS=1 must be observation only: it reports what each Zephyr payload would have
 * to satisfy, and changes nothing about the call. That property is what makes it safe to run
 * against a real instance before deciding which tools may declare an outputSchema.
 */
const PORT = 18095;
const ENV = {
  JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
  JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong',
  ZEPHYR_ALLOW_INTERNAL_API: 'true', ZEPHYR_DEFAULT_PROJECT_KEY: 'PROJ',
};

let mock;
before(async () => { mock = await startMock(PORT); });
after(() => { mock?.server.close(); });

/** stderr lines the probe produced, in order. */
const probe = async () => {
  const srv = await startServer({ ...ENV, ZEPHYR_OUTPUT_CHECKS: '1' });
  try {
    const results = {};
    for (const [tool, args] of [
      ['get_test_case', { testCaseKey: 'PROJ-T1' }],
      ['search_test_cases', { query: 'projectKey = "PROJ"' }],
      ['get_test_run_summary', { testRunKey: 'PROJ-R1' }],
      ['get_custom_field_definitions', { projectKey: 'PROJ' }],
      ['jira_get_issue', { key: 'PROJ-1' }],
    ]) {
      const r = await srv.callTool(tool, args);
      results[tool] = r;
    }
    return { lines: srv.stderr().split('\n').filter((l) => l.startsWith('[zephyr-output]')), results };
  } finally {
    srv.stop();
  }
};

describe('zephyr output checks (observation mode)', () => {
  let lines, results;
  before(async () => { ({ lines, results } = await probe()); });

  test('the observed tools are reported, and the calls still succeed', () => {
    assert.ok(lines.length >= 4, `expected several checks, got ${lines.length}:\n${lines.join('\n')}`);
    for (const t of ['get_test_case', 'search_test_cases', 'get_test_run_summary', 'get_custom_field_definitions']) {
      assert.ok(lines.some((l) => l.includes(t)), `${t} was not reported`);
      assert.equal(results[t].ok, true, `${t} must still succeed`);
    }
  });

  test('it reports the entity each payload would have to satisfy', () => {
    assert.ok(lines.some((l) => /get_test_case -> E\.testCase/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /search_test_cases -> E\.zephyrPage/.test(l)), lines.join('\n'));
  });

  test('an array payload is reported as an array, not as a failure of the tool', () => {
    const line = lines.find((l) => l.includes('get_custom_field_definitions'));
    assert.match(line, /E\.customFieldDefinition/);
    assert.match(line, /array\(\d+ items\)/, line);
  });

  test('a core (non-Zephyr) tool is not observed - this is the Zephyr contract only', () => {
    assert.ok(!lines.some((l) => l.includes('jira_get_issue')), lines.join('\n'));
  });

  test('with the flag off nothing is reported and nothing changes', async () => {
    const srv = await startServer(ENV);
    try {
      const r = await srv.callTool('get_test_case', { testCaseKey: 'PROJ-T1' });
      assert.equal(r.ok, true);
      assert.deepEqual(srv.stderr().split('\n').filter((l) => l.startsWith('[zephyr-output]')), []);
    } finally {
      srv.stop();
    }
  });
});
