#!/usr/bin/env node
/**
 * Probe candidate Jira / plugin REST paths and report the status code of each.
 *
 * Read-only: every request is a GET, or a POST only when --methods includes POST and the
 * path is in the built-in candidate list. Nothing is created.
 *
 * Usage:
 *   JIRA_BASE_URL=... JIRA_USERNAME=... JIRA_PASSWORD=... node scripts/probe-paths.mjs
 *   ... node scripts/probe-paths.mjs /rest/myplugin/1.0/thing /another/path
 *
 * 404 means "no such resource"; 405 means "the path exists but not for this method";
 * 401/403 is a permission answer; 200 means it works.
 */
import { resolveUrl } from '../src/jira.ts';

const BASE = process.env.JIRA_BASE_URL;
if (!BASE) {
  console.error('JIRA_BASE_URL is required.');
  process.exit(2);
}

const AUTH = process.env.JIRA_PAT
  ? `Bearer ${process.env.JIRA_PAT}`
  : 'Basic ' + Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_PASSWORD}`).toString('base64');

import { CANDIDATES } from '../test/probe-candidates.mjs';

const extra = process.argv.slice(2).filter((a) => a.startsWith('/'));
const paths = extra.length ? extra : CANDIDATES;

const probe = async (method, path) => {
  const started = Date.now();
  try {
    const res = await fetch(resolveUrl(path), {
      method,
      headers: { Authorization: AUTH, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
    return { status: res.status, ms: Date.now() - started, body };
  } catch (err) {
    return { status: 'ERR', ms: Date.now() - started, body: err?.message ?? String(err) };
  }
};

console.log(`Probing ${BASE} as ${process.env.JIRA_USERNAME ?? '(pat)'}`);
console.log(`GET on ${paths.length} candidate path(s)\n`);

const hits = [];
for (const path of paths) {
  const r = await probe('GET', path);
  const mark = r.status === 200 ? 'OK  ' : r.status === 405 ? '405 ' : r.status === 404 ? '404 ' : String(r.status).padEnd(4);
  console.log(`  ${mark} ${path}${r.body ? `  <- ${r.body}` : ''}`);
  if (r.status === 200) hits.push(path);
  // A 405 on GET often means the resource is POST-only; worth one follow-up probe.
  if (r.status === 405) {
    const p = await probe('POST', path);
    console.log(`       POST -> ${p.status}${p.body ? `  <- ${p.body}` : ''}`);
    if (p.status === 200 || p.status === 201) hits.push(`${path} (POST)`);
  }
}

console.log(`\nReachable: ${hits.length ? hits.join(', ') : 'none'}`);
console.log('Paste this output back to turn the reachable ones into tools.d declarations.');
