import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PORT = 18093;
const hits = { flaky: 0, slow: 0 };

// These must be set before importing src/jira.ts: it reads them at module load.
process.env.JIRA_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.JIRA_USERNAME = 'alice';
process.env.JIRA_PASSWORD = 's3cretlong';
process.env.JIRA_TIMEOUT_MS = '250';
process.env.JIRA_MAX_RETRIES = '2';

const { jira, explain, resolveUrl, baseUrlProblem } = await import('../src/jira.ts');

let server;
before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (u === '/rest/api/2/ok') return send(200, { ok: true, url: req.url });
    if (u === '/rest/api/2/unauth') return send(401, { errorMessages: ['Login failed'] });
    // Jira Server answers /rest/plugins/1.0/ with an empty 406 when the account is not an admin.
    if (u.startsWith('/rest/plugins/')) { res.writeHead(406); res.end(); return; }
    if (u === '/rest/api/2/notacceptable') { res.writeHead(406); res.end(); return; }
    if (u === '/rest/api/2/forbidden') return send(403, { errorMessages: ['no permission'] });
    if (u === '/rest/api/2/nope') return send(404, { errorMessages: ['Issue does not exist'] });
    if (u === '/rest/api/2/screen') {
      return send(400, { errorMessages: ["Field 'customfield_10123' cannot be set. It is not on the appropriate screen, or unknown."] });
    }
    if (u === '/rest/api/2/flaky') {
      hits.flaky++;
      if (hits.flaky < 3) return send(503, { errorMessages: ['maintenance'] }, { 'retry-after': '0' });
      return send(200, { ok: true, attempt: hits.flaky });
    }
    if (u === '/rest/api/2/slow') {
      hits.slow++;
      return setTimeout(() => send(200, { ok: true }), 1000);
    }
    return send(200, { ok: true, url: req.url });
  });
  await new Promise((ok) => server.listen(PORT, ok));
});
after(() => server.close());

describe('transport', () => {
  test('a normal response is parsed as JSON', async () => {
    assert.deepEqual(await jira('GET', '/ok'), { ok: true, url: '/rest/api/2/ok' });
  });

  test('503 with Retry-After is retried until it succeeds', async () => {
    hits.flaky = 0;
    const r = await jira('GET', '/flaky');
    assert.equal(r.ok, true);
    assert.equal(hits.flaky, 3, 'three requests in total (2 failures + 1 success)');
  });

  test('a timeout reports something actionable instead of a bare TimeoutError', async () => {
    hits.slow = 0;
    await assert.rejects(() => jira('GET', '/slow'), (err) => {
      assert.match(err.message, /JIRA_TIMEOUT_MS/);
      assert.match(err.message, /\/slow/);
      return true;
    });
  });

  test('query parameters are encoded', async () => {
    const r = await jira('GET', '/ok', { query: { jql: 'project = PROJ', maxResults: 5 } });
    assert.equal(r.url, '/rest/api/2/ok?jql=project+%3D+PROJ&maxResults=5');
  });
});

describe('path resolution', () => {
  test('short paths get the /rest/api/2 prefix', () => {
    assert.equal(resolveUrl('/issue/PROJ-1'), `http://127.0.0.1:${PORT}/rest/api/2/issue/PROJ-1`);
  });
  test('absolute REST paths pass through (plugin modules)', () => {
    assert.equal(resolveUrl('/rest/tempo-timesheets/4/worklogs'), `http://127.0.0.1:${PORT}/rest/tempo-timesheets/4/worklogs`);
    assert.equal(resolveUrl('/rest/agile/1.0/board'), `http://127.0.0.1:${PORT}/rest/agile/1.0/board`);
  });
  test('a fully qualified URL is left alone', () => {
    assert.equal(resolveUrl('https://other.example/rest/api/2/x'), 'https://other.example/rest/api/2/x');
  });
});

describe('error translation', () => {
  test('401 points at credentials and SSO/CAPTCHA', () => {
    const m = explain(401, '{}', 'GET', '/myself');
    assert.match(m, /authentication failed/);
    assert.match(m, /SSO\/Crowd/);
    assert.match(m, /CAPTCHA/);
  });

  test('401 also applies on the real call path', async () => {
    await assert.rejects(() => jira('GET', '/unauth'), (e) => {
      assert.match(e.message, /authentication failed/);
      return true;
    });
  });

  test('406 explains that the endpoint likely needs administrator rights', () => {
    const m = explain(406, '', 'GET', '/rest/plugins/1.0/');
    assert.match(m, /administrator rights/);
    assert.match(m, /content type/);
  });

  test('a 406 response surfaces as an actionable error, not a bare status', async () => {
    await assert.rejects(() => jira('GET', '/notacceptable'), (e) => {
      assert.match(e.message, /administrator rights/);
      return true;
    });
  });

  test('403 explains that it is a permission problem', async () => {
    await assert.rejects(() => jira('GET', '/forbidden'), (e) => {
      assert.match(e.message, /permission denied/);
      return true;
    });
  });

  test('404 on a plugin path suggests checking the plugin', () => {
    const m = explain(404, '{}', 'GET', '/rest/tempo-timesheets/4/worklogs');
    assert.match(m, /plugin/);
    assert.match(m, /jira_list_plugins/);
  });

  test('404 on a core API path does not blame a plugin', () => {
    const m = explain(404, '{}', 'GET', '/issue/PROJ-9');
    assert.ok(!m.includes('confirm the plugin is installed'));
  });

  test('a screen error names the field and points at the describe tools', () => {
    const body = JSON.stringify({ errorMessages: ["Field 'customfield_10123' cannot be set. It is not on the appropriate screen, or unknown."] });
    const m = explain(400, body, 'POST', '/issue');
    assert.match(m, /customfield_10123/);
    assert.match(m, /screen/i);
    assert.match(m, /jira_describe_create|jira_describe_edit/);
  });

  test('a screen error is recognised on the real call path', async () => {
    await assert.rejects(() => jira('POST', '/screen', { body: {} }), (e) => {
      assert.match(e.message, /screen/i);
      return true;
    });
  });
});

describe('base URL validation', () => {
  // A bad base used to surface only as `fetch failed` / `Failed to parse URL`, which says nothing
  // about the cause. These cases are the ones actually seen when a host injects the base from a
  // secret store, or when the operator writes a bare host:port.
  test('accepts an absolute http(s) URL', () => {
    assert.equal(baseUrlProblem('http://jira.example.com:8080'), null);
    assert.equal(baseUrlProblem('https://jira.example.com'), null);
    assert.equal(baseUrlProblem('http://jira.example.com:8080/'), null, 'a trailing slash is fine');
  });

  test('reports an empty or whitespace-only value', () => {
    assert.match(baseUrlProblem(''), /empty/);
    assert.match(baseUrlProblem('   '), /empty/);
    // Not baseUrlProblem(undefined): an explicit undefined falls back to process.env, which this
    // test file sets to a valid URL at the top.
  });

  test('reports a reference that was never resolved', () => {
    // What a host passes through when it does not substitute ${credential:...} before spawn.
    assert.match(baseUrlProblem('${credential:JIRA_SERVER}'), /unresolved/);
    assert.match(baseUrlProblem('${env:JIRA_BASE_URL}'), /placeholder/);
  });

  test('reports a bare host:port or a path, which are not absolute URLs', () => {
    assert.match(baseUrlProblem('jira.example.com:8080'), /must be an absolute URL/);
    assert.match(baseUrlProblem('/rest/api/2'), /must be an absolute URL/);
  });

  test('never echoes the value it was given', () => {
    const secret = 'sup3r-s3cret-host.internal:8080';
    const problem = baseUrlProblem(secret);
    assert.ok(problem !== null);
    assert.ok(!problem.includes(secret), 'the message must not contain the value');
    assert.ok(!problem.includes('sup3r'), 'not even a fragment of it');
  });
});
