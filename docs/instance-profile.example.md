# Instance profile - EXAMPLE (dummy data)

> **Every value below is fabricated.** It is a template for recording what `npm run verify:live`
> told you about *your* instance, and for writing down the decisions that follow from it
> (e.g. "do not ship a Tempo Timesheets tool because this server does not run it").
> Copy it to `instance-profile.md` and fill in your own values. That file is gitignored.

## Server

| | |
|---|---|
| URL | `http://jira.example.com:8080` |
| Version | Jira **8.5.7**, build 805007, `deploymentType: Server` |
| Auth | Basic Auth with a **local** account - worked directly, no SSO/Crowd obstacle observed |
| Scale | a few dozen visible projects; sample project `DEMO`, a board and a sprint |

On 8.5.7 there is **no Personal Access Token** (PAT starts at 8.14) and **no `/rest/api/3`**.
`test/compat.test.mjs` guards both.

## What is installed

`/rest/plugins/1.0` often is not readable with a normal account (on the reference instance the
trailing-slash spelling answered 406 and the plain spelling 404), so the inventory can be
**inferred from custom field schemas**: `schema.custom` carries the plugin key. No version numbers
come out of this method.

| Plugin key | Field(s) seen | Meaning |
|---|---|---|
| `com.example.customfieldtypes` | many | built-in Jira custom field types |
| `com.example.agile` | a few | an agile board plugin - Sprint, Epic Link/Name/Status/Colour |
| `com.example.scriptrunner` | a few | a script-runner plugin |
| `com.example.tempo-teams` | 2 | a team field module |
| `com.example.tempo-accounts` | 1 | an account field module |
| `com.example.tempo-plan` | 1 | a planning module |
| `com.example.dev-integration` | 1 | development integration (dev-status) |

Reading that table is what decides which `tools.d/` declarations are worth writing, and which
sample endpoints must **not** ship. On the reference instance a timesheet module was absent while
its planning/team/account modules were present, so the timesheet sample endpoint answered 405 and
was removed from `tools.d/plugins.json`.

## How to collect this

```bash
JIRA_BASE_URL=... JIRA_USERNAME=... JIRA_PASSWORD=... \
ZEPHYR_ALLOW_INTERNAL_API=true VERIFY_PROBE_PATHS=1 npm run verify:live
```

The report gets the version, the per-tool results, the inferred plugin keys and the plugin path
probe. The probe is what turns a guess into a declaration: `200` works, `405` the path exists for
another method, `404` nothing there.

## Per-tool results

- Every Zephyr Scale tool answered on the reference instance, including the test case, cycle,
  execution, plan, folder, environment and custom-field-definition calls.
- Every agile tool answered, consistent with an agile board plugin being installed.
- Write tools are exercised separately: `VERIFY_WRITE=1 VERIFY_PROJECT=DEMO`.
- `download_feature_files` is deliberately excluded from the sweep (it pulls an archive).

## Findings worth keeping

These are Jira/Zephyr behaviours rather than facts about one company, and each was invisible
offline. All are covered by tests now.

1. The Agile backlog answers with `issues`, not the `values` envelope boards use.
2. `/rest/plugins/1.0/` answers an empty **406** for a non-admin account: Jira serves an HTML error
   page while the client asked for JSON.
3. `/rest/api/2/attachment/{id}` did not match the shape this project assumed, so unverified
   envelopes no longer require any key.
4. Zephyr addresses attachments by its **own** id/url; a Jira attachment id is a 404 on
   `/rest/tests/1.0/attachment/{id}`.
5. A missing discovered value must cause a **skip**, never a placeholder - `attachmentId: 0` came
   from `null !== undefined` and surfaced as an input-validation error.
