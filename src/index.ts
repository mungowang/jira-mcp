import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerAll } from './tool.ts';
import { entities } from './entities/index.ts';
import { toolsFromJson } from './jsonTools.ts';
import { registerZephyr } from './entities/zephyr/register.ts';
import { baseUrlProblem } from './jira.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = resolve(ROOT, 'tools.d');

// tools.d/*.json - plugin declarations. Core entities live in src/entities/, plugins here.
const jsonTools = Object.assign({}, ...readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const file = resolve(TOOLS_DIR, f);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`cannot read plugin declaration ${file}: ${(err as Error).message}`);
    }
    let parsed: { tools?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`plugin declaration ${file} is not valid JSON: ${(err as Error).message}`);
    }
    return toolsFromJson(parsed.tools ?? {}, `tools.d/${f}`);
  }));

/**
 * The version a client sees in `serverInfo` has to be the version it installed, not a constant that
 * was true once. Read it from the package manifest; ROOT resolves to the package root both in a
 * checkout (src/) and in an install (dist/), so the same lookup works for both.
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const server = new McpServer({ name: 'jira-server', version: VERSION });

// 1) Core entities + JSON-declared plugins.
registerAll(server, [...entities, jsonTools], { readOnly: process.env.JIRA_READ_ONLY === 'true' });

// 2) Zephyr Scale (skipped when not configured).
const zephyr = registerZephyr(server);

// A bad base used to surface only as `fetch failed` deep inside the first call. Say it up front,
// and say it without quoting the value (a host may inject it from a secret store and mask it).
const baseProblem = baseUrlProblem();
if (baseProblem !== null) process.stderr.write(`[jira-server] WARN ${baseProblem}\n`);

process.stderr.write(
  `[jira-server] v${VERSION} started; zephyr: ${zephyr.enabled ? `${zephyr.tools} tools @ ${zephyr.baseUrl}` : `off (${zephyr.reason})`}` +
  `${baseProblem !== null ? '; BASE URL UNUSABLE (see WARN above)' : ''}` +
  `${process.env.JIRA_READ_ONLY === 'true' ? '; READ-ONLY' : ''}\n`,
);

await server.connect(new StdioServerTransport());
