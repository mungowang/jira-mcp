#!/usr/bin/env node
/**
 * Print the schema structure of every registered tool - input AND output.
 *
 * Exists because a tool's contract is what the model actually sees, and a plugin declaration in
 * tools.d/ can be checked here before it is relied on.
 *
 * Usage:
 *   npm run tools:describe                 # one line per tool
 *   npm run tools:describe -- jira_jsm     # filter by name substring
 *   npm run tools:describe -- --json       # full inputSchema / outputSchema
 *   npm run tools:describe -- --json jira  # both
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, ROOT } from '../test/harness.mjs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const filter = args.find((a) => !a.startsWith('--')) ?? '';

/** Names declared in tools.d/, so the source of each tool is visible. */
const fromJson = new Set();
const toolsDir = resolve(ROOT, 'tools.d');
for (const f of readdirSync(toolsDir).filter((n) => n.endsWith('.json'))) {
  try {
    for (const name of Object.keys(JSON.parse(readFileSync(resolve(toolsDir, f), 'utf8')).tools ?? {})) {
      fromJson.add(name);
    }
  } catch { /* a broken file is reported by the server at startup */ }
}

/** "name:type*" compactly, with required params starred. */
const describe = (schema) => {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const names = Object.keys(props);
  if (!names.length) return '(none)';
  return names
    .map((n) => {
      const p = props[n];
      const type = p.type ?? (p.anyOf ? p.anyOf.map((x) => x.type).join('|') : '?');
      return `${n}${required.has(n) ? '*' : ''}:${type}`;
    })
    .join(', ');
};

const srv = await startServer({
  JIRA_BASE_URL: process.env.JIRA_BASE_URL ?? 'http://127.0.0.1:1',
  JIRA_AUTH: process.env.JIRA_AUTH ?? 'basic',
  JIRA_USERNAME: process.env.JIRA_USERNAME ?? 'unset',
  JIRA_PASSWORD: process.env.JIRA_PASSWORD ?? 'unset',
}, { timeoutMs: 20_000 });

const tools = (await srv.listTools()).filter((t) => t.name.includes(filter));
srv.stop();

if (asJson) {
  for (const t of tools) {
    console.log(`\n=== ${t.name}  [${fromJson.has(t.name) ? 'json' : 'code'}]`);
    console.log('  input :', JSON.stringify(t.inputSchema));
    console.log('  output:', t.outputSchema ? JSON.stringify(t.outputSchema) : '(none)');
  }
  process.exit(0);
}

const rows = tools.map((t) => ({
  name: t.name,
  src: fromJson.has(t.name) ? 'json' : 'code',
  input: describe(t.inputSchema),
  output: t.outputSchema ? describe(t.outputSchema) : '-',
  rw: t.annotations?.readOnlyHint ? 'ro' : t.annotations?.destructiveHint ? 'del' : 'wr',
}));

const w = (k) => Math.min(Math.max(...rows.map((r) => r[k].length)), 44);
const [wn, wi, wo] = [w('name'), w('input'), w('output')];
console.log(`${'NAME'.padEnd(wn)}  SRC   RW   ${'INPUT (*=required)'.padEnd(wi)}  OUTPUT`);
for (const r of rows) {
  console.log(`${r.name.padEnd(wn)}  ${r.src.padEnd(4)}  ${r.rw.padEnd(3)}  ${r.input.padEnd(wi)}  ${r.output}`);
}

const withOut = rows.filter((r) => r.output !== '-').length;
console.log(`\n${rows.length} tool(s); ${withOut} declare an output schema (the rest return text only).`);
console.log('A tool without an output schema still returns its payload as JSON text.');
