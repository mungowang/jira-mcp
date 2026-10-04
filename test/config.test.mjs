import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolsFromJson } from '../src/jsonTools.ts';
import { ROOT } from './harness.mjs';
import { TYPE_NAMES } from '../src/types.ts';

describe('plugin JSON validation (fail fast at startup)', () => {
  test('an unknown type name is reported with the available options', () => {
    assert.throws(
      () => toolsFromJson({ t: { desc: 'x', method: 'GET', params: { a: 'stringg' }, path: '/x/{a}' } }, 'tools.d/x.json'),
      (e) => {
        assert.match(e.message, /tools\.d\/x\.json/);
        assert.match(e.message, /stringg/);
        assert.match(e.message, /issueKey/);
        return true;
      },
    );
  });

  test('a missing desc is reported', () => {
    assert.throws(() => toolsFromJson({ t: { method: 'GET', path: '/x' } }, 'f.json'), /missing 'desc'/);
  });

  test('an invalid method is reported', () => {
    assert.throws(() => toolsFromJson({ t: { desc: 'x', method: 'FETCH', path: '/x' } }, 'f.json'), /method/);
  });

  test('a declared but unused param is reported', () => {
    assert.throws(
      () => toolsFromJson({ t: { desc: 'x', method: 'GET', params: { unused: 'string' }, path: '/x' } }, 'f.json'),
      /never used/,
    );
  });

  test('required referencing an unknown param is reported', () => {
    assert.throws(
      () => toolsFromJson({ t: { desc: 'x', method: 'GET', params: { a: 'string' }, path: '/x/{a}', required: ['b'] } }, 'f.json'),
      /required/,
    );
  });

  test('an unknown return type is reported with the available names', () => {
    assert.throws(
      () => toolsFromJson({ t: { desc: 'x', method: 'GET', path: '/x', returns: 'nope' } }, 'f.json'),
      (e) => {
        assert.match(e.message, /'returns' is "nope"/);
        assert.match(e.message, /anyObject/);
        return true;
      },
    );
  });

  test('a valid return type is accepted', () => {
    const t = toolsFromJson({ t: { desc: 'x', method: 'GET', path: '/x', returns: 'paged' } }, 'f.json');
    assert.ok(t.t.returns, 'the tool carries the entity schema');
  });

  test('a valid declaration is accepted and its type comes from the registry', () => {
    const t = toolsFromJson({
      t: { desc: 'x', method: 'GET', params: { k: 'projectKey' }, path: '/p/{k}', query: { q: '{k}' } },
    }, 'f.json');
    assert.ok(TYPE_NAMES.includes('projectKey'));
    // Behavioural assertion: the declared type really carries the registry validation.
    assert.equal(t.t.input.k.safeParse('PROJ').success, true);
    assert.equal(t.t.input.k.safeParse('not a valid key!').success, false);
  });
});

describe('write-verification guard rails', () => {
  test('VERIFY_WRITE without VERIFY_PROJECT is refused', async () => {
    const { assertWriteModeConfigured } = await import('./verify-writes.mjs');
    const before = process.env.VERIFY_PROJECT;
    delete process.env.VERIFY_PROJECT;
    try {
      assert.throws(() => assertWriteModeConfigured(), /VERIFY_PROJECT/);
      process.env.VERIFY_PROJECT = 'PROJ';
      assert.doesNotThrow(() => assertWriteModeConfigured());
    } finally {
      if (before === undefined) delete process.env.VERIFY_PROJECT; else process.env.VERIFY_PROJECT = before;
    }
  });

  test('write verification is off unless VERIFY_WRITE=1', async () => {
    const { writeModeEnabled } = await import('./verify-writes.mjs');
    const before = process.env.VERIFY_WRITE;
    delete process.env.VERIFY_WRITE;
    assert.equal(writeModeEnabled(), false);
    process.env.VERIFY_WRITE = '1';
    assert.equal(writeModeEnabled(), true);
    if (before === undefined) delete process.env.VERIFY_WRITE; else process.env.VERIFY_WRITE = before;
  });
});

describe('plugin inventory on an instance that refuses it', () => {
  const PORT = 18099;
  let server, srv;

  before(async () => {
    server = (await import('node:http')).createServer((req, res) => {
      // Exactly what a non-admin account gets from Jira Server UPM.
      res.writeHead(406);
      res.end();
    });
    await new Promise((ok) => server.listen(PORT, ok));
    srv = await startServer({
      JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'a', JIRA_PASSWORD: 's3cretlong',
    });
  });
  after(() => { srv?.stop(); server?.close(); });

  test('jira_list_plugins degrades to a field-derived inference instead of failing', async () => {
    const r = await srv.callTool('jira_list_plugins', {});
    assert.equal(r.ok, true, r.text);
    const payload = JSON.parse(r.text);
    assert.deepEqual(payload.plugins, []);
    assert.equal(payload.pluginInventory, 'unavailable');
    // Both spellings were tried and each outcome is reported.
    assert.equal(payload.attempts.length, 2);
    assert.equal(payload.attempts[0].path, '/rest/plugins/1.0/');
    assert.equal(payload.attempts[1].path, '/rest/plugins/1.0');
    assert.match(payload.note, /administrator rights/);
    assert.ok(Array.isArray(payload.inferredFromFields));
  });
});

describe('shipped plugin examples', () => {
  const dir = resolve(ROOT, 'tools.d/examples');

  test('every example is valid JSON and passes declaration validation', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 3, `expected example files, got ${files.length}`);
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
      // Throws with the file name if a field is wrong - so examples cannot rot silently.
      assert.doesNotThrow(() => toolsFromJson(parsed.tools ?? {}, `tools.d/examples/${f}`), f);
    }
  });

  test('the examples directory is not auto-loaded', async () => {
    const srv = await startServer({ JIRA_BASE_URL: 'http://127.0.0.1:9', JIRA_AUTH: 'basic', JIRA_USERNAME: 'a', JIRA_PASSWORD: 's3cretlong' });
    try {
      const names = (await srv.listTools()).map((t) => t.name);
      assert.deepEqual(names.filter((n) => n.includes('example')), [], 'examples must not be registered');
    } finally { srv.stop(); }
  });
});

describe('configuration does not depend on cwd', () => {
  const PORT = 18094;
  const ENV = {
    JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
    JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong',
  };
  let mock;
  before(async () => { mock = await startMock(PORT); });
  after(() => mock?.server.close());

  test('aliases still work when started from an unrelated working directory', async () => {
    const srv = await startServer(ENV, { cwd: '/tmp' });
    try {
      mock.log.length = 0;
      const r = await srv.callTool('jira_create_issue', { fields: { summary: 'x', Department: { id: '10101' } } });
      assert.ok(r.ok, r.text);
      const sent = mock.log.find((l) => l.url === '/rest/api/2/issue');
      const body = JSON.parse(sent.body);
      assert.deepEqual(body.fields.customfield_10123, { id: '10101' }, 'alias translated to the field id');
    } finally { srv.stop(); }
  });

  test('describe output carries aliases regardless of cwd', async () => {
    const srv = await startServer(ENV, { cwd: '/tmp' });
    try {
      const r = await srv.callTool('jira_describe_create', { projectKey: 'PROJ', issueTypeName: 'Task' });
      assert.match(r.text, /customfield_10123\(Department\)/);
    } finally { srv.stop(); }
  });
});
