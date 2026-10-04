import { z } from 'zod';

/**
 * Named input-type registry, shared by code and JSON declarations.
 * Holds only *shape* and *usage* knowledge. Concrete field ids and allowed values are
 * Jira data and must never live here.
 * Every `.describe()` ends up in the JSON Schema the model sees, so writing a hint once
 * makes every tool that reuses the type inherit it.
 */
export const T = {
  issueKey: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'issue key looks like PROJ-123')
    .describe('issue key, e.g. PROJ-123'),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'project key looks like PROJ')
    .describe('project key, e.g. PROJ'),
  jql: z.string().describe('JQL, e.g. project = PROJ AND status = Open'),
  fieldIds: z.array(z.string()).describe('field ids; custom fields are customfield_xxxxx'),
  fields: z.record(z.string(), z.any())
    .describe('Field object. Keys may be field ids or business aliases; get the value shape from jira_describe_create / jira_describe_edit first'),
  username: z.string().describe('Username. Jira Server uses `name`, not the Cloud `accountId`'),
  boardId: z.number().int().positive().describe('numeric board id'),
  numericId: z.string().regex(/^\d+$/, 'expected a numeric id').describe('numeric id passed as a string'),
  restPath: z.string().describe('REST path, e.g. /issue/PROJ-1, or a plugin module like /rest/tempo-timesheets/4/worklogs'),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  // Primitive names usable from JSON declarations.
  string: z.string(), number: z.number(), boolean: z.boolean(),
  object: z.record(z.string(), z.any()), array: z.array(z.any()),
} as const;

export type TypeName = keyof typeof T;
export const TYPE_NAMES = Object.keys(T) as TypeName[];

/** Unknown names are not silently downgraded to z.any(); jsonTools fails loudly at startup. */
export function resolveType(name: string): z.ZodTypeAny {
  return T[name as TypeName];
}
