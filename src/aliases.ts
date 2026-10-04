import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Business alias -> field id. That is all this file may hold: types, allowed values and
 * requiredness are Jira data and are read at runtime, never copied here.
 *
 * The path is resolved relative to this module, not the cwd; otherwise aliases silently
 * disappear when the server is embedded in another app.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.JIRA_CONFIG_FILE ?? resolve(ROOT, 'jira.config.json');

export const aliases: Record<string, string> = (() => {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      process.stderr.write(`[jira-server] WARN cannot read ${CONFIG_PATH}: ${(err as Error).message}\n`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { fieldAliases?: Record<string, string> };
    const map = parsed?.fieldAliases ?? {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== 'string' || !/^customfield_\d+$/.test(v)) {
        process.stderr.write(
          `[jira-server] WARN alias '${k}' must map to customfield_<number>, got ${JSON.stringify(v)}; ignored\n`,
        );
        delete map[k];
      }
    }
    return map;
  } catch (err) {
    // The file exists but is broken JSON - say so loudly, otherwise aliases vanish mysteriously.
    process.stderr.write(`[jira-server] WARN ${CONFIG_PATH} is not valid JSON; all aliases ignored: ${(err as Error).message}\n`);
    return {};
  }
})();

const back = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [v, k]));

/** field id -> business alias (used by describe output to hint the model) */
export const aliasOf = (id: string): string | undefined => back[id];

/** Translate aliases to real field ids before sending; the model may use either. */
export const expand = (fields: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [aliases[k] ?? k, v]));
