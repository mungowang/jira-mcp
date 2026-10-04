import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.ts';
import { registerAllTools } from './tools/index.ts';
import { setLogLevel } from './log.ts';

export type ZephyrStatus = { enabled: true; baseUrl: string; tools: number } | { enabled: false; reason: string };

/**
 * Mount the Zephyr Scale tools onto the same MCP server.
 * When Zephyr is not configured this is skipped silently so the core Jira tools still work.
 */
export function registerZephyr(server: McpServer): ZephyrStatus {
  if (process.env.ZEPHYR_ENABLED === 'false') return { enabled: false, reason: 'ZEPHYR_ENABLED=false' };

  // Single read-only switch: JIRA_READ_ONLY also constrains Zephyr, so one flag rules both.
  if (process.env.JIRA_READ_ONLY === 'true' && !process.env.ZEPHYR_READONLY) {
    process.env.ZEPHYR_READONLY = 'true';
  }

  const before = countTools(server);
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    return { enabled: false, reason: `Zephyr not configured, skipped: ${err instanceof Error ? err.message : String(err)}` };
  }
  setLogLevel(cfg.logLevel);
  registerAllTools(server, cfg);
  return { enabled: true, baseUrl: cfg.baseUrl, tools: countTools(server) - before };
}

/** McpServer exposes no public tool count; diff its private registry instead. */
function countTools(server: McpServer): number {
  const reg = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return reg ? Object.keys(reg).length : 0;
}
