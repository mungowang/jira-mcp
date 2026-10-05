## 1.0.6

### Fix: the shim could not start on Windows

`bin/jira-server.mjs` ended with `await import(entry)` and `entry` is an absolute path. On Windows
that path reads as a URL scheme (`C:`), so Node refused it with `ERR_UNSUPPORTED_ESM_URL_SCHEME`
and the server exited before it spoke MCP - which a client reports as `Connection closed`, with no
hint of the cause. A POSIX path happens to be accepted, so only Windows was affected. The entry is
imported through `pathToFileURL(entry).href` now.

# Changelog

## 1.0.5

### The version it reports now tracks the package

`serverInfo.version` was the constant `1.0.0`, so every client's log and every MCP inspector showed
a version that had not been true since the first release. It is read from the package manifest now,
which resolves the same way in a checkout and in an install, and the startup line carries it too
(`[jira-server] v1.0.5 started; ...`). A test asserts the reported version equals `package.json`'s.

## 1.0.4

### Correction: 1.0.2 claimed "no `$ref` anywhere", and that was wrong

Four `$ref`s remained. The check written to find them walked only `properties` and `items`, and all
four sat one level deeper - inside `additionalProperties`, which is where the MCP SDK puts the value
schema of a `z.record`:

```
jira_update_issue.update{}                     -> #/properties/fields/additionalProperties
jira_add_comment.updateAuthor.avatarUrls{}     -> #/properties/author/.../additionalProperties
jira_update_comment.updateAuthor.avatarUrls{}  -> ...
jira_get_project.avatarUrls{}                  -> #/properties/lead/.../additionalProperties
```

The cause was the same one 1.0.2 fixed, one level down: a `z.record(z.string(), z.any())` built once
shares its inner `z.any()` with every user of it. `anyRecord` is now a factory, `jira_update_issue`
builds its own `update` record rather than reusing `T.fields`, and the deep walk reports zero.

`test/schema-walk.mjs` now holds the walkers, and `descriptions.test.mjs` tests them **against
schemas known to contain the bug** - including the assertion that the old, shallower walk is blind
to it. A checker that cannot see its own target is worse than no checker, because it is believed.

## 1.0.3

### An observation-only mode for the Zephyr output contract

The 54 Zephyr tools come from vendored upstream code and answer `{ content: [{ type: 'text', text }] }`
where `text` is `JSON.stringify(data, null, 2)` - the payload *is* JSON, it is just never exposed a
second time as `structuredContent`. Declaring an `outputSchema` obliges a tool to supply
`structuredContent`, and the SDK throws when it is missing or fails to validate, so attaching one
to a tool whose payload is actually an array (or `null` where the entity says string) would turn a
working tool into a failing one.

`ZEPHYR_OUTPUT_CHECKS=1` answers that question before anything is attached. It parses what each
mapped tool returned, validates it against the entity the tool is believed to produce, and reports
the outcome on stderr - **without touching the result**. With the flag unset the wrapper is not
even installed. `npm run verify:live` runs it and puts the result in `verify-report.md`.

Nothing is attached to any Zephyr tool yet: this step exists to produce the evidence first. The
tool-to-entity mapping lives in `src/entities/zephyr/output-checks.ts`.

### Fixed

- The mock lied about two more root types. `get_custom_field_definitions` and
  `get_test_cases_linked_to_issue` answer **bare arrays** on a real instance; the generic
  `/rest/tests/1.0` fallback made them objects. Since the output-contract check exists to measure
  exactly that, a wrong mock would have produced false confidence.

## 1.0.2

### Every tool, parameter and output field now describes itself

The surface the model sees was audited and made complete, because a missing description is not
cosmetic: the model has to guess what a parameter means, and a `$ref` is worse than vague - a client
that does not resolve `$ref` shows it no type at all.

- **Input: 325 parameters, all described** (was 297). The 28 gaps were all in the hand-written core
  tools - `jira_transition_issue.transitionId` and `jira_add_worklog.timeSpentSeconds` were required
  and said nothing, not even the unit.
- **Output: 264 fields, all described** (was 147 of 264). Fields that recur across entities
  (`id`, `self`, `expand`, the paging trio, avatar urls) are now built by small factories in
  `src/entity-types.ts` instead of being shared instances.
- **No `$ref` anywhere** (was 5). The MCP SDK emits `$ref` when one Zod instance is reused inside a
  schema, so `jira_search_issues.startAt` pointed at `maxResults` - a different meaning entirely -
  and `E.comment.updateAuthor` pointed at `author`. Distinct instances remove it, and describing a
  field is what makes it distinct.
- **The JSON DSL can describe a parameter**: `{ "type": "string", "describe": "..." }` beside the
  existing short form. Unknown keys fail at startup. This also fixes the same `$ref` collapse for
  plugin declarations, which have no other way to hint a parameter.
- **An invariant test** (`test/descriptions.test.mjs`) fails on any tool, parameter or output field
  without a description, on any `$ref`, and on an output schema that is not open to new keys.

### Fixed

- `jira_search_issues.startAt` was rendered as a `$ref` to `maxResults`, so a client that does not
  resolve `$ref` saw no type for it and one that does saw the wrong description.

## 1.0.1

### Third real-instance run: plugin inventory, and a placeholder bug

`50 passed / 1 failed / 2 skipped`, and the plugin inventory finally came out (UPM is not readable
with this account, so it was inferred from custom field schemas). The instance runs Jira Software,
ScriptRunner and several Tempo modules, but **not Tempo Timesheets** - which confirms the decision
to drop the `jira_tempo_worklogs` sample. See
[`docs/instance-profile.example.md`](docs/instance-profile.example.md).

Fixed:

- **`download_attachment` was called with `attachmentId: 0`.** Discovery leaves the field as
  `null` when a test case has no attachments, and `null !== undefined` made the guard pass, so
  the id became `Number(null)`. Argument synthesis now uses a `need()` guard throughout: a value
  that was not discovered means **skip the tool**, never synthesise a placeholder. A test sweeps
  every read-only tool with an empty context and fails if any of them produces an input-validation
  error - which is what would have caught this.
- Zephyr attachment discovery now tries the test case, then the run, then a test result, because
  the sampled case had none.
- The probe candidate list now covers the Tempo modules this instance actually has.

### Second real-instance run (1175 upstream tests still green)

```
109 tools total (53 read-only)
ok  Jira 8.5.7; projects listed; one issue, one board and one sprint discovered
ok  every Zephyr tool, including get_test_case / get_test_run{,_results,_summary} /
    get_latest_result_for_test_case / get_test_plan / get_folder_tree / get_status_options /
    get_custom_field_definitions / find_jira_user / health_check
ok  jira_list_backlog (fixed after the first run)
48 passed / 3 failed / 2 skipped
```

Fixed from that run:

- **`jira_get_attachment_meta` failed output validation.** The assumed shape did not match what
  8.5.7 returns. New rule, now enforced by a test: **only keys observed on a real instance may be
  `required`**; `attachment`, `attachmentList`, `createdIssue`, `comment` and `worklog` require
  nothing and merely document their properties. A required key the server does not send turns a
  working call into a protocol error, which is strictly worse than a vaguer schema.
- **`jira_list_plugins` gave up too early.** `/rest/plugins/1.0/` answers 406 and
  `/rest/plugins/1.0` answers 404 for a non-admin account on this instance. It now reports every
  attempt and falls back to inferring plugin keys from custom field schemas - readable with
  ordinary permissions, and enough to see which vendors are installed (no versions though).
- **`download_attachment` was given a Jira attachment id.** Zephyr addresses attachments by its
  own numeric id / url from `list_attachments`; a Jira id is a 404 on
  `/rest/tests/1.0/attachment/{id}`. Discovery now resolves a Zephyr attachment separately.

Failure output on the console was widened to 400 characters, because these runs are pasted back
for diagnosis and a one-line excerpt is not enough.

### Verification coverage (the reason for most of this section)

A live run needs access to the target instance, so a single run has to cover as much as
possible. The verification script now **discovers** the ids that unlock
otherwise-skipped tools: attachment id, JSM service desk id, Zephyr test case / cycle / plan
keys, board and sprint. Against the offline mock the read-only sweep went from
**40 passed / 15 skipped** to **52 passed / 1 skipped** (the remaining skip is
`download_feature_files`, which pulls an archive and is left to a manual run).

The discovery logic lives in `test/discover.mjs` with its own tests, because a silent
regression there would quietly shrink the verified surface.

Found while making the mock faithful - the Zephyr Scale search endpoints answer a **bare
array**, and the vendored mapper discards anything else (`Array.isArray(raw) ? raw : []`).
The mock was answering `{values: [...]}`, which is exactly why the discovery chain could not
be exercised offline before.

`VERIFY_PROBE_PATHS=1` folds the plugin path probe into the same run, so one run produces both
the per-tool results and the candidate plugin paths in a single report. The
candidate list lives in `test/probe-candidates.mjs`, shared with `scripts/probe-paths.mjs`.
Failure details in the report were widened to 500 characters, because the fix loop happens
offline and the report has to carry enough to diagnose without another run.

### First verification against a real instance

Run against a Jira Server **8.5.7** over Basic Auth with a normal (non-admin) account:

```
110 tools total (54 read-only)
ok  Jira 8.5.7  deployment=Server  build=805007
ok  current user, projects, one issue, one board and one sprint
ok  38 read-only tools
x   3  (all fixed below)
```

Notable confirmations:

- **Basic Auth works** with a local Jira account - no SSO/CAPTCHA obstacle on this instance.
- **Zephyr Scale is installed and working**: `health_check`, `search_test_cases`,
  `search_test_runs`, `search_test_plans`, `get_folder_tree`, `get_status_options`,
  `get_custom_field_definitions`, `list_environments` and `find_jira_user` all answered, so
  the vendored integration is confirmed on the target server, not just in tests.

Fixed as a result:

- **`jira_list_backlog` failed output validation.** The Agile backlog answers with `issues`;
  only boards and sprints use the `values` envelope. Added `E.agileIssues` for board issues,
  sprint issues and the backlog, and made the mock return the real shape - the mock returning
  `{values:[]}` for the backlog is precisely why this was not caught offline.
- **`jira_list_plugins` returned a bare `406`.** Jira Server answers `/rest/plugins/1.0/` with
  an empty 406 when the account is not an administrator. `explain()` now recognises 406, the
  tool tries both spellings of the path, and `verify:live` records an administrator-rights
  refusal as a skip instead of a failure.
- **The Tempo sample endpoint was wrong.** `GET /rest/tempo-timesheets/4/worklogs` answers
  `405` on this instance. It has been moved out of `tools.d/plugins.json` into
  `tools.d/examples/example-tempo-worklogs.json` with the observation recorded; a test now
  asserts it stays disabled until the real path is confirmed.
- Added `T.numericId` to the type registry and used it for `serviceDeskId`, keeping the
  "JSON declarations reuse registry types" property after Tempo was removed.

### Fixed

- **Zephyr was skipped unless `JIRA_AUTH` was set explicitly.** The vendored loader defaults
  `JIRA_AUTH` to `pat`, so the configuration this server exists for - base URL, username and
  password, because 8.5.7 has no PAT - silently mounted 55 tools instead of 109 and explained it
  with `JIRA_PAT is required when JIRA_AUTH=pat`. The default is now inferred from what is set
  (`pat` when `JIRA_PAT` is present, otherwise `basic`) in `registerZephyr`, which keeps the
  vendored copy byte-identical to upstream. Every test passed `JIRA_AUTH=basic` explicitly, so the
  suite had encoded the same assumption as the docs; there is now a test that mounts without it.
- **A checkout could run a stale build.** `bin/jira-server.mjs` preferred `dist/` whenever it
  existed, so after any build `npm start` silently used the old bundle instead of the sources.
  Sources now win when present, and a package that ships only `dist/` (there is no `src/` in the
  tarball) still runs the bundle.

### Packaging for npm

The package is published as `@mohou/jira-mcp`. Publishing it as-is would have shipped something
that cannot start:

- **Node refuses type stripping under `node_modules`**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the "no build step" sources run from a
  checkout but not from an installed package. The published artifact is now a single esbuild
  bundle, `dist/jira-server.mjs`, with the SDK and zod kept external; `bin/jira-server.mjs`
  picks the bundle when it exists and the sources otherwise, so both paths keep working and a
  checkout still needs no build.
- **`jira.config.json` was missing from `files`.** Its absence is silent - `aliases.ts` returns an
  empty map on ENOENT - so an installed package would have lost every business alias without a
  word. It is shipped now, and `prepack` rebuilds `dist/` so the tarball is never stale.
- **Two alias ids were real.** `jira.config.json` pointed at `customfield_10123` / `customfield_10777`,
  which exist on the reference instance. They are now synthetic (`20001` / `20002`), with the mock
  and the tests moved with them.
- `private` is gone, `publishConfig.access` is `public` (a scoped package defaults to restricted),
  and the author/repository/homepage/bugs/licence placeholders are filled.

Verified by installing the tarball into a clean directory and booting it: 97 tools, plugin tools
from `tools.d/` present (which also proves the `import.meta.url`-relative root resolution works
from an installed location), output schemas intact. Then the same from a deleted `dist/`, to prove
`prepack` builds during `npm pack`.

### Added

- **A bad `JIRA_BASE_URL` now says what is wrong.** It used to surface only as `fetch failed` or
  `Failed to parse URL from ...` inside the first call, which says nothing about the cause and is
  especially confusing when a host injects the variable from a secret store. `baseUrlProblem()`
  classifies it - empty, an unresolved `${...}` placeholder that was passed through instead of
  being substituted, a bare `host:port` or `/rest/...` path, or an unparseable URL - and the server
  warns at startup and fails each call with that reason. The value itself is never echoed, because
  such a host treats it as a credential and masks it anyway.

- **The capture checks the schemas against real data.** Each captured payload is mapped to the
  entity it should satisfy and validated, so `src/entity-types.ts` is no longer documentation
  that can drift: a wrong assumption shows up as a failed check. `--check <dir>` re-runs those
  checks against a saved capture with no network access, which is how a schema edit is verified
  during development.

- **`npm run capture:instance`** - capture the full structure of a real instance so the entity
  schemas can be extended from evidence rather than assumption: one issue with every field plus
  `expand=changelog,renderedFields,names,schema,transitions,editmeta`, its comments, worklogs,
  attachments, watchers, remote links and transitions; raw `createmeta`/`editmeta` (which fields
  are on the create/edit screens, required or not, and their allowed values); a sample of several
  issues for **field presence**; the agile hierarchy; and the whole Zephyr hierarchy - test case
  with steps and attachments, cycle with items/results/summary, plan, folder tree, status options,
  custom field definitions and environments.

  Output is deliberately split by safety: `capture/report.md` (and `summary.json`) carry key
  names, types, array lengths and presence counts with **every value stripped**, so they can be
  shared; `capture/raw/*.json` holds the untouched payloads and is gitignored. A test asserts the
  shareable report does not contain values that are present in the raw files.

  Multi-sample presence is the point: a key marked `*` appeared in *every* sample of its object,
  which is what decides whether it may be `required`. `CAPTURE=1` folds it into a `verify:live`
  run. For Jira fields, presence alone says nothing - every issue carries every field key, mostly
  with `null` - so the report also counts **`filled`** (a non-null, non-empty value), which is the
  figure that identifies a custom field as actually in use.

### The report's own claim, checked

The report says "no values", and that was verified on real data rather than trusted: the issue
key was found in it, because the header deliberately lists the sampled identifiers. The wording is
now precise - **no field values**, but field *names* and the sampled identifiers are present - and
`CAPTURE_REDACT=1` replaces the identifiers with placeholders for a publishable report.

### Changed (from real captured data)

`src/entity-types.ts` grew from 20 to 30 entities and every existing one was corrected against a
real instance:

- `attachment`: added `self`, `thumbnail`, and a note that `fields.attachment[]` and
  `GET /rest/api/2/attachment/{id}` disagree - which is why nothing is required there.
- `sprint`: added `self` and `goal`; `goal` was missing from some of the 40 sampled sprints, so it
  stays optional while `id` is required.
- `project` / `user` / `serverInfo`: filled in the keys the instance actually returns (`roles`,
  `projectCategory`, `lead`, `locale`, `baseUrl`, `buildDate`, and so on).
- `transitions`: the `to` status object is now described instead of left as an opaque record.
- New Zephyr Scale entities derived from the captured hierarchy: `testCase`, `testRunItem`,
  `testRun`, `testResult`, `testRunSummary`, `testPlan`, `zephyrPage`, `folderTree`, `folderNode`,
  `statusOptions`, `customFieldDefinition`. They are reference shapes: the vendored upstream tools
  return text, so they are not attached as outputSchema yet.
- `folderTree` was split out of `folderNode` because the root of a folder tree is the project and
  carries no `id` - the schema check caught exactly that.

On the reference instance this also showed that of **339 field keys, only 37 carried a value** on
any sampled issue, which is the evidence behind not writing static field maps.

- **`returns` in the plugin DSL.** JSON-declared tools were second-class: they could declare
  their inputs but never their output, so they got no `outputSchema` and no `structuredContent`
  while code-declared tools did. A declaration may now name an entity type
  (`"returns": "paged"`), mirroring how `params` names an input type, and `anyObject` was added
  to `src/entity-types.ts` as the honest escape hatch when a plugin's payload shape is unknown.
  An unknown name fails at startup with the list of valid ones.
- **`npm run tools:describe`** prints the schema structure of every tool - one line per tool with
  inputs (required starred), the declared output, whether it came from `tools.d/` and whether it
  is read-only or destructive; `--json` emits the full `inputSchema` / `outputSchema`.

- `npm run probe:paths` / `scripts/probe-paths.mjs` — GET-probes the common REST paths of
  Tempo, ScriptRunner, JSM, Zephyr Scale, Xray, Zephyr Squad, Structure and Insight, prints
  the status code of each, and re-probes with POST when a path answers 405. Nothing is
  written; it exists so the correct plugin path can be found instead of guessed.

54 tests.

## 1.0.0

First production release: one process, one MCP server, 110 tools.

### Tool surface

- **Core (56 `jira_*` tools), organised by entity** — one file per entity under `src/entities/`:
  issue, comment, worklog, attachment, project, user, link, watcher, meta, agile.
  Agile covers boards, sprints, backlogs, board/sprint issues, and moving issues between
  them; issue links cover both issue-to-issue links and remote (Confluence) links;
  `jira_get_issue` takes `expand` so changelog and rendered fields come back in one call.
- **Zephyr Scale (54 tools), vendored** from `zephyr-scale-mcp` @ `9c43dc5` (MIT) into
  `src/entities/zephyr/` and mounted on the same server. 42 tools by default; the other 12
  come from Zephyr's internal API and require `ZEPHYR_ALLOW_INTERNAL_API=true`.
- **`jira_request`** as a deliberate escape hatch for plugin modules with no dedicated tool.

### Design

- Field knowledge is read from Jira at runtime (`jira_describe_create` / `jira_describe_edit`)
  instead of being mapped in code, so custom and plugin fields need no code changes.
- Write payloads pass `fields` through verbatim; business aliases are translated to field ids
  just before the request.
- Three separated layers: the Zod type registry (`src/types.ts`), plugin declarations
  (`tools.d/*.json`), and Jira metadata.
- Return types (`src/entity-types.ts`) produce MCP `outputSchema` + `structuredContent`
  for the 25 tools whose response shape is stable.
- `tools.d/README.md` documents the declaration DSL, its validation rules, and how to find a
  plugin's REST path; `tools.d/examples/` ships three templates that are deliberately not
  auto-loaded (a test keeps them valid and keeps them unregistered).
- `readOnlyHint` / `destructiveHint` annotations on every tool (54 read-only, 15 destructive).

### Reliability

- Request timeout (`JIRA_TIMEOUT_MS`), `Retry-After`-aware retries (`JIRA_MAX_RETRIES`),
  and Jira errors translated into actionable messages (401 → SSO/CAPTCHA, 400 screen errors →
  name the field and point at the describe tools, plugin-path 404 → check the plugin).
- Self-signed certificates via `JIRA_TLS_REJECT_UNAUTHORIZED` / `JIRA_SSL_VERIFY`.
- Plugin declarations are validated at startup and report the offending file and key.
- `jira.config.json` resolves relative to the module, not the cwd, so embedding works.
- A read-only switch (`JIRA_READ_ONLY`) that constrains core and Zephyr alike.

### Fixed during development

- Empty `204` responses produced `text: undefined`, which failed MCP result validation —
  every delete/update tool would have broken against a real instance.
- `jiraUpload` bypassed path resolution and posted to `/issue/...` without the `/rest/api/2`
  prefix.
- `describe_*` results were JSON-escaped instead of being handed to the model verbatim.
- `jira.config.json` was read relative to the cwd, so aliases silently vanished when the
  server was started from another directory.

### Tests

- `npm test` — 54 cases: contract, transport, output types, config, 8.5.7 compatibility.
- `test/compat.test.mjs` guards the 8.5.7 promise: no source or declaration may reference
  `/rest/api/3`, and every request a tool makes must land on a v2/agile/declared-plugin path.
- `npm run verify:vendor` — the upstream Zephyr suite against the vendored source:
  1175 passed, 0 failed.
- `npm run verify:live` — read-only verification of every read-only tool against a real
  instance, writing `verify-report.md`. With `VERIFY_WRITE=1 VERIFY_PROJECT=<KEY>` it also
  exercises the write path on a throwaway probe issue (created and deleted in a `finally`),
  covering comments, worklogs, watchers, attachments, links, remote links and transitions.
  The write mode has no default project and refuses to run without an explicit one.
