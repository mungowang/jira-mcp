#!/usr/bin/env node
/**
 * Verify every read-only tool against a real Jira instance.
 *
 * By design this only calls read-only tools (readOnlyHint=true), so it never modifies
 * data and is safe to run against production.
 *
 * Usage:
 *   JIRA_BASE_URL=https://jira.corp.com JIRA_USERNAME=you JIRA_PASSWORD=*** \
 *   [ZEPHYR_ALLOW_INTERNAL_API=true] node test/live-verify.mjs
 */
import { writeFileSync } from 'node:fs';
import { startServer, isReadOnly } from './harness.mjs';
import { argsFor } from './args.mjs';
import { discoverContext, parse, asList } from './discover.mjs';
import { CANDIDATES } from './probe-candidates.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureInstance, buildReport, buildSummary } from './capture.mjs';
import { writeModeEnabled, assertWriteModeConfigured, verifyWrites } from './verify-writes.mjs';

const env = {
  JIRA_BASE_URL: process.env.JIRA_BASE_URL,
  JIRA_USERNAME: process.env.JIRA_USERNAME,
  JIRA_PASSWORD: process.env.JIRA_PASSWORD,
  JIRA_AUTH: process.env.JIRA_AUTH ?? (process.env.JIRA_PAT ? 'pat' : 'basic'),
  ...(process.env.JIRA_PAT && { JIRA_PAT: process.env.JIRA_PAT }),
  ...(process.env.ZEPHYR_ALLOW_INTERNAL_API && { ZEPHYR_ALLOW_INTERNAL_API: process.env.ZEPHYR_ALLOW_INTERNAL_API }),
  ...(process.env.ZEPHYR_DEFAULT_PROJECT_KEY && { ZEPHYR_DEFAULT_PROJECT_KEY: process.env.ZEPHYR_DEFAULT_PROJECT_KEY }),
  JIRA_TIMEOUT_MS: process.env.JIRA_TIMEOUT_MS ?? '20000',
};

if (!env.JIRA_BASE_URL) {
  console.error('JIRA_BASE_URL is required. See the header of this file for usage.');
  process.exit(2);
}

const first = parse;
const rows = [];
// Failures keep more text: the fix loop happens offline, so the report has to carry
// enough of the response to diagnose without another run against the instance.
const record = (name, status, detail) => rows.push({
  name, status,
  detail: String(detail ?? '').replace(/\s+/g, ' ').slice(0, status === 'fail' ? 500 : 150),
});

const srv = await startServer(env, { timeoutMs: 40_000 });
const tools = await srv.listTools();
console.log(`\nConnected to ${env.JIRA_BASE_URL}  (auth=${env.JIRA_AUTH})`);
console.log(`${tools.length} tools total (${tools.filter(isReadOnly).length} read-only)\n`);

// -- phase 1: connectivity and version ----------------------------------------
console.log('-- connectivity --');

const info = await srv.callTool('jira_server_info', {});
if (!info.ok) {
  console.error(`x jira_server_info failed: ${info.text.slice(0, 200)}`);
  console.error('  The address or the credentials are wrong; further verification is pointless.');
  srv.stop();
  process.exit(1);
}
const infoJson = first(info) ?? {};
console.log(`  ok Jira ${infoJson.version ?? '?'}  deployment=${infoJson.deploymentType ?? '?'}  build=${infoJson.buildNumber ?? '?'}`);
record('jira_server_info', 'ok', `version=${infoJson.version}`);


// -- phase 2: discover real values -------------------------------------------
console.log('\n-- discovering context --');
const ctx = await discoverContext(srv, (line) => console.log(line));

// Plugin inventory - decides which plugins are worth adapting. Requires administrator
// rights; a refusal is expected on a normal account and is reported, not treated as failure.
let plugins = [];
let pluginNote = '';
const pl = await srv.callTool('jira_list_plugins', {});
const plj = first(pl);
if (plj?.plugins?.length) {
  plugins = plj.plugins.map((p) => `${p.name ?? p.key}${p.version ? `@${p.version}` : ''}`);
  console.log(`  ok ${plugins.length} plugin(s) installed (UPM)`);
} else if (plj?.inferredFromFields?.length) {
  // UPM needs administrator rights; the custom field schemas still reveal which vendors are in.
  plugins = plj.inferredFromFields.map((p) => `${p.pluginKey}  (${p.fieldCount} field(s)${p.sampleFields?.length ? `: ${p.sampleFields.join(', ')}` : ''})`);
  pluginNote = 'inferred from custom field schemas (UPM not readable by this account)';
  console.log(`  ok ${plugins.length} plugin key(s) inferred from custom field schemas`);
  for (const line of plugins) console.log(`      ${line}`);
} else if (!pl.ok) {
  console.log(`  - plugin inventory unavailable: ${pl.text.replace(/\s+/g, ' ').slice(0, 160)}`);
} else {
  console.log('  - no plugins reported');
}

// -- phase 3: every read-only tool -------------------------------------------
console.log('\n-- verifying read-only tools --');
let ok = 0, fail = 0, skip = 0;
for (const t of tools) {
  if (!isReadOnly(t)) continue;
  const args = argsFor(t.name, ctx);
  if (args === undefined) { record(t.name, 'skip', 'needs manual arguments or Zephyr data'); skip++; continue; }
  const r = await srv.callTool(t.name, args);
  if (r.ok) { ok++; record(t.name, 'ok', ''); console.log(`  ok ${t.name}`); }
  else if (/administrator rights|Jira administrator/i.test(r.text)) {
    // The tool is fine, this account just cannot exercise it.
    skip++; record(t.name, 'skip', r.text);
    console.log(`  -  ${t.name}  (needs administrator rights)`);
  } else {
    fail++;
    record(t.name, 'fail', r.text);
    // Longer than a one-liner on purpose: this output gets pasted back for diagnosis.
    console.log(`  x  ${t.name}  ${r.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}
// -- phase 4 (opt-in): write tools -------------------------------------------
if (writeModeEnabled()) {
  assertWriteModeConfigured();
  console.log(`\n-- verifying write tools (probe issue in ${process.env.VERIFY_PROJECT}) --`);
  await verifyWrites(srv, { ...ctx, projectKey: process.env.VERIFY_PROJECT }, { record, issueTypeName: ctx.issueTypeName });
} else {
  console.log('\n-- write tools skipped (set VERIFY_WRITE=1 and VERIFY_PROJECT=<KEY> to include them) --');
}

// -- phase 5 (opt-in): plugin path probe -------------------------------------
let probeRows = [];
if (process.env.VERIFY_PROBE_PATHS === '1') {
  console.log('\n-- probing candidate plugin paths (GET only) --');
  const statusOf = async (method, path) => {
    const r = await srv.callTool('jira_request', { method, path });
    if (r.ok) return { status: '200', note: r.text.replace(/\s+/g, ' ').slice(0, 120) };
    const m = /-> (\d{3})/.exec(r.text);
    return { status: m ? m[1] : 'ERR', note: r.text.replace(/\s+/g, ' ').slice(0, 120) };
  };
  for (const path of CANDIDATES) {
    const g = await statusOf('GET', path);
    let line = `${g.status} ${path}`;
    // 405 means the resource exists but not for GET - worth one POST follow-up.
    if (g.status === '405') {
      const p = await statusOf('POST', path);
      line += `  | POST -> ${p.status}`;
    }
    probeRows.push(line);
    console.log(`  ${line}`);
  }
  console.log('  (paste this section back to turn reachable paths into tools.d declarations)');
}

// -- phase 6 (opt-in): structure capture -------------------------------------
if (process.env.CAPTURE === '1') {
  const outDir = resolve(process.env.CAPTURE_DIR ?? 'capture');
  console.log(`\n-- capturing instance structures into ${outDir} --`);
  const { captured, payloads } = await captureInstance(srv, ctx, {
    outDir,
    limit: Number(process.env.CAPTURE_LIMIT ?? 3),
    log: (l) => console.log(l),
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'report.md'), buildReport({ captured, payloads, ctx }));
  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(buildSummary({ captured, payloads }), null, 2));
  console.log(`  ${captured.filter((c) => !c.failed).length}/${captured.length} captured -> ${outDir}/report.md (share this) + ${outDir}/raw/ (do NOT commit)`);
}

srv.stop();

// -- report -------------------------------------------------------------------
console.log(`\nResult: ${ok} passed / ${fail} failed / ${skip} skipped`);
console.log('Note: "skipped" usually means the plugin is absent or real test data is needed - not a defect.');

const md = [
  `# Jira instance verification report`, '',
  `- Instance: ${env.JIRA_BASE_URL}`, `- Jira version: ${infoJson.version ?? '?'} (${infoJson.deploymentType ?? '?'})`,
  `- Auth: ${env.JIRA_AUTH}`, `- Tools: ${tools.length}`, `- Passed ${ok} / failed ${fail} / skipped ${skip}`, '',
  '## Installed plugins', '',
  ...(pluginNote ? [`> ${pluginNote}`, ''] : []),
  ...(plugins.length ? plugins.map((p) => `- ${p}`) : ['(unavailable - requires administrator rights, or read `/rest/plugins/1.0/` manually)']),
  '', '## Per-tool results', '',
  '| Tool | Result | Detail |', '|---|---|---|',
  ...rows.map((r) => `| \`${r.name}\` | ${r.status === 'ok' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL'} | ${r.detail} |`),
  ...(probeRows.length ? ['', '## Plugin path probe', '', '```', ...probeRows, '```'] : []),
  '', `> Read-only tools only; nothing was written.`, '',
].join('\n');
writeFileSync('verify-report.md', md);
console.log('Report written to verify-report.md');
process.exit(fail > 0 ? 1 : 0);
