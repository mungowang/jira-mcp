# Plugin declarations (`tools.d/`)

Every `*.json` file **directly inside this directory** is loaded at startup and turned into
tools. That is the whole mechanism: adding a plugin means adding JSON, not code.

`examples/` is **not** loaded (the loader only reads `*.json` in this directory, not
subdirectories). Copy a file out of it to enable it.

## Declaration reference

```jsonc
{
  "tools": {
    "jira_tempo_worklogs": {
      "desc": "Query Tempo worklogs (Tempo Timesheets plugin)",  // required
      "readOnly": true,          // optional; becomes the MCP readOnlyHint annotation
      "destructive": false,      // optional; becomes destructiveHint (use for deletes)
      "params": {                // required (may be empty); the tool's input schema
        "from": "string",        // value = a name from src/types.ts
        "to": "string",
        "projectKey": "projectKey"   // reuses the registry's regex + description
      },
      "required": ["from", "to"],    // optional; params that are not optional
      "returns": "paged",            // optional; an entity name from src/entity-types.ts
      "method": "GET",               // GET | POST | PUT | PATCH | DELETE
      "path": "/rest/tempo-timesheets/4/worklogs",
      "query": {                     // optional
        "from": "{from}",            // "{x}" alone  -> the raw value, type preserved
        "projectKey": "{projectKey}" // "a{x}b"      -> string interpolation, URL-escaped
      },
      "body": "{payload}"            // optional; same placeholder rules, deep for objects
    }
  }
}
```

### Return types

`returns` is the output-side mirror of `params`. When set, the tool gets an MCP `outputSchema`
and its result is also returned as `structuredContent`, exactly like a code-declared tool - so a
JSON plugin is no longer second-class in what the model can see.

Available names come from `src/entity-types.ts`:

```
issue  createdIssue  searchResult  transitions  comment  comments  worklog  worklogs
attachment  attachmentList  project  user  serverInfo  plugins  paged  agileIssues
linkTypes  watchers  sprint  testCase  testRun  testResult  anyObject
```

Use **`anyObject`** when the payload shape is not known: MCP requires an object at the root of an
output schema, so that is the loosest honest declaration ("an object, contents unspecified").
Omit `returns` entirely for an endpoint that can answer **204 with an empty body** - a declared
output schema requires `structuredContent`, and an empty body violates it. That is why
`update`/`delete`/`transition` style tools declare none.

To inspect what a declaration actually produces:

```bash
npm run tools:describe -- jira_jsm     # one line: input and output structure
npm run tools:describe -- --json jira  # full inputSchema / outputSchema
```

### Describing a parameter

A param value is either a type name, or an object when the hint has to be specific to this tool:

```jsonc
"params": {
  "name":    { "type": "string", "describe": "endpoint name, the last path segment" },
  "payload": "object"                    // the short form is still fine
}
```

Only `type` and `describe` are allowed in the object form; anything else fails at startup.

This matters beyond wording: `.describe()` produces a **new** schema instance, so a type used twice
in one tool stays inline. Reusing one instance twice makes the MCP SDK emit a `$ref` to its first
occurrence, and a client that does not resolve `$ref` then sees no type or description at all.

### Type names

`params` values come from the registry in `src/types.ts`. Available today:

```
issueKey  projectKey  jql  fieldIds  fields  username  boardId
restPath  httpMethod  string  number  boolean  object  array
```

Using a name that is not in that list fails at startup (it does not silently degrade to
`any`). To add one, extend `T` in `src/types.ts` — code and JSON share it.

### Validation performed at startup

The server refuses to start, naming the file and the offending key, when:

- `desc`, `method` or `path` is missing
- `method` is not one of the five verbs
- a `params` value is not a known type name
- a declared param is never referenced as `{name}` in `path`/`query`/`body`
- `required` lists something that is not in `params`
- the file itself is not valid JSON

## Finding a plugin's path

This file describes **structure**, never field data. For the path itself:

1. Open the plugin's action in the Jira UI with DevTools → Network, and read the request URL, or
2. read the plugin's own REST documentation.

Do not guess: a wrong path is a 404 at call time, and the error message will tell you to
check `jira_list_plugins`.

## Precedence

JSON-declared tools are merged **after** the code-declared ones, so a JSON entry with the
same name overrides the built-in tool. That is deliberate: it lets you patch a default
without touching code.

## What not to put here

Anything that is *Jira's data* rather than *structure*: allowed values of a custom field,
which fields are required, screen configuration. Those are read at runtime by
`jira_describe_create` / `jira_describe_edit`. Copying them here guarantees drift.

Also remember the DSL expresses **exactly one REST call**. Multi-step or aggregate
behaviour belongs in code (see `src/entities/`).
