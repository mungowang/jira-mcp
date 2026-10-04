import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.ts';
import { registerTestCaseTools } from './testCases.ts';
import { registerFolderTools } from './folders.ts';
import { registerTestRunTools } from './testRuns.ts';
import { registerTestResultTools } from './testResults.ts';
import { registerMiscTools } from './misc.ts';
import { registerTestPlanTools } from './testPlans.ts';
import { registerAttachmentTools } from './attachments.ts';
import { registerAutomationTools } from './automation.ts';
import { registerRunMaintenanceTools } from './runMaintenance.ts';
import { registerResultsMaintenanceTools } from './resultsMaintenance.ts';
import { registerInternalRefsTools } from './internalRefs.ts';

/**
 * Register every tool on the server. The order below is the order tools/list reports them in:
 * the public API-v1 groups first, then the maintenance groups (run composition, execution history)
 * and the internal-API project metadata, then the diagnostics of misc.
 *
 * registerResultsMaintenanceTools and registerInternalRefsTools register nothing at all unless
 * cfg.allowInternalApi is true.
 */
export function registerAllTools(server: McpServer, cfg: Config): void {
  registerTestCaseTools(server, cfg);
  registerFolderTools(server, cfg);
  registerTestRunTools(server, cfg);
  registerTestResultTools(server, cfg);
  registerTestPlanTools(server, cfg);
  registerAttachmentTools(server, cfg);
  registerAutomationTools(server, cfg);
  registerRunMaintenanceTools(server, cfg);
  registerResultsMaintenanceTools(server, cfg);
  registerInternalRefsTools(server, cfg);
  registerMiscTools(server, cfg);
}
