// Offline mock Jira. The goal is to be faithful to the real *status codes and response
// shapes*, not to simulate business logic - especially the 204 empty responses on
// PUT/DELETE and the {id,key,self} body of POST /issue. Those shapes are checked by
// outputSchema, so a mock that drifts from the real thing would hide real bugs.
import http from 'node:http';

const j = (res, body, code = 200) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};
const noContent = (res) => { res.statusCode = 204; res.end(); };

const CREATEMETA = { projects: [{ key: 'PROJ', issuetypes: [{ name: 'Task', fields: {
  summary: { required: true, name: 'Summary', schema: { type: 'string' } },
  customfield_20001: { required: true, name: 'Department', schema: { type: 'option', custom: 'select', customId: 20001 },
    allowedValues: [{ id: '10101', value: 'Platform' }, { id: '10102', value: 'Infrastructure' }] },
  assignee: { required: false, name: 'Assignee', schema: { type: 'user' }, allowedValues: [{ name: 'alice', displayName: 'Alice' }] },
  customfield_20002: { required: false, name: 'Release date', schema: { type: 'date' } },
  attachment: { required: false, name: 'Attachment', schema: { type: 'array', items: 'attachment' } },
} }] }] };

const EDITMETA = { fields: {
  summary: { required: true, name: 'Summary', schema: { type: 'string' } },
  customfield_20001: { required: false, name: 'Department', schema: { type: 'option' }, allowedValues: [{ id: '10101', value: 'Platform' }] },
  customfield_20003: { required: false, name: 'Story points', schema: { type: 'number' } },
} };

export function startMock(port = 18080) {
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      log.push({ method: req.method, url: req.url, body: raw });
      if (!(req.headers.authorization || '').startsWith('Basic ')) return j(res, { errorMessages: ['no basic auth'] }, 401);
      const u = req.url.split('?')[0];
      const M = req.method;

      // -- writes: the real instance answers 204 or 201/200 with an entity ------
      if (M === 'POST' && u === '/rest/api/2/issue') return j(res, { id: '10001', key: 'PROJ-1', self: 'http://x/rest/api/2/issue/10001' }, 201);
      if (M === 'PUT' && u === '/rest/api/2/issue/PROJ-1') return noContent(res);
      if (M === 'DELETE') return noContent(res);
      if (M === 'PUT' && u === '/rest/api/2/issue/PROJ-1/assignee') return noContent(res);
      if (M === 'POST' && u === '/rest/api/2/issue/PROJ-1/transitions') return noContent(res);
      if (M === 'POST' && u === '/rest/api/2/issueLink') return j(res, undefined, 201);
      if (M === 'POST' && /\/rest\/agile\/1\.0\/(sprint\/\d+|backlog)\/issue$/.test(u)) return noContent(res);
      if (M === 'POST' && /\/issue\/PROJ-1\/remotelink$/.test(u)) return j(res, { id: 7, self: 'http://x/rest/api/2/issue/PROJ-1/remotelink/7' }, 201);
      if (M === 'POST' && /\/issue\/PROJ-1\/attachments$/.test(u)) return j(res, [{ id: '9', filename: 'a.txt', size: 5 }], 201);
      if (M === 'POST' && /\/issue\/PROJ-1\/watchers$/.test(u)) return noContent(res);
      if (M === 'POST' && u === '/rest/api/2/issue/PROJ-1/comment') return j(res, { id: '1', body: JSON.parse(raw || '{}').body ?? 'hi', author: { name: 'alice' } }, 201);
      if (M === 'PUT' && /\/comment\/\d+$/.test(u)) return j(res, { id: '1', body: JSON.parse(raw || '{}').body ?? 'hi' });
      if (M === 'POST' && u === '/rest/api/2/issue/PROJ-1/worklog') {
        const b = JSON.parse(raw || '{}');
        return j(res, { id: '1', timeSpentSeconds: b.timeSpentSeconds ?? 60, started: b.started }, 201);
      }
      if (M === 'PUT' && /\/worklog\/\d+$/.test(u)) return j(res, { id: '1', timeSpentSeconds: 60 });

      // -- reads ---------------------------------------------------------------
      // Real Jira always sends `schema`; omitting it made the capture report's type column
      // permanently empty, which would have hidden a bug in that report.
      if (u === '/rest/api/2/field') return j(res, [
        { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
        { id: 'customfield_20001', name: 'Department', custom: true,
          schema: { type: 'option', custom: 'com.example.customfieldtypes:select', customId: 20001 } },
        { id: 'customfield_20002', name: 'Release date', custom: true,
          schema: { type: 'date', custom: 'com.example.customfieldtypes:datepicker', customId: 20002 } }]);
      if (u.includes('/createmeta')) return j(res, CREATEMETA);
      if (u.includes('/editmeta')) return j(res, EDITMETA);
      if (u === '/rest/api/2/myself') return j(res, { name: 'alice', displayName: 'Alice', emailAddress: 'a@x.com' });
      if (u === '/rest/api/2/serverInfo') return j(res, { version: '8.5.7', versionNumbers: [8, 5, 7], deploymentType: 'Server' });
      if (u === '/rest/plugins/1.0/') return j(res, { plugins: [{ key: 'com.example.plugin', name: 'Example Plugin', version: '1.0' }] });
      if (u === '/rest/api/2/project') return j(res, [{ key: 'PROJ', id: '10000', name: 'Demo' }]);
      if (u === '/rest/api/2/search') return j(res, { startAt: 0, maxResults: 50, total: 2,
        issues: [
          { id: '1', key: 'PROJ-1', fields: { summary: 't', customfield_20001: { value: 'Platform' } } },
          { id: '2', key: 'PROJ-2', fields: { summary: 't2', customfield_20002: '2026-01-01' } },
        ] });
      if (u === '/rest/agile/1.0/board') return j(res, { values: [{ id: 7, name: 'B' }], isLast: true });
      if (/^\/rest\/agile\/1\.0\/board\/\d+\/sprint$/.test(u)) return j(res, { values: [{ id: 42, name: 'Sprint 1', state: 'active', originBoardId: 7 }], isLast: true });
      // The backlog is an issue list, not a `values` envelope. A mock that got this wrong
      // is exactly what let the real-instance failure through.
      if (/^\/rest\/agile\/1\.0\/board\/\d+\/backlog$/.test(u)) return j(res, { expand: 'names', startAt: 0, maxResults: 50, total: 0, issues: [] });
      if (u === '/rest/api/2/issue/PROJ-1/comment') return j(res, { comments: [{ id: '1', body: 'hi' }], total: 1 });
      if (u === '/rest/api/2/issue/PROJ-1/worklog') return j(res, { worklogs: [{ id: '1', timeSpentSeconds: 60 }], total: 1 });
      if (u === '/rest/api/2/issue/PROJ-1/transitions') return j(res, { transitions: [{ id: '31', name: 'Done' }] });
      if (u === '/rest/api/2/issue/PROJ-1/remotelink') return j(res, [{ id: 7, object: { url: 'http://wiki/x', title: 'Spec' } }]);
      if (/^\/rest\/agile\/1\.0\/sprint\/\d+$/.test(u)) return j(res, { id: 42, name: 'Sprint 1', state: 'active', originBoardId: 7 });
      if (/^\/rest\/agile\/1\.0\/(board|sprint)\/\d+\/issue$/.test(u)) return j(res, { startAt: 0, maxResults: 50, total: 1,
        issues: [{ id: '1', key: 'PROJ-1', fields: { summary: 't' } }] });

      if (u === '/rest/api/2/issueLinkType') return j(res, { issueLinkTypes: [{ id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] });
      if (u === '/rest/api/2/issue/PROJ-1/watchers') return j(res, { isWatching: true, watchCount: 1, watchers: [{ name: 'alice' }] });
      if (u === '/rest/api/2/attachment/9') return j(res, { id: '9', filename: 'a.txt', size: 3, content: 'http://x/secure/attachment/9' });
      if (u.startsWith('/rest/api/2/user/search') || u.startsWith('/rest/api/2/user/assignable'))
        return j(res, [{ name: 'alice', displayName: 'Alice' }]);
      if (u.startsWith('/rest/api/2/user')) return j(res, { name: 'alice', displayName: 'Alice' });
      if (/^\/rest\/api\/2\/project\/[^/]+\/(components|versions|statuses)$/.test(u)) return j(res, [{ id: '1', name: 'x' }]);
      if (/^\/rest\/api\/2\/project\/[^/]+$/.test(u)) return j(res, { id: '10000', key: 'PROJ', name: 'Demo', projectTypeKey: 'software' });
      // The Zephyr search endpoints answer a BARE ARRAY; the vendored mapper drops anything
      // that is not an array, which is how a wrong mock shape stayed invisible.
      // The status option endpoint answers a BARE ARRAY; the tool wraps it as {source, values}.
      if (/^\/rest\/tests\/1\.0\/project\/\d+\/testresultstatus$/.test(u)) {
        return j(res, [{ id: 34, name: 'Not Executed', index: 0, color: '#cfcfc4', i18nKey: 'TEST_RESULT.STATUS.NOT_EXECUTED', isDefault: true, projectId: 10000 }]);
      }
      if (/^\/rest\/atm\/1\.0\/testcase\/search$/.test(u)) return j(res, [
        { id: 1, key: 'PROJ-T1', name: 'probe', projectKey: 'PROJ' },
        { id: 2, key: 'PROJ-T2', name: 'probe two', projectKey: 'PROJ' }]);
      if (/^\/rest\/atm\/1\.0\/testrun\/search$/.test(u)) return j(res, [
        { id: 3, key: 'PROJ-R1', name: 'probe run', projectKey: 'PROJ' },
        { id: 4, key: 'PROJ-R2', name: 'probe run two', projectKey: 'PROJ' }]);
      if (/^\/rest\/atm\/1\.0\/testplan\/search$/.test(u)) return j(res, [
        { id: 5, key: 'PROJ-P1', name: 'probe plan', projectKey: 'PROJ' },
        { id: 6, key: 'PROJ-P2', name: 'probe plan two', projectKey: 'PROJ' }]);
      // Two deliberately different cases, so a presence statistic has something to say.
      if (/^\/rest\/atm\/1\.0\/testcase\/PROJ-T1$/.test(u)) return j(res, {
        id: 1, key: 'PROJ-T1', name: 'probe', projectKey: 'PROJ', status: 'Draft', priority: 'High',
        folder: '/Regression', customFields: { Department: 'Platform' },
        testScript: { id: 1, type: 'STEP_BY_STEP', steps: [{ id: 1, index: 0, description: 'open', expectedResult: 'opens' }] } });
      if (/^\/rest\/atm\/1\.0\/testcase\/PROJ-T2$/.test(u)) return j(res, {
        id: 2, key: 'PROJ-T2', name: 'probe two', projectKey: 'PROJ',
        testScript: { id: 2, type: 'PLAIN_TEXT', text: 'just do it' } });
      if (/^\/rest\/atm\/1\.0\/testrun\/PROJ-R\d$/.test(u)) return j(res, {
        id: 3, key: u.split('/').pop(), name: 'probe run', projectKey: 'PROJ', status: 'In Progress',
        items: [{ id: 1, testCaseKey: 'PROJ-T1', status: 'Pass' }] });
      if (/^\/rest\/atm\/1\.0\/testplan\/PROJ-P\d$/.test(u)) return j(res, {
        id: 5, key: u.split('/').pop(), name: 'probe plan', projectKey: 'PROJ', status: 'Draft' });
      if (u === '/rest/servicedeskapi/servicedesk') return j(res, { size: 1, values: [{ id: '5', projectKey: 'PROJ' }] });
      // JSM page shape: {size, startAt, isLast, values}. A generic {ok:true} here would not
      // satisfy the declared `paged` return type - and that is the point of declaring one.
      if (/^\/rest\/servicedeskapi\/servicedesk\/[^/]+\/queue$/.test(u)) {
        return j(res, { size: 1, startAt: 0, isLast: true, values: [{ id: '1', name: 'Default queue' }] });
      }
      if (/^\/rest\/atm\/1\.0\/testcase\/[^/]+\/attachments$/.test(u)) {
        return j(res, [{ id: 77, name: 'evidence.txt', url: '/rest/tests/1.0/attachment/77' }]);
      }
      if (/^\/rest\/tests\/1\.0\/attachment\/\d+$/.test(u)) {
        res.setHeader('content-type', 'text/plain');
        return res.end('probe attachment content\n');
      }
      // The custom-field DEFINITIONS endpoint answers a BARE ARRAY on a real instance (23 items on
      // the reference one). Returning an object here would make the observation mode report the
      // wrong root type for the tool, which is exactly what it exists to measure.
      // Traceability: this endpoint answers a BARE ARRAY too (one entry per LINK, so a case linked
      // twice appears twice). A generic object fallback here would make the output-contract check
      // report the wrong root type for the tool.
      if (/^\/rest\/atm\/1\.0\/issuelink\/[^/]+\/testcases$/.test(u)) {
        return j(res, [
          { id: 1, key: 'PROJ-T1', name: 'probe', projectKey: 'PROJ', status: 'Draft', lastTestResultStatus: 'Pass' },
        ]);
      }
      if (/^\/rest\/tests\/1\.0\/project\/\d+\/customfields\/\w+$/.test(u)) {
        return j(res, [
          { id: 11, name: 'Department', type: 'SINGLE_CHOICE', index: 0, projectId: 10000, required: false, archived: false,
            options: [{ id: 101, name: 'Platform', index: 0, archived: false }] },
          { id: 12, name: 'Automation', type: 'CHECKBOX', index: 1, projectId: 10000, required: false, archived: false, options: [] },
        ]);
      }
      // The folder tree is an object rooted at the project, not at a folder.
      if (/^\/rest\/tests\/1\.0\/project\/\d+\/foldertree\/\w+$/.test(u)) {
        return j(res, { projectId: 10000, itemsCount: 2,
          children: [{ id: 5, projectId: 10000, index: 0, name: 'Regression', itemsCount: 2,
            children: [{ id: 6, projectId: 10000, parentId: 5, index: 0, name: 'Login', itemsCount: 2 }] }] });
      }
      if (/^\/rest\/tests\/1\.0\/project\/\d+\/(testcasestatus|testcasepriority)$/.test(u)) {
        return j(res, [{ id: 21, name: 'Draft', index: 0, projectId: 10000, color: '#cfcfc4', isDefault: true, i18nKey: 'X' }]);
      }
      if (u.startsWith('/rest/atm/1.0') || u.startsWith('/rest/tests/1.0')) return j(res, { id: 1, key: 'PROJ-T1', values: [], items: [] });

      // Generic issue route last, so specific sub-resources above win.
      if (u.startsWith('/rest/api/2/issue/PROJ-1')) return j(res, { id: '1', key: 'PROJ-1',
        fields: { summary: 't', attachment: [{ id: '9', filename: 'a.txt' }] } });

      // The body is multipart, not JSON - never JSON.parse it blindly.
      let parsed = null;
      if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = '<non-json body>'; } }
      return j(res, { ok: true, method: M, path: req.url, received: parsed });
    });
  });
  return new Promise((ok) => server.listen(port, () => ok({ server, log, port })));
}

if (import.meta.url === `file://${process.argv[1]}`) startMock().then(() => console.log('[mock] up'));
