import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';

/**
 * The tool surface is what the model sees. A missing description is not a cosmetic problem: the
 * model has to guess what a parameter means, and a `$ref` is worse - a client that does not
 * resolve it shows the model no type at all.
 *
 * These invariants exist because both failures are invisible in a diff and in the UI. Every input
 * parameter here is described, and the whole surface stays free of `$ref`.
 */
const PORT = 18094;
const ENV = {
  JIRA_BASE_URL: `http://127.0.0.1:${PORT}`, JIRA_AUTH: 'basic',
  JIRA_USERNAME: 'alice', JIRA_PASSWORD: 's3cretlong',
  ZEPHYR_ALLOW_INTERNAL_API: 'true', ZEPHYR_DEFAULT_PROJECT_KEY: 'PROJ',
};

const has = (s) => typeof s === 'string' && s.trim().length > 0;

/** Every `$ref` in a schema, with the path that holds it. */
function refs(node, path, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.$ref === 'string') out.push(`${path} -> ${node.$ref}`);
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) refs(v, `${path}.${k}`, out);
  if (node.items) refs(node.items, `${path}[]`, out);
  return out;
}

/** Every property at every level that carries no description. */
function undescribed(node, path, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) {
      if (!has(v.description)) out.push(`${path}.${k}`);
      undescribed(v, `${path}.${k}`, out);
    }
  }
  if (node.items) undescribed(node.items, `${path}[]`, out);
  return out;
}

let mock, srv, tools;
before(async () => {
  mock = await startMock(PORT);
  srv = await startServer(ENV);
  tools = await srv.listTools();
});
after(() => { srv?.stop(); mock?.server.close(); });

describe('tool descriptions', () => {
  test('the whole surface is loaded, core and Zephyr', () => {
    assert.equal(tools.length, 109, '109 tools: 55 core + 54 Zephyr');
  });

  test('every tool describes itself', () => {
    const bare = tools.filter((t) => !has(t.description)).map((t) => t.name);
    assert.deepEqual(bare, [], 'a tool without a description is one the model cannot choose correctly');
  });

  test('every input parameter is described', () => {
    const bare = [];
    for (const t of tools) {
      for (const [k, v] of Object.entries(t.inputSchema?.properties ?? {})) {
        if (!has(v.description)) bare.push(`${t.name}.${k}`);
      }
    }
    assert.deepEqual(bare, []);
  });

  test('every declared output field is described, nested ones included', () => {
    const bare = [];
    for (const t of tools) {
      if (t.outputSchema) bare.push(...undescribed(t.outputSchema, t.name));
    }
    assert.deepEqual(bare, []);
  });

  test('no schema uses $ref', () => {
    // The MCP SDK emits `$ref` when one Zod instance is reused inside a schema. A client that does
    // not resolve `$ref` then shows the model no type and no description for that field, so the
    // registries build repeated fields from functions instead of sharing instances.
    const found = [];
    for (const t of tools) {
      found.push(...refs(t.inputSchema, `${t.name} (input)`));
      if (t.outputSchema) found.push(...refs(t.outputSchema, `${t.name} (output)`));
    }
    assert.deepEqual(found, []);
  });

  test('input schemas reject unknown parameters, output schemas tolerate new keys', () => {
    // A contract statement. Tools that declare params must close the object; a tool with no params
    // carries no `additionalProperties` at all, which is the SDK's shape for an empty input and is
    // harmless (Zod drops unknown keys). Output must stay open: Jira adds keys between versions.
    for (const t of tools) {
      const declared = Object.keys(t.inputSchema?.properties ?? {}).length;
      if (declared > 0) {
        assert.equal(t.inputSchema?.additionalProperties, false, `${t.name}: input must reject unknown params`);
      }
      if (t.outputSchema) {
        assert.equal(t.outputSchema.additionalProperties, true, `${t.name}: output must tolerate new server keys`);
      }
    }
  });
});
