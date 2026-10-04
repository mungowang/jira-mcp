import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { atm, zephyrFetch, ZephyrApiError } from '../http.ts';
import { internal } from '../internal.ts';
import { attachmentIdSchema, testCaseKeySchema, testResultIdSchema, testRunKeySchema } from '../schemas.ts';
import { defineTool, encodePath, isEmptyResponse, ToolInputError } from '../toolkit.ts';

/* ─────────────────────────────────────────────────────────────────────────────
 * Local-disk and multipart plumbing.
 * Shared with ./automation.ts: uploading a ZIP of automation results and
 * uploading an attachment are the same operation with a different endpoint.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Read a file that is about to be uploaded. The path is resolved on the machine running this
 * server, so a failure is a caller mistake rather than an API error — hence ToolInputError,
 * and hence the path in the message so the caller can see what was actually looked up.
 *
 * @param what how to name the file in the error message, e.g. 'the results ZIP'.
 */
export async function readUploadFile(filePath: string, what: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (err) {
    throw new ToolInputError(
      `Cannot read ${what} at '${filePath}': ${err instanceof Error ? err.message : String(err)}. ` +
        'The path is resolved on the machine running this MCP server, which must be able to read it (absolute paths are safest).',
    );
  }
}

/** Build the multipart body every Zephyr upload endpoint expects: exactly one part named 'file'. */
export function singleFileForm(bytes: Buffer, fileName: string): FormData {
  const form = new FormData();
  // Copy into a plain Uint8Array: a pooled Buffer is not a valid BlobPart under strict typing.
  form.append('file', new Blob([new Uint8Array(bytes)]), fileName);
  return form;
}

/** Write a downloaded payload to a local path (the parent directory must already exist). */
export async function writeDownloadedFile(outputPath: string, bytes: Buffer): Promise<{ savedTo: string; bytes: number }> {
  try {
    await writeFile(outputPath, bytes);
  } catch (err) {
    throw new ToolInputError(
      `Cannot write to '${outputPath}': ${err instanceof Error ? err.message : String(err)}. ` +
        'The path is resolved on the machine running this MCP server and its parent directory must already exist.',
    );
  }
  return { savedTo: outputPath, bytes: bytes.length };
}

/**
 * An HTML *page* — a login form or an error page — as opposed to an attachment that happens to be
 * markup. Anchored at the start (after a BOM and leading whitespace) and limited to the two openings
 * a served page actually uses, so an XML/SVG attachment, or a log file merely quoting "<html>",
 * still downloads.
 */
const HTML_PAGE_START = /^\uFEFF?\s*(?:<!doctype\s+html|<html[\s>])/i;

const isHtmlPage = (bytes: Buffer): boolean => HTML_PAGE_START.test(bytes.toString('utf8', 0, 512));

/** How much of a page's readable text the refusal message quotes. */
const MAX_HTML_TEXT = 160;

/** How much of the page is read to describe it; a served page says who it is well within this. */
const HTML_SNIFF_BYTES = 4096;

const htmlHead = (bytes: Buffer): string => bytes.toString('utf8', 0, HTML_SNIFF_BYTES);

/** First <title> of an HTML page, for naming what came back instead of the file. */
function htmlTitle(bytes: Buffer): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(htmlHead(bytes));
  const title = match?.[1]?.replace(/\s+/g, ' ').trim();
  return title ? title : undefined;
}

/**
 * The readable text of a page whose <title> says nothing (or that has none): tags stripped, script and
 * style contents dropped, repeated blocks collapsed — a Tomcat/Jira error page repeats its status line
 * verbatim — and cut to one short line. On an error page the first blocks ARE the status line.
 */
function htmlText(bytes: Buffer): string | undefined {
  const blocks: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const raw of htmlHead(bytes)
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1>|$)/gi, ' ')
    .split(/<[^>]*>/)) {
    const block = raw
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (block === '') continue;
    const key = block.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
    length += block.length + 1;
    if (length > MAX_HTML_TEXT) break;
  }
  const text = blocks.join(' ');
  if (text === '') return undefined;
  return text.length > MAX_HTML_TEXT ? `${text.slice(0, MAX_HTML_TEXT)}…` : text;
}

/**
 * Name the page that came back instead of the file, so the caller can tell a login redirect from an
 * error page from the wrong host. "An HTML page" alone said none of that: on this stand the pages that
 * matter most often carry no <title>, so fall back to the text the page actually shows.
 */
function htmlPageDescription(bytes: Buffer): string {
  const title = htmlTitle(bytes);
  if (title !== undefined) return `titled '${title}'`;
  const text = htmlText(bytes);
  return text === undefined ? 'with no <title> and no readable text' : `with no <title>, beginning '${text}'`;
}

/**
 * Reject an HTML page before anything is written.
 *
 * Found live: Jira answers 200 with its login page for a url that is not an attachment (an expired
 * session, a redirect, a mistyped path), so no error path fires and the page was saved as the
 * attachment and reported as a successful download. Same guard as the 'PK' check on the automation
 * export, and same promise: on failure nothing is written.
 */
function assertNotHtmlPage(bytes: Buffer, path: string): void {
  if (!isHtmlPage(bytes)) return;
  throw new Error(
    `GET ${path} answered with an HTML page, not attachment content (${bytes.length} bytes, ${htmlPageDescription(bytes)}) ` +
      '— nothing was written. ' +
      'Jira serves its login or error page with HTTP 200, so this usually means the session or credentials are not valid for this ' +
      'url, or the url is not an attachment url. Take the exact url from list_attachments, or address the attachment by ' +
      'attachmentId. Pass allowHtml: true if the attachment itself really is an HTML file.',
  );
}

/** GET a raw payload (attachment content, ZIP exports); zephyrFetch answers these with a Buffer. */
export async function fetchBinary(cfg: Config, path: string, query?: Record<string, string>): Promise<Buffer> {
  return (await zephyrFetch(cfg, { method: 'GET', path, query, binaryResponse: true })) as Buffer;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Attachment addressing: one table, one resolver, no I/O until it passes.
 * ────────────────────────────────────────────────────────────────────────── */

type AttachmentTarget = 'test_case' | 'test_run' | 'test_result';
type IdentifierArg = 'testCaseKey' | 'testRunKey' | 'testResultId';

interface TargetSpec {
  /** The single argument that identifies the entity for this target. */
  readonly identifier: IdentifierArg;
  /** Entity segment of API v1: /testcase, /testrun, /testresult. */
  readonly segment: string;
  /** Whether the entity family exposes /step/{index}/attachments. */
  readonly perStep: boolean;
}

const TARGETS: Record<AttachmentTarget, TargetSpec> = {
  test_case: { identifier: 'testCaseKey', segment: 'testcase', perStep: true },
  // A run has no per-step endpoint: on the execution side, step evidence belongs to a test result.
  test_run: { identifier: 'testRunKey', segment: 'testrun', perStep: false },
  test_result: { identifier: 'testResultId', segment: 'testresult', perStep: true },
};

const IDENTIFIER_ARGS: readonly IdentifierArg[] = ['testCaseKey', 'testRunKey', 'testResultId'];

interface Addressing {
  target: AttachmentTarget;
  testCaseKey?: string | undefined;
  testRunKey?: string | undefined;
  testResultId?: number | undefined;
  stepIndex?: number | undefined;
}

/**
 * Validate the target / identifier / stepIndex combination and return the attachments endpoint.
 * Called before any disk or network access, so an ambiguous request never uploads or downloads.
 */
function attachmentsPath(args: Addressing): string {
  const spec = TARGETS[args.target];
  const identifier = args[spec.identifier];
  if (identifier === undefined) {
    throw new ToolInputError(`${spec.identifier} is required when target is '${args.target}'.`);
  }
  for (const name of IDENTIFIER_ARGS) {
    if (name !== spec.identifier && args[name] !== undefined) {
      throw new ToolInputError(
        `${name} is not allowed when target is '${args.target}' — pass only the identifier matching the target (${spec.identifier}).`,
      );
    }
  }
  if (args.stepIndex !== undefined && !spec.perStep) {
    throw new ToolInputError(
      `stepIndex is not supported when target is '${args.target}' — the API has no per-step attachments endpoint for test runs. ` +
        "To attach to a step of an execution, use target 'test_result' with the result id.",
    );
  }
  const step = args.stepIndex === undefined ? [] : ['step', args.stepIndex];
  return encodePath(atm(`/${spec.segment}`), identifier, ...step, 'attachments');
}

const ADDRESSING_NOTE =
  "Addressing: 'test_case' needs testCaseKey, 'test_run' needs testRunKey, 'test_result' needs testResultId (numeric); " +
  "an identifier that does not match the target is rejected. stepIndex is accepted for 'test_case' and 'test_result' only — " +
  'API v1 has no per-step attachments endpoint for runs.';

/** Reuse a shared entity schema as the optional, target-conditional identifier of an attachment. */
function identifierOf<T extends z.ZodTypeAny>(schema: T, target: AttachmentTarget): z.ZodOptional<T> {
  return schema.optional().describe(`${schema.description ?? ''} — required when target is '${target}'`);
}

/** Input fields shared by upload_attachment and list_attachments. */
const addressingShape = {
  target: z
    .enum(['test_case', 'test_run', 'test_result'])
    .describe('Entity family the attachment belongs to; it decides which identifier is required'),
  testCaseKey: identifierOf(testCaseKeySchema, 'test_case'),
  testRunKey: identifierOf(testRunKeySchema, 'test_run'),
  testResultId: identifierOf(testResultIdSchema, 'test_result'),
  stepIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based index of a single step, instead of the whole entity (targets 'test_case' and 'test_result' only)"),
};

const ONE_SELECTOR_NOTE = 'Pass exactly ONE of attachmentId or url.';

/**
 * Raw-content path of one attachment. Outside API v1 on purpose: this is the url the public list
 * endpoint itself hands out, and — found live — the only endpoint that answers 404 for an
 * attachment id that does not exist (the DELETE answers 2xx either way).
 */
const attachmentContentPathOf = (attachmentId: number): string => encodePath(internal('/attachment'), attachmentId);

/** A request built from one of the two selectors: a bare path, plus the parameters that rode on the url. */
interface ContentRequest {
  readonly path: string;
  readonly query?: Record<string, string> | undefined;
}

/**
 * Split the query string (and any fragment) off a url's path.
 *
 * The query must NOT stay glued to the path: ZephyrApiError prints method and path only, precisely
 * because a query string may carry a token or a signature, and a path with '?…' in it defeated that —
 * found live, "GET /rest/atm/1.0/environments-not-mounted?projectKey=NBUL" was echoed in a 404. Handed
 * to zephyrFetch as parameters instead, they are still sent and no longer printed. A repeated parameter
 * keeps its last value, which is what URL.searchParams.set does with them anyway.
 */
function splitQuery(pathAndQuery: string): ContentRequest {
  const path = pathAndQuery.replace(/[?#][\s\S]*$/, '');
  const [, rawQuery = ''] = /\?([^#]*)/.exec(pathAndQuery) ?? [];
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;
  return Object.keys(query).length === 0 ? { path } : { path, query };
}

/** Resolve the content request of download_attachment from its two mutually exclusive selectors. */
function attachmentContentRequest(
  cfg: Config,
  args: { attachmentId?: number | undefined; url?: string | undefined },
): ContentRequest {
  const { attachmentId, url } = args;
  if (url !== undefined) {
    if (attachmentId !== undefined) throw new ToolInputError(ONE_SELECTOR_NOTE);
    // A url is followed verbatim, so it must stay on the configured host: the Authorization header goes with it.
    if (!url.startsWith(`${cfg.baseUrl}/`)) {
      throw new ToolInputError(
        `url must point at the configured Jira host (${cfg.baseUrl}) — refusing to send credentials to another host.`,
      );
    }
    return splitQuery(url.slice(cfg.baseUrl.length));
  }
  if (attachmentId === undefined) throw new ToolInputError(ONE_SELECTOR_NOTE);
  return { path: attachmentContentPathOf(attachmentId) };
}

export function registerAttachmentTools(server: McpServer, cfg: Config): void {
  defineTool(server, cfg, {
    name: 'upload_attachment',
    description:
      'Attach a local file to a test case, test run (cycle), test result, or to one step of a case or result ' +
      '(POST multipart/form-data /testcase/{key}[/step/{i}]/attachments, /testrun/{key}/attachments, ' +
      '/testresult/{id}[/step/{i}]/attachments). ' +
      `${ADDRESSING_NOTE} ` +
      'filePath is read from the disk of the machine running this MCP server, not from the caller. ' +
      'Uploads are not idempotent: calling twice creates two attachments. ' +
      'A bogus testResultId is rejected here with 404 even though list_attachments answers [] for it (verified live). ' +
      'Returns the attachment metadata the API reports — on the reference build always a bare { id }, with neither the file name nor ' +
      'the size echoed back, so verifying an upload costs a list_attachments call — or { uploaded: true, fileName, size } when the API ' +
      'answers with an empty body.',
    inputSchema: {
      ...addressingShape,
      filePath: z
        .string()
        .min(1)
        .describe('Path of the file to read and upload, on the machine running this MCP server (absolute path recommended)'),
      fileName: z
        .string()
        .min(1)
        .optional()
        .describe(
          'File name to store in Zephyr Scale, extension included; defaults to the basename of filePath. Stored verbatim, Unicode ' +
            'and spaces included — except that the API strips any directory prefix, so "../dir/report.png" is stored as "report.png".',
        ),
    },
    annotations: {},
    handler: async (args, { cfg }) => {
      const path = attachmentsPath(args);
      const fileName = args.fileName ?? basename(args.filePath);
      const bytes = await readUploadFile(args.filePath, 'the file to upload');
      const res = await zephyrFetch(cfg, { method: 'POST', path, form: singleFileForm(bytes, fileName) });
      return isEmptyResponse(res) ? { uploaded: true, fileName, size: bytes.length } : res;
    },
  });

  defineTool(server, cfg, {
    name: 'list_attachments',
    description:
      'List the attachments of a test case, test run (cycle), test result, or of one step of a case or result ' +
      '(GET /testcase/{key}[/step/{i}]/attachments, /testrun/{key}/attachments, /testresult/{id}[/step/{i}]/attachments). ' +
      `${ADDRESSING_NOTE} ` +
      'These endpoints take no pagination and no fields projection — the full list always comes back. ' +
      'Step attachments are aggregated ASYMMETRICALLY (verified live): the test-case list EXCLUDES attachments that live on the case ' +
      "steps, while the test-result list INCLUDES them — so enumerating a case's evidence needs one extra call per step, and doing the " +
      'same on a result double-counts. An out-of-range stepIndex answers 404 (an in-range step with no attachments answers []), and a ' +
      'testResultId that does not exist answers [] rather than 404, unlike a bogus test case or run key. ' +
      "Returns the API's array of attachment records as-is; each record carries the numeric id delete_attachment needs and the " +
      'url download_attachment accepts.',
    inputSchema: { ...addressingShape },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => zephyrFetch(cfg, { method: 'GET', path: attachmentsPath(args) }),
  });

  defineTool(server, cfg, {
    name: 'download_attachment',
    description:
      'Download the content of an attachment to a local file (GET /rest/tests/1.0/attachment/{id}). ' +
      'Address it by attachmentId or by the exact url list_attachments returns — pass exactly one of the two. ' +
      'Attachment content lives outside API v1: /rest/tests/1.0/attachment/{id} is the url the official list endpoint itself ' +
      'hands out, so this tool follows it without requiring ZEPHYR_ALLOW_INTERNAL_API. ' +
      'A supplied url must be on the configured Jira host — credentials are never sent to another host. ' +
      'A query string on the url is sent as request parameters rather than kept in the path, so it is never echoed in an ' +
      'error message (error messages carry the method and the path only, because a query string can carry a token). ' +
      'outputPath is written on the machine running this MCP server and its parent directory must already exist; ' +
      'a failed download writes nothing. ' +
      'Jira answers a url that is not attachment content (a login redirect, an unknown path) with HTTP 200 and an HTML PAGE, so a ' +
      'response whose body starts with <!DOCTYPE html> or <html> is refused and nothing is written — { savedTo, bytes } therefore ' +
      "means the bytes really came from the attachment endpoint. The refusal names the page it caught (its <title>, or the page's " +
      'first readable text when it has none) so a login redirect, an error page and a wrong host can be told apart. ' +
      'Set allowHtml: true for an attachment that genuinely is an HTML ' +
      'file. Markup that is not a page (XML, SVG) is never affected. ' +
      'Returns { savedTo, bytes }.',
    inputSchema: {
      attachmentId: attachmentIdSchema.optional().describe(
        `${attachmentIdSchema.description ?? ''}; mutually exclusive with url`,
      ),
      url: z
        .string()
        .min(1)
        .optional()
        .describe('Exact download url as returned by list_attachments; must be on the configured Jira host. Mutually exclusive with attachmentId.'),
      outputPath: z
        .string()
        .min(1)
        .describe('Local path to write the file to, on the machine running this MCP server (the parent directory must exist)'),
      allowHtml: z
        .boolean()
        .optional()
        .describe(
          'Save the response even when it is an HTML page (default false). Only for an attachment that really is an HTML file — ' +
            'it disables the guard against saving a Jira login or error page as attachment content.',
        ),
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { cfg }) => {
      const { path, query } = attachmentContentRequest(cfg, args);
      const bytes = await fetchBinary(cfg, path, query);
      if (args.allowHtml !== true) assertNotHtmlPage(bytes, path);
      return writeDownloadedFile(args.outputPath, bytes);
    },
  });

  defineTool(server, cfg, {
    name: 'delete_attachment',
    description:
      'Permanently delete one attachment by its numeric id (DELETE /attachments/{id}). ' +
      'Irreversible, and there is no bulk form — one call per attachment. ' +
      'Ids come from list_attachments or from an upload_attachment response; the entity the attachment belongs to is not needed ' +
      '(ids are global, not per-entity). ' +
      'The DELETE itself answers 2xx even for an id that never existed or was already deleted, so the id is verified FIRST with ' +
      'GET /rest/tests/1.0/attachment/{id} (the one endpoint that 404s for a missing attachment): an unknown id fails without ' +
      "deleting anything, at the cost of downloading the attachment's FULL content first — deleting a large attachment transfers " +
      'the whole file before removing it. ' +
      'Returns { deleted: true, id, existenceVerified: true }, or existenceVerified: false plus a note when that pre-check itself ' +
      'could not answer (the delete is still attempted, so success then does not prove the id existed).',
    inputSchema: { attachmentId: attachmentIdSchema },
    annotations: { destructiveHint: true },
    handler: async (args, { cfg }) => {
      // Found live: DELETE /attachments/{id} answers 2xx for a mistyped or already-deleted id, so a
      // bare { deleted: true } would be a claim we never checked.
      let existenceVerified = true;
      try {
        await fetchBinary(cfg, attachmentContentPathOf(args.attachmentId));
      } catch (err) {
        if (err instanceof ZephyrApiError && err.status === 404) {
          throw new ToolInputError(
            `No attachment with id ${args.attachmentId} exists (GET ${attachmentContentPathOf(args.attachmentId)} answered 404) — ` +
              'nothing was removed. Ids come from list_attachments or an upload_attachment response.',
          );
        }
        // Any other failure of the check (permissions, a build without that endpoint) must not block
        // the delete — report an unverified deletion instead of refusing to work.
        existenceVerified = false;
      }
      await zephyrFetch(cfg, { method: 'DELETE', path: encodePath(atm('/attachments'), args.attachmentId) });
      return existenceVerified
        ? { deleted: true, id: args.attachmentId, existenceVerified }
        : {
            deleted: true,
            id: args.attachmentId,
            existenceVerified,
            note:
              `The pre-delete check GET ${attachmentContentPathOf(args.attachmentId)} did not answer, so the DELETE was sent ` +
              'unverified: its 2xx does not prove the attachment existed. Confirm with list_attachments.',
          };
    },
  });
}
