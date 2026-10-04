import type { ZodRawShape, ZodTypeAny } from 'zod';

// The single abstraction. Adding a tool means adding one of these objects.
export type Tool<I = any, R = unknown> = {
  desc: string;
  input?: ZodRawShape;
  /**
   * Return type (an entity envelope). When declared it becomes the MCP outputSchema
   * and the SDK validates structuredContent against it.
   * Do NOT declare it on tools that can return an empty 204 response.
   */
  returns?: ZodTypeAny;
  /** Read-only. Exposed as the MCP readOnlyHint annotation so clients can auto-approve. */
  readOnly?: boolean;
  /** Destructive operation (deletes). Exposed as destructiveHint. */
  destructive?: boolean;
  run: (args: I) => Promise<R>;
};
export const defineTool = <I, R>(t: Tool<I, R>): Tool<I, R> => t;

/** Text shown to the model: strings verbatim, empty responses as a readable word, else JSON. */
export function renderResult(out: unknown): string {
  if (typeof out === 'string') return out;
  // Jira returns 204 with an empty body for PUT/DELETE, so `out` is undefined.
  // Left unhandled, `text` would be undefined and fail MCP result validation.
  if (out === undefined || out === null) return 'ok';
  return JSON.stringify(out, null, 2);
}

export function registerAll(
  server: any,
  groups: Record<string, Tool>[],
  opts: { readOnly?: boolean } = {},
) {
  const merged: Record<string, Tool> = Object.assign({}, ...groups); // later wins, so JSON can override code defaults
  for (const [name, t] of Object.entries(merged)) {
    if (opts.readOnly && !t.readOnly) continue;
    server.registerTool(
      name,
      {
        description: t.desc,
        inputSchema: t.input ?? {},
        ...(t.returns ? { outputSchema: t.returns } : {}),
        annotations: { readOnlyHint: !!t.readOnly, ...(t.destructive ? { destructiveHint: true } : {}) },
      },
      async (args: any) => {
        try {
          const out = await t.run(args ?? {});
          const text = renderResult(out);
          if (!t.returns) return { content: [{ type: 'text', text }] };
          // A declared outputSchema requires structuredContent (enforced by the SDK).
          if (typeof out !== 'object' || out === null) {
            throw new Error(
              `${name} declares \`returns\` but Jira returned an empty/non-object response ` +
              `(usually a 204). Remove the \`returns\` declaration from this tool - ` +
              `this is an implementation error, not a call error.`,
            );
          }
          return { content: [{ type: 'text', text }], structuredContent: out as Record<string, unknown> };
        } catch (e: any) {
          return { content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true };
        }
      },
    );
  }
}
