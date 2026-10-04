import { jira } from './jira.ts';
import type { Tool } from './tool.ts';
import { resolveType, TYPE_NAMES } from './types.ts';
import { E, ENTITY_NAMES } from './entity-types.ts';

/** "{x}" -> the raw value (type preserved); "a{x}b" -> interpolated and escaped. */
function fill(tpl: string, args: Record<string, unknown>): unknown {
  const whole = /^\{(\w+)\}$/.exec(tpl);
  if (whole) return args[whole[1]];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(args?.[k] ?? '')));
}

const deepFill = (v: unknown, args: Record<string, unknown>): unknown =>
  typeof v === 'string' ? fill(v, args)
  : Array.isArray(v) ? v.map((x) => deepFill(x, args))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFill(x, args)]))
  : v;

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Fail fast: a broken plugin declaration must be reported at startup, not at call time. */
function validate(name: string, d: Record<string, any>, source: string): void {
  const at = `${source} -> tool '${name}'`;
  if (!d || typeof d !== 'object') throw new Error(`${at}: definition must be an object`);
  if (!d.desc) throw new Error(`${at}: missing 'desc'`);
  if (!METHODS.has(d.method)) throw new Error(`${at}: 'method' must be one of ${[...METHODS].join('/')}, got ${JSON.stringify(d.method)}`);
  if (typeof d.path !== 'string' || !d.path) throw new Error(`${at}: missing 'path'`);
  for (const [k, t] of Object.entries(d.params ?? {})) {
    if (typeof t !== 'string' || !TYPE_NAMES.includes(t as never)) {
      throw new Error(
        `${at}: param '${k}' has type ${JSON.stringify(t)} which is not in the registry. ` +
        `Available: ${TYPE_NAMES.join(', ')} (add new types in src/types.ts)`,
      );
    }
    if (!new RegExp(`\\{${k}\\}`).test(JSON.stringify(d))) {
      throw new Error(`${at}: param '${k}' is declared but never used (reference it as {${k}} in path/query/body)`);
    }
  }
  for (const k of d.required ?? []) {
    if (!(k in (d.params ?? {}))) throw new Error(`${at}: 'required' lists '${k}' which is not in 'params'`);
  }
  if (d.returns !== undefined && !ENTITY_NAMES.includes(d.returns)) {
    throw new Error(
      `${at}: 'returns' is ${JSON.stringify(d.returns)}, which is not in the entity registry. ` +
      `Available: ${ENTITY_NAMES.join(', ')}. Use 'anyObject' when the payload shape is unknown, ` +
      `or add a type in src/entity-types.ts.`,
    );
  }
}

/** Generate tools from JSON declarations - adding a plugin means adding JSON, not code. */
export function toolsFromJson(defs: Record<string, any>, source = 'tools.d'): Record<string, Tool> {
  return Object.fromEntries(Object.entries(defs).map(([name, d]: [string, any]) => {
    validate(name, d, source);
    return [name, {
      desc: d.desc,
      readOnly: !!d.readOnly,
      destructive: !!d.destructive,
      // Mirrors the code-declared tools: a declared return type becomes outputSchema and the
      // handler result is also returned as structuredContent.
      ...(d.returns ? { returns: E[d.returns as keyof typeof E] } : {}),
      input: Object.fromEntries(
        Object.entries(d.params ?? {}).map(([k, t]) => {
          const base = resolveType(t as string);
          return [k, (d.required ?? []).includes(k) ? base : base.optional()];
        }),
      ) as never,
      run: (args: Record<string, unknown>) => jira(d.method, fill(d.path, args) as string, {
        query: d.query ? (deepFill(d.query, args) as Record<string, unknown>) : undefined,
        body: d.body === undefined ? undefined : deepFill(d.body, args),
      }),
    }];
  }));
}
