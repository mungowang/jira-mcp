/**
 * Capture the *structure* of a real instance so the entity schemas can be extended with evidence
 * instead of guesswork.
 *
 * Two outputs, deliberately different:
 *   - capture/raw/*.json   untouched payloads, values included. GITIGNORED: that is the
 *                          company's data and must never be committed.
 *   - capture/report.md    a structure report with every value mutated away - key trees, types,
 *                          array lengths and how often each key appeared. Safe to share.
 *
 * Read-only throughout: documented read-only tools, plus GET via jira_request.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------- shape helpers

/** Structural shape with values stripped: types, key names, array lengths, presence counts. */
export function shapeOf(v, depth = 0, maxDepth = 8) {
  if (v === null || v === undefined) return { t: 'null' };
  if (Array.isArray(v)) {
    const s = { t: 'array', n: v.length };
    if (v.length && depth < maxDepth) s.of = mergeShapes(v.slice(0, 25).map((x) => shapeOf(x, depth + 1, maxDepth)));
    return s;
  }
  if (typeof v === 'object') {
    if (depth >= maxDepth) return { t: 'object', truncated: true };
    const keys = {};
    for (const [k, x] of Object.entries(v)) keys[k] = shapeOf(x, depth + 1, maxDepth);
    return { t: 'object', keys };
  }
  if (typeof v === 'string') return { t: 'string', ...(v === '' ? { empty: true } : {}) };
  if (typeof v === 'number') return { t: Number.isInteger(v) ? 'int' : 'number' };
  if (typeof v === 'boolean') return { t: 'boolean' };
  return { t: typeof v };
}

function mergeObjects(shapes) {
  const counts = new Map();
  for (const s of shapes) for (const k of Object.keys(s.keys)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const keys = {};
  for (const [k, n] of counts) {
    const per = shapes.filter((s) => k in s.keys).map((s) => s.keys[k]);
    keys[k] = { ...mergeShapes(per), present: `${n}/${shapes.length}` };
  }
  const always = [...counts].filter(([, n]) => n === shapes.length).map(([k]) => k).sort();
  return { t: 'object', keys, ...(always.length ? { always } : {}) };
}

/** Merge shapes of the same kind, tracking in how many samples each key appeared. */
export function mergeShapes(shapes) {
  if (!shapes.length) return { t: 'unknown' };
  const types = [...new Set(shapes.map((s) => s.t))];
  if (types.length > 1) {
    const objs = shapes.filter((s) => s.t === 'object' && s.keys);
    if (objs.length === shapes.length) return mergeObjects(objs);
    // Arrays mixed with something else still describe an array well enough.
    if (types.includes('array')) {
      const arrs = shapes.filter((s) => s.t === 'array');
      const items = arrs.flatMap((s) => (s.of ? [s.of] : []));
      return { t: types.join('|'), n: Math.max(...arrs.map((s) => s.n ?? 0)), ...(items.length ? { of: mergeShapes(items) } : {}) };
    }
    return { t: types.join('|'), samples: shapes.length };
  }
  const first = shapes[0];
  if (first.t === 'object' && first.keys) return mergeObjects(shapes);
  if (first.t === 'array') {
    const items = shapes.flatMap((s) => (s.of ? [s.of] : []));
    return { t: 'array', n: Math.max(...shapes.map((s) => s.n ?? 0)), ...(items.length ? { of: mergeShapes(items) } : {}) };
  }
  return { t: first.t, ...(first.empty ? { empty: true } : {}) };
}

/**
 * Compact indented tree. A trailing `*` marks a key that was present in **every** sample of its
 * parent object, which is the evidence for deciding what may be `required`.
 */
export function renderShape(shape, indent = '', label = '') {
  const head = label ? `${indent}${label}: ` : indent;
  if (shape?.t === 'object' && shape.keys) {
    const lines = [`${head}object`];
    for (const [k, s] of Object.entries(shape.keys)) {
      const child = renderShape(s, `${indent}  `, k);
      // The star belongs on the key line, not on the parent: it says "this key was always there".
      if (shape.always?.includes(k) && child.length) child[0] += '  *';
      lines.push(...child);
    }
    return lines;
  }
  if (shape?.t === 'array') {
    const lines = [`${head}array(${shape.n})`];
    if (shape.of) lines.push(...renderShape(shape.of, `${indent}  `, '[]'));
    return lines;
  }
  const extra = shape?.empty ? ' (empty)' : '';
  return [`${head}${shape?.t ?? 'unknown'}${extra}`];
}

/** One-line description of a value's shape, for the field inventory table. */
function brief(shape, depth = 0) {
  if (!shape) return '-';
  if (shape.t === 'object' && shape.keys) {
    const keys = Object.keys(shape.keys);
    return depth > 1 ? 'object' : `object{${keys.slice(0, 5).join(',')}${keys.length > 5 ? ',…' : ''}}`;
  }
  if (shape.t === 'array') return `array(${shape.n})${shape.of ? ` of ${brief(shape.of, depth + 1)}` : ''}`;
  return shape.t;
}

// ---------------------------------------------------------------- capture

const payloadOf = (r) => r.structuredContent ?? (() => { try { return JSON.parse(r.text); } catch { return r.text; } })();

const STEPS = (ctx, limit) => {
  const tql = ctx.projectKey ? `projectKey = "${ctx.projectKey}"` : null;
  return [
    // -- Jira meta ---------------------------------------------------------
    ['serverInfo', 'jira_server_info', {}],
    ['me', 'jira_get_current_user', {}],
    ['plugins', 'jira_list_plugins', {}],
    ['fieldCatalogue', 'jira_get_fields', {}],
    ['issueTypes', 'jira_get_issue_types', {}],
    ['priorities', 'jira_get_priorities', {}],
    ['linkTypes', 'jira_get_link_types', {}],
    // -- project -----------------------------------------------------------
    ['project', 'jira_get_project', ctx.projectKey && { key: ctx.projectKey }],
    ['components', 'jira_get_components', ctx.projectKey && { key: ctx.projectKey }],
    ['versions', 'jira_get_versions', ctx.projectKey && { key: ctx.projectKey }],
    ['statuses', 'jira_get_statuses', ctx.projectKey && { key: ctx.projectKey }],
    // -- one issue, in full ------------------------------------------------
    ['createScreenText', 'jira_describe_create', ctx.projectKey && { projectKey: ctx.projectKey, issueTypeName: ctx.issueTypeName ?? 'Task' }],
    ['issueFull', 'jira_get_issue', ctx.issueKey && { key: ctx.issueKey, expand: 'changelog,renderedFields,names,schema,transitions,editmeta' }],
    ['issueEditScreenText', 'jira_describe_edit', ctx.issueKey && { key: ctx.issueKey }],
    ['issueComments', 'jira_list_comments', ctx.issueKey && { key: ctx.issueKey }],
    ['issueWorklogs', 'jira_list_worklogs', ctx.issueKey && { key: ctx.issueKey }],
    ['issueAttachments', 'jira_list_attachments', ctx.issueKey && { key: ctx.issueKey }],
    ['issueWatchers', 'jira_get_watchers', ctx.issueKey && { key: ctx.issueKey }],
    ['issueRemoteLinks', 'jira_get_remote_links', ctx.issueKey && { key: ctx.issueKey }],
    ['issueTransitions', 'jira_get_transitions', ctx.issueKey && { key: ctx.issueKey }],
    // -- several issues, for presence statistics ---------------------------
    ['issueSample', 'jira_search_issues', { jql: ctx.jql ?? 'order by created DESC', fields: ['*all'], maxResults: limit }],
    // -- agile -------------------------------------------------------------
    ['boards', 'jira_list_boards', {}],
    ['sprints', 'jira_list_sprints', ctx.boardId && { boardId: ctx.boardId }],
    ['sprintIssues', 'jira_get_sprint_issues', ctx.sprintId && { sprintId: ctx.sprintId, maxResults: limit }],
    ['backlog', 'jira_list_backlog', ctx.boardId && { boardId: ctx.boardId, maxResults: limit }],
    // -- Zephyr Scale hierarchy --------------------------------------------
    ['testCaseSearch', 'search_test_cases', tql && { query: tql, maxResults: limit }],
    ['testCaseFull', 'get_test_case', ctx.testCaseKey && { testCaseKey: ctx.testCaseKey }],
    ['testCaseAttachments', 'list_attachments', ctx.testCaseKey && { target: 'test_case', testCaseKey: ctx.testCaseKey }],
    ['testCasesLinkedToIssue', 'get_test_cases_linked_to_issue', ctx.issueKey && { issueKey: ctx.issueKey }],
    ['issueTestCoverage', 'get_issue_test_coverage', ctx.issueKey && { issueKey: ctx.issueKey, maxCases: limit }],
    ['testRunSearch', 'search_test_runs', tql && { query: tql, maxResults: limit }],
    ['testRunFull', 'get_test_run', ctx.testRunKey && { testRunKey: ctx.testRunKey }],
    ['testRunResults', 'get_test_run_results', ctx.testRunKey && { testRunKey: ctx.testRunKey, maxResults: limit }],
    ['testRunSummary', 'get_test_run_summary', ctx.testRunKey && { testRunKey: ctx.testRunKey }],
    ['latestResultForCase', 'get_latest_result_for_test_case', ctx.testCaseKey && { testCaseKey: ctx.testCaseKey }],
    ['testPlanSearch', 'search_test_plans', tql && { query: tql, maxResults: limit }],
    ['testPlanFull', 'get_test_plan', ctx.testPlanKey && { testPlanKey: ctx.testPlanKey }],
    ['folderTree', 'get_folder_tree', ctx.projectKey && { projectKey: ctx.projectKey, entity: 'test_case' }],
    ['statusOptions', 'get_status_options', ctx.projectKey && { projectKey: ctx.projectKey, optionSet: 'test_result' }],
    ['customFieldDefinitions', 'get_custom_field_definitions', ctx.projectKey && { projectKey: ctx.projectKey, entity: 'test_case' }],
    ['environments', 'list_environments', ctx.projectKey && { projectKey: ctx.projectKey }],
    ['findUser', 'find_jira_user', ctx.username && { query: ctx.username }],
    // -- raw endpoints the tools reshape -----------------------------------
    ['rawEditmeta', '__raw', ctx.issueKey && { path: `/issue/${ctx.issueKey}/editmeta` }],
    ['rawCreatemeta', '__raw', ctx.projectKey && { path: `/issue/createmeta?projectKeys=${ctx.projectKey}&expand=projects.issuetypes.fields` }],
  ].filter(([, , args]) => args);
};

/** Run the capture steps and write the raw payloads. */
export async function captureInstance(srv, ctx, { outDir, limit = 3, log = () => {} } = {}) {
  const rawDir = resolve(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const captured = [];
  const payloads = {};

  for (const [name, tool, args] of STEPS(ctx, limit)) {
    const r = tool === '__raw'
      ? await srv.callTool('jira_request', { method: 'GET', path: args.path })
      : await srv.callTool(tool, args);
    if (!r.ok) {
      const failed = r.text.replace(/\s+/g, ' ').slice(0, 300);
      captured.push({ name, tool, args, failed });
      log(`  x  ${name.padEnd(24)} ${tool}  ${failed.slice(0, 90)}`);
      continue;
    }
    const payload = payloadOf(r);
    payloads[name] = payload;
    writeFileSync(resolve(rawDir, `${name}.json`), JSON.stringify(payload, null, 2));
    captured.push({ name, tool, args, shape: shapeOf(payload) });
    log(`  ok ${name.padEnd(24)} ${tool}`);
  }
  return { captured, payloads, rawDir };
}

// ---------------------------------------------------------------- report

/** Join the field catalogue, the live issue values and the create/edit screens into one table. */
export function jiraFieldInventory(payloads) {
  const fields = Array.isArray(payloads.fieldCatalogue) ? payloads.fieldCatalogue : [];
  const onIssue = payloads.issueFull?.fields ?? {};
  const issueSchema = payloads.issueFull?.schema ?? {};
  const issueNames = payloads.issueFull?.names ?? {};
  const screenFields = (meta) => {
    const out = {};
    for (const p of meta?.projects ?? []) for (const it of p.issuetypes ?? []) for (const [id, f] of Object.entries(it.fields ?? {})) out[id] = f;
    for (const [id, f] of Object.entries(meta?.fields ?? {})) out[id] = f;
    return out;
  };
  const create = screenFields(payloads.rawCreatemeta);
  const edit = screenFields(payloads.rawEditmeta);

  return fields
    .map((f) => {
      const present = Object.prototype.hasOwnProperty.call(onIssue, f.id);
      const screen = (m) => (m[f.id] ? (m[f.id].required ? 'required' : 'optional') : '-');
      const allowed = create[f.id]?.allowedValues?.length ?? edit[f.id]?.allowedValues?.length ?? 0;
      return {
        id: f.id,
        name: f.name ?? issueNames[f.id] ?? '',
        type: f.schema?.type ?? issueSchema[f.id]?.type ?? '',
        items: f.schema?.items ?? issueSchema[f.id]?.items ?? '',
        custom: !!f.custom,
        onIssue: present,
        valueShape: present ? brief(shapeOf(onIssue[f.id])) : '-',
        allowed,
        create: screen(create),
        edit: screen(edit),
      };
    })
    .sort((a, b) => (Number(b.onIssue) - Number(a.onIssue)) || a.id.localeCompare(b.id));
}

/**
 * Presence statistics across the sampled issues - the evidence for which envelope keys may be
 * `required` and which custom fields are actually in use.
 */
export function issuePresence(payloads) {
  const issues = payloads.issueSample?.issues ?? [];
  if (!issues.length) return { total: 0, envelope: null, fields: [] };
  const counts = new Map();
  for (const it of issues) {
    for (const [k, v] of Object.entries(it?.fields ?? {})) {
      const e = counts.get(k) ?? { n: 0, shapes: [] };
      e.n += 1;
      e.shapes.push(shapeOf(v));
      counts.set(k, e);
    }
  }
  return {
    total: issues.length,
    envelope: mergeShapes(issues.map((it) => shapeOf(it))),
    fields: [...counts.entries()]
      .map(([id, e]) => ({ id, present: e.n, of: issues.length, shape: mergeShapes(e.shapes) }))
      .sort((a, b) => (b.present - a.present) || a.id.localeCompare(b.id)),
  };
}

const mm = (n) => String(n).padStart(2, '0');

export function buildReport({ captured, payloads, ctx, when = new Date() }) {
  const stamp = `${when.getFullYear()}-${mm(when.getMonth() + 1)}-${mm(when.getDate())} ${mm(when.getHours())}:${mm(when.getMinutes())}`;
  const lines = [];

  lines.push('# Instance structure capture', '');
  lines.push(`Captured ${stamp}. Every value is stripped; only keys, types and counts remain.`, '');
  lines.push(`- Tools captured: ${captured.filter((c) => !c.failed).length} ok, ${captured.filter((c) => c.failed).length} failed`);
  lines.push(`- Context: project \`${ctx.projectKey ?? '-'}\`, issue \`${ctx.issueKey ?? '-'}\`, board \`${ctx.boardId ?? '-'}\`, sprint \`${ctx.sprintId ?? '-'}\``);
  lines.push(`- Zephyr keys: test case \`${ctx.testCaseKey ?? '-'}\`, cycle \`${ctx.testRunKey ?? '-'}\`, plan \`${ctx.testPlanKey ?? '-'}\``, '');
  lines.push('> This report contains **no values** - they are replaced by types, key names and counts.');
  lines.push('> It does contain *field names*, which on a real instance are business terminology.', '');
  lines.push('> `*` marks a key present in **every** sample. With a single sample every key is starred,');
  lines.push('> so the sampled-issue sections below are what carry the real presence evidence.', '');

  // -- Jira field inventory -------------------------------------------------
  const inv = jiraFieldInventory(payloads);
  lines.push('## Jira fields', '');
  lines.push(`${inv.length} field(s); ${inv.filter((f) => f.onIssue).length} present on the sampled issue.`, '');
  lines.push('> `valueShape` is derived from the real value with the value removed. `create`/`edit` say');
  lines.push('> whether the field is on that screen and whether it is required there.', '');
  lines.push('| id | name | type | items | custom | on issue | value shape | allowed | create | edit |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const f of inv) {
    lines.push(`| \`${f.id}\` | ${f.name.replace(/\|/g, '/')} | ${f.type} | ${f.items} | ${f.custom ? 'y' : ''} | ${f.onIssue ? 'y' : ''} | ${f.valueShape.replace(/\|/g, '/')} | ${f.allowed || ''} | ${f.create} | ${f.edit} |`);
  }
  lines.push('');

  // -- what the sampled issues say about the issue entity -------------------
  const presence = issuePresence(payloads);
  if (presence.total) {
    lines.push('## Issue entity evidence', '');
    lines.push(`Merged over **${presence.total}** sampled issue(s). Keys marked \`*\` are safe candidates for`,
      '`required` in `src/entity-types.ts`; everything else must stay optional.', '');
    lines.push('### Issue envelope', '', '```');
    lines.push(...renderShape(presence.envelope));
    lines.push('```', '');
    lines.push('### Fields seen on those issues', '');
    lines.push('| field | present | value shape |');
    lines.push('|---|---|---|');
    for (const f of presence.fields) {
      lines.push(`| \`${f.id}\` | ${f.present}/${f.of} | ${brief(f.shape).replace(/\|/g, '/')} |`);
    }
    lines.push('');
  }

  // -- per-payload shape trees ---------------------------------------------
  lines.push('## Captured structures', '');
  lines.push('`*` marks a key that appeared in **every** sample of that object.', '');
  for (const c of captured) {
    if (c.failed) { lines.push(`### ${c.name} (\`${c.tool}\`)`, '', `failed: ${c.failed}`, ''); continue; }
    lines.push(`### ${c.name} (\`${c.tool}\`)`, '');
    lines.push('```');
    lines.push(...renderShape(c.shape));
    lines.push('```', '');
  }

  return lines.join('\n');
}

/** Machine-readable companion: the merged shapes, ready to translate into src/entity-types.ts. */
export function buildSummary({ captured, payloads }) {
  const shape = (n) => captured.find((c) => c.name === n)?.shape;
  const pick = (n) => (shape(n) ? { [n]: shape(n) } : {});
  return {
    fields: jiraFieldInventory(payloads).filter((f) => f.onIssue || f.custom),
    issuePresence: issuePresence(payloads),
    shapes: Object.assign({},
      pick('issueFull'), pick('issueComments'), pick('issueWorklogs'), pick('issueAttachments'),
      pick('issueWatchers'), pick('issueRemoteLinks'), pick('issueTransitions'),
      pick('project'), pick('me'), pick('serverInfo'), pick('boards'), pick('sprints'),
      pick('testCaseFull'), pick('testRunFull'), pick('testRunResults'), pick('testRunSummary'),
      pick('testPlanFull'), pick('folderTree'), pick('statusOptions'), pick('customFieldDefinitions'),
    ),
  };
}
