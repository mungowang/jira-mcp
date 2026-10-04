import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { atm, zephyrFetch } from '../http.ts';
import { projectKeySchema, RESULT_STATUS_NOTE } from '../schemas.ts';
import { defineTool, encodePath, isEmptyResponse, resolveProjectKey } from '../toolkit.ts';
// Local-file reading, multipart building and binary downloads live with the attachment tools:
// same concern, one implementation.
import { fetchBinary, readUploadFile, singleFileForm, writeDownloadedFile } from './attachments.ts';

/** Input shape shared by both automation upload tools. */
const resultsUploadShape = {
  projectKey: projectKeySchema,
  filePath: z
    .string()
    .min(1)
    .describe('Path of the results .zip archive on the machine running this MCP server (absolute path recommended)'),
  autoCreateTestCases: z
    .boolean()
    .optional()
    .describe(
      'Create the test cases referenced by the results that do not exist in the project yet (server default: false). Omitted from the ' +
        'query string entirely when not passed. Verified live: this only affects executions that identify the case by testCase.name ' +
        'with NO key — an explicit testCase.key that does not exist fails with 400 "Test Case with key X not found." whether the flag ' +
        'is true or false.',
    ),
};

type ResultsUploadArgs = z.output<z.ZodObject<typeof resultsUploadShape>>;

/** POST a results ZIP as multipart/form-data to an /automation/execution endpoint. */
async function uploadResultsArchive(cfg: Config, endpoint: string, args: ResultsUploadArgs): Promise<unknown> {
  const projectKey = resolveProjectKey(cfg, args.projectKey);
  const bytes = await readUploadFile(args.filePath, 'the results ZIP');
  const data = await zephyrFetch(cfg, {
    method: 'POST',
    path: encodePath(atm(endpoint), projectKey),
    query: { autoCreateTestCases: args.autoCreateTestCases },
    form: singleFileForm(bytes, basename(args.filePath)),
  });
  // The API normally answers with a description of the test cycle it created — pass it through.
  return isEmptyResponse(data) ? { uploaded: true } : data;
}

/**
 * Reject a 200 that is not an archive before anything is written.
 *
 * Two different causes, two different messages. Found live: a query matching no BDD case answers 200
 * with a ZERO-BYTE body — there is no such thing as an empty export archive — so an empty body is a
 * query problem, not the SSO-redirect / HTML-error-page case the 'PK' guard was written for.
 */
function assertZipArchive(bytes: Buffer, tql: string): void {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return; // 'PK'
  if (bytes.length === 0) {
    throw new Error(
      'The query matched no BDD test case: the server answered with an empty body instead of an archive — nothing was written. ' +
        'Only cases whose script type is BDD are exported, and a nonexistent projectKey, a name that matches nothing or an OR clause ' +
        `all answer this way too. Query: ${tql}`,
    );
  }
  const preview = bytes.toString('utf8', 0, 200).replace(/\s+/g, ' ').trim();
  throw new Error(
    "The server did not return a ZIP archive (missing 'PK' signature) — nothing was written. Response starts with: " +
      (preview || `(${bytes.length} bytes of whitespace)`),
  );
}

const NEW_CYCLE_NOTE =
  'Always creates a NEW test cycle (test run) — it never appends to an existing one — and returns the API description of ' +
  'that cycle unchanged, or { uploaded: true } for an empty body.';

export function registerAutomationTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'upload_automation_results',
    description:
      'Publish automated execution results from a local ZIP archive (POST multipart/form-data /automation/execution/{projectKey}). ' +
      'The archive must hold JSON files in Zephyr\'s custom results format: {"version": 1, "executions": [{"source", "result", ' +
      '"testCase": {"key"}}]}. Validation is strict only at the TOP level of an execution: an extra sibling of source/result such as ' +
      'executionTime is rejected with 400 "Invalid Custom Format JSON file", while an extra field inside "testCase" is silently ' +
      'accepted; "version" is not validated at all and "source" is optional (and readable back through no endpoint). ' +
      `Each execution's "result" is a status name — ${RESULT_STATUS_NOTE} ` +
      'WARNING (verified live): an UNRECOGNIZED result value is NOT rejected — "PASS", "pass", "FAIL", "" and free text are all stored ' +
      'as Blocked with HTTP 200, so a single typo turns a green suite into a Blocked cycle silently; only an absent "result" key errors ' +
      '(400 "Test Result Status is required"). Test case keys are case-sensitive and must exist: one bad key rejects the whole archive ' +
      'and creates no partial cycle. Two executions of the SAME case become two separate run items, and several JSON files in one ZIP ' +
      'are merged into one cycle. A 400 "Invalid ZIP file" also means a structurally valid archive that contains no JSON at all. ' +
      `${NEW_CYCLE_NOTE}`,
    inputSchema: resultsUploadShape,
    annotations: {},
    handler: async (args, { cfg }) => uploadResultsArchive(cfg, '/automation/execution', args),
  });

  defineTool(server, cfg, {
    name: 'upload_cucumber_results',
    description:
      'Publish Cucumber execution results from a local ZIP archive (POST multipart/form-data /automation/execution/cucumber/{projectKey}). ' +
      "The archive must hold the output of Cucumber's built-in json formatter (one or more .json report files). " +
      'Every scenario must carry a @TestCaseKey=PROJ-T1 tag naming the BDD test case it reports on — that tag is how the server ' +
      'matches a scenario to an existing test case. ' +
      `${NEW_CYCLE_NOTE}`,
    inputSchema: resultsUploadShape,
    annotations: {},
    handler: async (args, { cfg }) => uploadResultsArchive(cfg, '/automation/execution/cucumber', args),
  });

  defineTool(server, cfg, {
    name: 'download_feature_files',
    description:
      'Export BDD test cases as Gherkin .feature files packed in a ZIP archive (GET /automation/testcases). ' +
      'tql is REQUIRED — the API rejects the call without it — and this endpoint uses the testCase.-prefixed TQL dialect, which ' +
      'supports ONLY the fields testCase.key, testCase.projectKey and testCase.name (= and IN) joined by AND: testCase.folder, ' +
      'testCase.status, testCase.priority and testCase.labels are rejected with 400 "Error executing TQL", so a whole folder cannot ' +
      'be exported — select the cases with testCase.key IN (...) instead. Values must be quoted, single or double quotes both work, ' +
      'and spaces around operators are optional here, unlike search_test_cases; lowercase "and", lowercase "testcase." and OR are ' +
      'not accepted, and an OR query answers 200 with an empty body rather than a syntax error. ' +
      'Only cases whose script type is BDD are exported: STEP_BY_STEP and PLAIN_TEXT cases, and keys in an IN list that do not exist, ' +
      'are silently skipped (332 cases yielded 251 .feature files on the reference instance) and the return value does not say which ' +
      'keys were dropped. A query that matches no BDD case — a nonexistent projectKey included — returns HTTP 200 with an EMPTY body, ' +
      'not an empty ZIP, and this tool then reports that the query matched nothing. ' +
      'The archive is flat: one <TESTCASEKEY>.feature per case, no directories. The server writes "Feature: <name>", ' +
      '"    @TestCaseKey=<KEY>", "    Scenario: <name>", a blank line, then every stored BDD line prefixed with exactly 8 spaces, ' +
      'so an exported file is only byte-identical to the stored script after that prefix is removed, and it is NOT accepted back by ' +
      'set_test_script / create_test_case (400 "Invalid BDD Script") until the Feature:/@TestCaseKey/Scenario: header is stripped. ' +
      "The archive is written to outputPath only after its 'PK' signature is verified, so an HTML login or error page served " +
      'with HTTP 200 fails loudly instead of leaving a corrupt file. ' +
      "outputPath's parent directory must already exist, '~' is NOT expanded, and an existing file at outputPath is overwritten " +
      'without warning on success (a failed call leaves it byte-identical). ' +
      'Reads from Zephyr only, so it stays available in ZEPHYR_READONLY mode. Returns { savedTo, bytes }.',
    inputSchema: {
      tql: z
        .string()
        .min(1)
        .describe(
          'TQL query selecting the BDD test cases to export, in the testCase.-prefixed dialect this endpoint requires — only ' +
            'testCase.key, testCase.projectKey and testCase.name are queryable, e.g. \'testCase.projectKey = "PROJ"\' or ' +
            '\'testCase.key IN ("PROJ-T1", "PROJ-T2")\'',
        ),
      outputPath: z
        .string()
        .min(1)
        .describe('Local path to write the ZIP archive to, on the machine running this MCP server (the parent directory must exist)'),
    },
    // readOnlyHint is about Zephyr: nothing changes server-side, so the tool stays usable in read-only mode.
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const bytes = await fetchBinary(cfg, atm('/automation/testcases'), { tql: args.tql });
      assertZipArchive(bytes, args.tql);
      return writeDownloadedFile(args.outputPath, bytes);
    },
  });
}
