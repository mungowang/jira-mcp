import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { discoverContext } from './discover.mjs';
import {
  shapeOf, mergeShapes, renderShape, captureInstance, buildReport, buildSummary,
  issuePresence, checkSchemas, checkCaptureDir, ENTITY_FOR_STEP,
} from './capture.mjs';

describe('shape helpers', () => {
  test('scalars are typed without carrying their value', () => {
    assert.deepEqual(shapeOf('secret value'), { t: 'string' });
    assert.deepEqual(shapeOf(''), { t: 'string', empty: true });
    assert.deepEqual(shapeOf(3), { t: 'int' });
    assert.deepEqual(shapeOf(3.5), { t: 'number' });
    assert.deepEqual(shapeOf(true), { t: 'boolean' });
    assert.deepEqual(shapeOf(null), { t: 'null' });
  });

  test('arrays merge their item shapes and keep the largest length', () => {
    const s = mergeShapes([shapeOf([{ id: 1 }]), shapeOf([{ id: 2 }, { name: 'x' }])]);
    assert.equal(s.t, 'array');
    assert.equal(s.n, 2);
    assert.deepEqual(Object.keys(s.of.keys).sort(), ['id', 'name']);
  });

  test('mergeShapes records presence and which keys were always there', () => {
    const s = mergeShapes([shapeOf({ id: '1', key: 'A', extra: 1 }), shapeOf({ id: '2', key: 'B' })]);
    assert.deepEqual(s.always, ['id', 'key']);
    assert.equal(s.keys.extra.present, '1/2');
    assert.equal(s.keys.id.present, '2/2');
  });

  test('renderShape stars each always-present key, not the object', () => {
    const tree = renderShape(mergeShapes([shapeOf({ a: 1, b: 2 }), shapeOf({ a: 3 })])).join('\n');
    assert.match(tree, /^object$/m, 'the object line carries no star');
    assert.match(tree, /a: int {2}\*$/m, 'a was in every sample');
    assert.match(tree, /b: int$/m, 'b was in one of two');
  });
});

describe('capture against a real-shaped instance', () => {
  const PORT = 18120;
  let mock, srv, outDir, result;

  before(async () => {
    mock = await startMock(PORT);
    srv = await startServer({
      JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong', ZEPHYR_ALLOW_INTERNAL_API: 'true',
    });
    const ctx = await discoverContext(srv);
    outDir = mkdtempSync(resolve(tmpdir(), 'capture-test-'));
    result = await captureInstance(srv, ctx, { outDir, limit: 3 });
    const report = buildReport({ captured: result.captured, payloads: result.payloads, ctx });
    result.report = report;
    result.ctx = ctx;
    writeFileSync(resolve(outDir, 'report.md'), report);
  });
  after(() => { srv?.stop(); mock?.server.close(); rmSync(outDir, { recursive: true, force: true }); });

  test('writes raw payloads and a report', () => {
    const raw = readdirSync(resolve(outDir, 'raw'));
    assert.ok(raw.length > 20, `expected many raw payloads, got ${raw.length}`);
    assert.ok(raw.includes('issueFull.json'));
    assert.ok(raw.includes('testCaseFull.json'));
    assert.ok(raw.includes('testRunResults.json'));
  });

  test('the shareable report carries no values', () => {
    // Every one of these exists in the raw payloads and must not reach report.md.
    const secrets = [
      ['Alice', 'me.json'],
      ['Platform', 'issueSample.json'],
      ['a.txt', 'issueAttachments.json'],
    ];
    for (const [value, file] of secrets) {
      const raw = readFileSync(resolve(outDir, 'raw', file), 'utf8');
      assert.ok(raw.includes(value), `${file} should contain the sample value (test is meaningful)`);
      assert.ok(!result.report.includes(value), `report.md must not leak "${value}"`);
    }
  });

  test('the report documents field types, screens and presence', () => {
    assert.match(result.report, /## Jira fields/);
    assert.match(result.report, /\| `customfield_20001` \| Department \| option \|/);
    assert.match(result.report, /## Issue entity evidence/);
    assert.match(result.report, /Merged over \*\*2\*\* sampled issue/);
    assert.match(result.report, /\| `customfield_20001` \| 1\/2 \|/);
    assert.match(result.report, /\| `summary` \| 2\/2 \|/);
  });

  test('issuePresence marks the envelope keys that were always present', () => {
    const p = issuePresence(result.payloads);
    assert.equal(p.total, 2);
    assert.ok(p.envelope.always.includes('id'));
    assert.ok(p.envelope.always.includes('key'));
    assert.ok(p.envelope.always.includes('fields'));
  });

  test('issuePresence separates "key present" from "value actually filled"', () => {
    // Jira answers every field key on every issue, mostly with null. `filled` is the figure that
    // says whether a custom field is really used, so both have to be reported.
    const p = issuePresence(result.payloads);
    const summary = p.fields.find((f) => f.id === 'summary');
    assert.equal(summary.present, 2);
    assert.equal(summary.filled, 2, 'summary had a value on both sampled issues');
    const dept = p.fields.find((f) => f.id === 'customfield_20001');
    assert.equal(dept.present, 1);
    assert.equal(dept.filled, 1);
  });

  test('captured payloads satisfy the entity schemas they are mapped to', () => {
    const checks = checkSchemas(result.captured, result.payloads);
    assert.ok(checks.length >= 20, `expected many checks, got ${checks.length}`);
    const bad = checks.filter((c) => !c.ok);
    assert.deepEqual(bad, [], `schema mismatches: ${JSON.stringify(bad, null, 2)}`);
  });

  test('the folder tree root is not a folder node', () => {
    // The root of a folder tree is the project and carries no `id`; the children do.
    assert.equal(ENTITY_FOR_STEP.folderTree, 'folderTree');
    assert.equal(ENTITY_FOR_STEP.statusOptions, 'statusOptions');
  });

  test('--check can re-validate a saved capture with no network', () => {
    const { checks, found } = checkCaptureDir(outDir);
    assert.ok(found.length >= 20);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
  });

  test('Zephyr entities are sampled so their presence is meaningful', () => {
    assert.ok(Array.isArray(result.payloads.testCaseSamples), 'test cases sampled');
    assert.ok(result.payloads.testCaseSamples.length >= 2);
    const merged = result.captured.find((c) => c.name === 'testCaseSamples').shape;
    assert.ok(merged.always.includes('key'), 'key is on every test case');
    // `status` is on only one of the mock's two cases, so it must not be treated as stable.
    assert.ok(!merged.always.includes('status'), 'status is not on every test case');
    assert.equal(merged.keys.status.present, '1/2');
  });

  test('the report carries the Zephyr evidence and the schema check', () => {
    assert.match(result.report, /## Zephyr entity evidence/);
    assert.match(result.report, /## Schema check/);
    assert.match(result.report, /satisfy the entity schema/);
  });

  test('CAPTURE_REDACT removes the identifiers, leaving only names and structure', () => {
    const redacted = buildReport({ captured: result.captured, payloads: result.payloads, ctx: result.ctx, redact: true });
    for (const v of [result.ctx.projectKey, result.ctx.issueKey, String(result.ctx.boardId), result.ctx.testCaseKey]) {
      if (!v) continue;
      assert.ok(!redacted.includes(`\`${v}\``), `redacted report must not contain the identifier ${v}`);
    }
    assert.match(redacted, /Context: project `<key>`/);
    assert.match(redacted, /no field values/);
  });

  test('the machine-readable summary mirrors the report shapes', () => {
    const s = buildSummary({ captured: result.captured, payloads: result.payloads });
    assert.ok(s.issuePresence.total >= 1);
    assert.ok(Object.keys(s.shapes).length > 5);
    assert.ok(s.shapes.issueFull);
  });
});
