import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.mjs';
import { startMock } from './mock-jira.mjs';
import { refs, undescribed } from './schema-walk.mjs';

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

describe('the $ref checker itself', () => {
  // Guards the guard. The first version of `refs` walked only `properties` and `items` and missed
  // the four `$ref`s that live inside `additionalProperties` - the value schema of a `z.record`.
  // These cases are the exact shapes that hid from it.
  test('it finds a $ref nested inside additionalProperties', () => {
    const schema = {
      type: 'object',
      properties: {
        author: { type: 'object', properties: { avatars: { type: 'object', additionalProperties: {} } } },
        editor: { type: 'object', properties: { avatars: { type: 'object',
          additionalProperties: { $ref: '#/properties/author/properties/avatars/additionalProperties' } } } },
      },
    };
    assert.deepEqual(refs(schema, 'tool'), ['tool.editor.avatars{} -> #/properties/author/properties/avatars/additionalProperties']);
  });

  test('a walk of properties and items alone would not have found it', () => {
    const shallow = (n, p, out = []) => {
      if (!n || typeof n !== 'object') return out;
      if (typeof n.$ref === 'string') out.push(p);
      if (n.properties) for (const [k, v] of Object.entries(n.properties)) shallow(v, `${p}.${k}`, out);
      if (n.items) shallow(n.items, `${p}[]`, out);
      return out;
    };
    const schema = { properties: { m: { additionalProperties: { $ref: '#/x' } } } };
    assert.deepEqual(shallow(schema, 'tool'), [], 'the old walk is blind to it - that was the bug');
    assert.equal(refs(schema, 'tool').length, 1, 'the current walk sees it');
  });

  test('it walks oneOf / anyOf / allOf too', () => {
    const schema = { oneOf: [{ properties: { a: { $ref: '#/a' } } }, { anyOf: [{ $ref: '#/b' }] }] };
    assert.equal(refs(schema, 't').length, 2);
  });

  test('undescribed holds named properties to it, but not map values', () => {
    // A map property still needs its own description - it has a name. Its *values* have none, so
    // requiring one there would ask for text nobody can place.
    const schema = {
      properties: {
        named: { type: 'string' },
        describedMap: { type: 'object', description: 'a map of things', additionalProperties: {} },
      },
    };
    assert.deepEqual(undescribed(schema, 't'), ['t.named']);
  });
});
