import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerAll } from './tool.ts';
import { entities } from './entities/index.ts';
import { toolsFromJson } from './jsonTools.ts';
import { registerZephyr } from './entities/zephyr/register.ts';

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

const server = new McpServer({ name: 'jira-server', version: '1.0.0' });

// 1) Core entities + JSON-declared plugins.
registerAll(server, [...entities, jsonTools], { readOnly: process.env.JIRA_READ_ONLY === 'true' });

// 2) Zephyr Scale (skipped when not configured).
const zephyr = registerZephyr(server);

process.stderr.write(
  `[jira-server] started; zephyr: ${zephyr.enabled ? `${zephyr.tools} tools @ ${zephyr.baseUrl}` : `off (${zephyr.reason})`}` +
  `${process.env.JIRA_READ_ONLY === 'true' ? '; READ-ONLY' : ''}\n`,
);

await server.connect(new StdioServerTransport());
