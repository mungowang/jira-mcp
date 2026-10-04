import { jira } from '../jira.ts';
import { defineTool } from '../tool.ts';
import { E } from '../entity-types.ts';

/**
 * Plugin inventory without UPM.
 *
 * `/rest/plugins/1.0` is not always available: on a real Jira 8.5.7 instance with a normal
 * (non-admin) account the first spelling answered 406 and the second 404. The custom field
 * catalogue is readable with ordinary permissions and leaks the plugin keys through
 * `schema.custom`, which is enough to know which vendors are actually installed.
 */
function inferFromFieldSchemas(fields: unknown): Array<{ pluginKey: string; fieldCount: number; sampleFields: string[] }> {
  if (!Array.isArray(fields)) return [];
  const byPlugin = new Map<string, { fieldCount: number; sampleFields: string[] }>();
  for (const f of fields as Array<Record<string, any>>) {
    const custom = f?.schema?.custom;
    if (typeof custom !== 'string' || !custom) continue;
    // e.g. "com.example.greenhopper:gh-sprint" -> "com.example.greenhopper"
    const pluginKey = custom.includes(':') ? custom.slice(0, custom.indexOf(':')) : custom;
    const entry = byPlugin.get(pluginKey) ?? { fieldCount: 0, sampleFields: [] };
    entry.fieldCount += 1;
    if (entry.sampleFields.length < 5 && typeof f.name === 'string') entry.sampleFields.push(f.name);
    byPlugin.set(pluginKey, entry);
  }
  return [...byPlugin.entries()]
    .map(([pluginKey, v]) => ({ pluginKey, ...v }))
    .sort((a, b) => b.fieldCount - a.fieldCount);
}

export const pluginInventory = {
  jira_list_plugins: defineTool({
    readOnly: true, returns: E.plugins,
    desc: 'List installed UPM plugins when the account may read /rest/plugins/1.0. If UPM is '
      + 'unavailable, falls back to inferring plugin keys from custom field schemas and reports '
      + 'why each UPM path failed',
    input: {},
    run: async () => {
      const attempts: Array<{ path: string; outcome: string }> = [];
      for (const path of ['/rest/plugins/1.0/', '/rest/plugins/1.0']) {
        try {
          const data = await jira<Record<string, unknown>>('GET', path, { query: { 'max-results': 200 } });
          return { ...data, pluginInventory: 'ok', attempts: [...attempts, { path, outcome: 'ok' }] };
        } catch (err) {
          attempts.push({ path, outcome: (err as Error).message.replace(/\s+/g, ' ').slice(0, 200) });
        }
      }

      // UPM is not usable for this account; fall back to the field catalogue.
      let inferredFromFields: ReturnType<typeof inferFromFieldSchemas> = [];
      try {
        inferredFromFields = inferFromFieldSchemas(await jira('GET', '/field'));
      } catch { /* the note below covers it */ }

      return {
        plugins: [],
        pluginInventory: 'unavailable',
        attempts,
        inferredFromFields,
        note: 'UPM (/rest/plugins/1.0) is not readable with this account - it normally needs Jira '
          + 'administrator rights. plugin keys below were inferred from custom field schemas, which '
          + 'is enough to see which plugins are installed but carries no version numbers.',
      };
    },
  }),
};
