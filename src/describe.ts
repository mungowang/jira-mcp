import { jira } from './jira.ts';
import { aliasOf } from './aliases.ts';

/**
 * The only place that needs to "know Jira": how a field's schema type maps to the value
 * shape the REST API expects. Everything else is read from Jira at runtime.
 */
function shape(f: any): string | null {
  const s = f.schema ?? {};
  const t = s.type, items = s.items;
  if (t === 'array') { const inner = shape({ schema: { type: items } }); return inner ? `[${inner}]` : null; }
  if (t === 'option' || t === 'priority' || t === 'resolution') return '{"id":"..."}';
  if (t === 'user') return '{"name":"username"}';          // Server uses `name`, not Cloud's accountId
  if (t === 'project') return '{"key":"PROJ"}';
  if (t === 'version' || t === 'component') return '{"id":"..."}';
  if (t === 'number') return '123';
  if (t === 'date') return '"2026-01-01"';
  if (t === 'datetime') return '"2026-01-01T09:00:00.000+0800"';
  if (t === 'string') return '"text"';
  return null;                                             // not writable (attachment/issuelink/...)
}

/**
 * Render Jira's create/edit metadata as a fill-in-the-blanks template instead of dumping
 * nested JSON on the model. Writable fields only.
 */
export function render(meta: any, title: string, suggestedCall: string): string {
  const rows = Object.entries(meta?.fields ?? {})
    .map(([id, f]: any) => ({ id, ...f, _shape: shape(f) }))
    .filter((f: any) => f._shape);
  const fmt = (f: any) => {
    const kind = f.schema?.type === 'array' ? `array<${f.schema.items}>` : (f.schema?.type ?? '?');
    const vals = f.allowedValues?.length
      ? '  allowed: ' + f.allowedValues.slice(0, 8)
          .map((v: any) => `${v.value ?? v.name ?? v.displayName}(${v.id ?? v.name})`).join(' | ')
      : '';
    const alias = aliasOf(f.id);
    const label = alias ? `${f.id}(${alias})` : f.id;
    return `  ${label.padEnd(30)} ${kind.padEnd(14)} -> ${f._shape}${vals}`;
  };
  const req = rows.filter((f: any) => f.required);
  const opt = rows.filter((f: any) => !f.required);
  return [
    `${title} - ${rows.length} writable field(s), ${req.length} required`,
    req.length ? `\nRequired:\n${req.map(fmt).join('\n')}` : '',
    opt.length ? `\nOptional:\n${opt.map(fmt).join('\n')}` : '',
    `\nFill in the shapes above, then call: ${suggestedCall}`,
  ].join('\n');
}

export const describeCreate = (projectKey: string, issueTypeName: string) =>
  jira<any>('GET', '/issue/createmeta', {
    query: { projectKeys: projectKey, issuetypeNames: issueTypeName, expand: 'projects.issuetypes.fields' },
  }).then((r) => render(
    r.projects[0].issuetypes[0],
    `Project ${projectKey} / issue type ${issueTypeName} - fields available on create`,
    'jira_create_issue({ fields: {...} })',
  ));

export const describeEdit = (key: string) =>
  jira<any>('GET', `/issue/${key}/editmeta`).then((r) => render(
    r,
    `Issue ${key} - fields editable right now`,
    'jira_update_issue({ key, fields: {...} })',
  ));
