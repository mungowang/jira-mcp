#!/usr/bin/env node
/**
 * Capture the full structure of a real instance: one issue with every field, its sub-resources,
 * the create/edit screens, the agile hierarchy, and the whole Zephyr Scale test hierarchy
 * (test case -> steps -> attachments, cycle -> results -> summary, plan, folders, statuses).
 *
 * The point is to extend the entity schemas from real data instead of assumptions.
 *
 *   capture/raw/*.json   untouched payloads. GITIGNORED - company data, never commit.
 *   capture/report.md    structure only, every value stripped. Safe to share.
 *   capture/summary.json machine-readable shapes.
 *
 * Read-only: only read-only tools and GET requests.
 *
 * Usage:
 *   JIRA_BASE_URL=... JIRA_USERNAME=... JIRA_PASSWORD=... npm run capture:instance
 *   CAPTURE_PROJECT=DEMO CAPTURE_ISSUE=DEMO-1 CAPTURE_LIMIT=5 ... npm run capture:instance
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../test/harness.mjs';
import { discoverContext } from '../test/discover.mjs';
import { captureInstance, buildReport, buildSummary } from '../test/capture.mjs';

const env = {
  JIRA_BASE_URL: process.env.JIRA_BASE_URL,
  JIRA_USERNAME: process.env.JIRA_USERNAME,
  JIRA_PASSWORD: process.env.JIRA_PASSWORD,
  JIRA_AUTH: process.env.JIRA_AUTH ?? (process.env.JIRA_PAT ? 'pat' : 'basic'),
  ...(process.env.JIRA_PAT && { JIRA_PAT: process.env.JIRA_PAT }),
  ...(process.env.ZEPHYR_ALLOW_INTERNAL_API && { ZEPHYR_ALLOW_INTERNAL_API: process.env.ZEPHYR_ALLOW_INTERNAL_API }),
  ...(process.env.ZEPHYR_DEFAULT_PROJECT_KEY && { ZEPHYR_DEFAULT_PROJECT_KEY: process.env.ZEPHYR_DEFAULT_PROJECT_KEY }),
  JIRA_TIMEOUT_MS: process.env.JIRA_TIMEOUT_MS ?? '30000',
};
if (!env.JIRA_BASE_URL) {
  console.error('JIRA_BASE_URL is required. See the header of this file for usage.');
  process.exit(2);
}

const outDir = resolve(process.env.CAPTURE_DIR ?? 'capture');
const limit = Number(process.env.CAPTURE_LIMIT ?? 3);

const srv = await startServer(env, { timeoutMs: 60_000 });
try {
  console.log('\n-- discovering context --');
  const ctx = await discoverContext(srv, (l) => console.log(l));
  if (process.env.CAPTURE_PROJECT) ctx.projectKey = process.env.CAPTURE_PROJECT;
  if (process.env.CAPTURE_ISSUE) ctx.issueKey = process.env.CAPTURE_ISSUE;
  if (process.env.CAPTURE_ISSUE_TYPE) ctx.issueTypeName = process.env.CAPTURE_ISSUE_TYPE;
  ctx.jql = process.env.CAPTURE_JQL ?? (ctx.projectKey ? `project = ${ctx.projectKey} ORDER BY created DESC` : undefined);

  console.log(`\n-- capturing into ${outDir} (limit ${limit}) --`);
  const { captured, payloads } = await captureInstance(srv, ctx, { outDir, limit, log: (l) => console.log(l) });

  mkdirSync(outDir, { recursive: true });
  const report = buildReport({ captured, payloads, ctx });
  writeFileSync(resolve(outDir, 'report.md'), report);
  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(buildSummary({ captured, payloads }), null, 2));

  const ok = captured.filter((c) => !c.failed).length;
  console.log(`\n${ok}/${captured.length} step(s) captured.`);
  console.log(`  ${resolve(outDir, 'report.md')}   structure only - safe to share, this is what extends the schemas`);
  console.log(`  ${resolve(outDir, 'summary.json')} machine-readable shapes`);
  console.log(`  ${resolve(outDir, 'raw')}/        raw payloads WITH values - gitignored, do not commit`);
} finally {
  srv.stop();
}
