import type { Config } from './config.ts';
import { log } from './log.ts';

/** Base path of the Zephyr Scale Server/DC REST API v1. */
export const ATM_BASE = '/rest/atm/1.0';

/** Prefix a path with the Zephyr Scale API base: atm('/testcase') -> '/rest/atm/1.0/testcase'. */
export const atm = (path: string): string => `${ATM_BASE}${path}`;

const MAX_ERROR_BODY_BYTES = 2048;
const MAX_RETRY_AFTER_MS = 60_000;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ZephyrFetchOptions {
  method: HttpMethod;
  /** Absolute path starting with /rest/..., without the base URL. */
  path: string;
  /** Query parameters; entries with undefined values are omitted. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body; omitted entirely when undefined. Mutually exclusive with form. */
  body?: unknown;
  /** multipart/form-data body (attachments, automation zips); fetch sets the boundary itself. */
  form?: FormData;
  /** Return the raw response bytes as a Buffer instead of parsing JSON (zip downloads). */
  binaryResponse?: boolean;
}

export class ZephyrApiError extends Error {
  override name = 'ZephyrApiError';
  readonly hint: string | undefined;
  // vender 改动:参数属性(constructor(readonly x))在 Node strip-only 模式下不支持,改为显式字段 + 赋值。
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly responseBody: string;
  /**
   * True when the response body really was an HTML page instead of JSON (e.g. Jira served its generic 404
   * page). A non-empty body is required: an empty body proves nothing about who answered the request.
   */
  readonly htmlBody: boolean;
  /**
   * True when the body was Jira's container-level XML error document. Like htmlBody it means "this was
   * NOT the plugin answering", which is what health_check's probe needs to know — the two are separate
   * because the hints they deserve are different.
   */
  readonly xmlBody: boolean;

  constructor(
    status: number,
    method: string,
    path: string,
    responseBody: string,
    hint?: string,
    htmlBody = false,
    xmlBody = false,
  ) {
    // Per spec: method and path (no query string — it may contain sensitive data), body cut to 2 KB.
    super(`Zephyr API error ${status} (${method} ${path}): ${responseBody}${hint ? `\nHint: ${hint}` : ''}`);
    this.hint = hint;
    this.status = status;
    this.method = method;
    this.path = path;
    this.responseBody = responseBody;
    this.htmlBody = htmlBody;
    this.xmlBody = xmlBody;
  }
}

/** Append a tool-specific hint to an API error; other error kinds pass through unchanged. */
export function addHint(err: unknown, extra: string): unknown {
  if (err instanceof ZephyrApiError) {
    return new ZephyrApiError(
      err.status,
      err.method,
      err.path,
      err.responseBody,
      err.hint ? `${err.hint}\n${extra}` : extra,
      err.htmlBody,
    );
  }
  return err;
}

export class NetworkError extends Error {
  override name = 'NetworkError';
}

function authHeader(cfg: Config): string {
  if (cfg.auth === 'basic') {
    return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  }
  return `Bearer ${cfg.pat}`;
}

function truncate(text: string, max = MAX_ERROR_BODY_BYTES): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/**
 * The automation export's dialect, as measured on the stand — the list must stay a list of what WORKS.
 * The previous text named testCase.folder among the dialect's fields, so a caller whose folder query had
 * just been rejected was told to send it again (found live).
 */
const AUTOMATION_TQL_HINT =
  'The automation export speaks its own TQL dialect, testCase.-prefixed and NOT the one search_test_cases uses, and it ' +
  'queries ONLY testCase.key, testCase.projectKey and testCase.name (operators = and IN, clauses joined by AND). ' +
  'testCase.folder, testCase.status, testCase.priority and testCase.labels are rejected with this same 400, so a whole ' +
  'folder cannot be exported through this endpoint — pick the cases out with search_test_cases (which does query folders) ' +
  'and export them by key, e.g. testCase.key IN ("PROJ-T1", "PROJ-T2") or testCase.projectKey = "PROJ". Values must be ' +
  'quoted; lowercase "and", lowercase "testcase." and OR are not accepted either.';

const TQL_HINT =
  'TQL syntax is strict: string values go in double quotes, only AND is supported as the logical operator, and field ' +
  'names and values are case-sensitive. Spaces around operators are recommended (some builds also accept field="value").';

const FOLDER_CREATE_HINT =
  'Folders are not created automatically — create the folder first with create_folder (full path from the root, e.g. ' +
  '"/Regression/Payments"). The path is case-sensitive, must not end with "/" and cannot be "/" itself, and every entity ' +
  'type has its own folder tree: a TEST_RUN folder cannot be used as a test case folder even when the paths look identical.';

const FOLDER_SEARCH_HINT =
  'No folder with that exact path exists for this entity type — list the existing paths with get_folder_tree (paths are ' +
  'case-sensitive and each entity type has its own tree), or create it with create_folder.';

const FOLDER_EXISTS_HINT =
  'That folder path already exists — create_folder is not idempotent. Use the existing folder (get_folder_tree gives its ' +
  'id) or choose another path.';

const STATUS_HINT =
  'Status/priority values are case-sensitive internal (non-localized) names; check how they are configured for this project.';

const COMPONENT_HINT =
  'Component names must match a component configured on the Jira project and are case-sensitive — check the project ' +
  'components in Jira.';

const CUSTOM_FIELD_HINT =
  'Custom field names are defined per project and entity type and are case-sensitive — list the ones this project has ' +
  'with get_custom_field_definitions.';

const USER_FIELD_HINT =
  'owner/executedBy/assignedTo take a Jira user KEY (e.g. JIRAUSER10000), not a username or an e-mail. The same message is ' +
  'returned for a value of the wrong shape and for a well-formed key that does not exist (or that your account cannot see), ' +
  'and the response does not say which — resolve the intended user with find_jira_user and compare.';

/** The rejected user value is already key-shaped, so the format advice would be wrong. */
const USER_KEY_SHAPE_HINT = (value: string): string =>
  `"${value}" already has the shape of a Jira user key, so the format is probably not the problem: on this build the same ` +
  'message is returned when no user with that key exists or your account cannot see it. Look the intended user up with ' +
  'find_jira_user and compare the key it returns.';

/** The rejected user value is not key-shaped, so it was most likely a username or an e-mail. */
const USER_NOT_A_KEY_HINT = (value: string): string =>
  `owner/executedBy/assignedTo take a Jira user KEY (e.g. JIRAUSER10000). "${value}" is not in that shape, so it was most ` +
  'likely taken for a username or an e-mail — resolve the key with find_jira_user. (A well-formed key that does not exist ' +
  'is rejected with this same message.)';

/**
 * issueLinks (and any other field holding a Jira issue key) is validated against JIRA, not against a list of
 * values configured on the project, so the environment/iteration/version advice does not apply to it — and
 * neither does "case-sensitive internal names": Jira resolves issue keys case-insensitively (live: "nbul-1"),
 * which is exactly what this server's own 404 hint for /issuelink/ says.
 */
const ISSUE_KEY_FIELD_HINT = (field: string, value: string | undefined): string =>
  `${value === undefined ? `The value rejected for field ${field}` : `"${value}"`} is read as a JIRA ISSUE KEY, and Jira ` +
  'could not resolve it: the value is not spelled the way the issue key is stored, the issue does not exist, lives in another ' +
  'project, or is not visible to this account. Case matters HERE even though Jira itself matches issue keys case-insensitively ' +
  'elsewhere: this field is resolved by Zephyr, and "nbul-809" and "Nbul-809" are both rejected while "NBUL-809" is accepted ' +
  '(measured live) — so copy the key exactly as Jira shows it. Only Jira issue keys (PROJECT-123) belong in this field: a test ' +
  'case key or a numeric id would be rejected the same way.';

const STEP_ID_HINT =
  'That step id is not one of the ids stored on THIS test case: step ids are assigned by the server and are scoped to a ' +
  'single test case, so an invented id — or a real id belonging to another case — is rejected exactly like this. Read the ' +
  'stored ids with get_test_case, omit `id` on a step to have a new one created, and let add_test_steps (insert) or ' +
  'set_test_script (full rewrite, which DELETES every stored step whose id you do not send) manage them.';

/** Rejections naming a testScript.* field: about the script payload, never about a project-configured value list. */
const testScriptHint = (field: string): string =>
  `The rejected value sits inside the test script (field ${field}), not in a list of values configured for the project: ` +
  'check the script payload itself — `type` must be STEP_BY_STEP, PLAIN_TEXT or BDD and must match the field you sent ' +
  '(steps for STEP_BY_STEP, text for the other two) — and edit steps with add_test_steps or set_test_script.';

const EMPTY_400_HINT =
  'The request was rejected with an empty body. Zephyr Scale\'s own validation always names the offending field, so an ' +
  'empty-bodied 400 on this build most likely comes from the layer in front of it (Jira/Tomcat), whose usual causes are a ' +
  'path segment or a parameter that could not be parsed at all — typically a non-numeric id where a number is required, or ' +
  'a key carrying a character that must be percent-encoded. Check the ids and keys in the path first; the JSON body is ' +
  'rarely the cause.';

const PROJECT_FIELD_HINT =
  'The project key was rejected — it must exist and your account must see it in Zephyr Scale. Any other message in this ' +
  'response (folder, status, …) is usually a consequence of the bad project key, so fix that one first.';

const UNRECOGNIZED_FIELD_HINT =
  'That field name is not accepted here: the searchable fields differ per entity type and per build, and custom fields ' +
  'must be spelled exactly as configured — see the field list in the tool description and get_custom_field_definitions.';

const RUN_SEARCH_FIELDS_HINT =
  'This build searches test runs by projectKey and folder only — drop the other clauses and read the candidate runs with ' +
  'get_test_run.';

const BDD_HINT =
  'The API rejected the script as invalid BDD without saying which line it disliked. It stores Gherkin STEP lines only ' +
  '(Given/When/Then/And/But …): both a "Feature:"/"Scenario:" header and an ordinary prose line are rejected with this same ' +
  'message, so check every line of the text you sent, not only the first one.';

const PLUGIN_UNREACHABLE_HINT =
  `Received an HTML page instead of JSON — the Zephyr Scale plugin is probably not reachable at ${ATM_BASE}. Check that ` +
  'the plugin is installed/licensed and JIRA_BASE_URL is correct; health_check confirms it either way.';

/**
 * Reduce an HTML error page (Jira / Tomcat) to a single readable line so the real message is not lost.
 * Text is harvested per element and repeated blocks are dropped: a Tomcat error page carries the same
 * sentence in its <title> and its <h1>, which used to be echoed twice and ate the 200-character budget.
 */
function htmlMessage(body: string): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').split(/<[^>]*>/)) {
    const block = raw
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (block === '') continue;
    const key = block.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
  }
  const text = blocks.join(' ');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** The value the API rejected, for the bodies that quote it before naming the field. */
function rejectedValue(body: string): string | undefined {
  return /\bThe (?:value|user|project|key)\s+(.+?)\s+was not found for field/i.exec(body)?.[1];
}

/** Hint for "The value X was not found for field <field>" / "Value(s) not found for field <field>" rejections. */
function valueFieldHint(field: string, isSearch: boolean, body: string): string {
  // The field can be a dotted/indexed path (testScript.steps[0].id); the message ends in a full stop.
  const name = field.replace(/\.+$/, '');
  const lower = name.toLowerCase();
  // A step id is an internal, per-case identifier — none of the project-configured-value advice applies.
  if (/^testscript\b/.test(lower)) {
    return /\bsteps\[\d+]\.id$/.test(lower) ? STEP_ID_HINT : testScriptHint(name);
  }
  // Jira-issue-shaped fields (issueLinks, issueLinks[0], issueKey, traceLinks) are validated against Jira.
  if (/^(?:issue(?:links?|keys?)|tracelinks?)\b/.test(lower)) {
    return ISSUE_KEY_FIELD_HINT(name, rejectedValue(body));
  }
  switch (lower) {
    case 'projectkey':
      return PROJECT_FIELD_HINT;
    case 'folder':
      return isSearch ? FOLDER_SEARCH_HINT : FOLDER_CREATE_HINT;
    case 'status':
    case 'priority':
      return STATUS_HINT;
    case 'component':
      return COMPONENT_HINT;
    case 'owner':
    case 'executedby':
    case 'assignedto': {
      const value = rejectedValue(body);
      if (value === undefined) return USER_FIELD_HINT;
      return /^JIRAUSER\d+$/i.test(value) ? USER_KEY_SHAPE_HINT(value) : USER_NOT_A_KEY_HINT(value);
    }
    default:
      return `The value is not one of the values configured for field ${name} on this project — environment, iteration and version are validated the same way, and all of them are case-sensitive internal (non-localized) names.`;
  }
}

/**
 * Hint for a 400. Driven by the RESPONSE body first and only then by the endpoint: keying on the request
 * used to misdiagnose routinely (found live — a TQL *value* error was lectured about TQL *syntax*, a
 * "folder already exists" 400 was told to create that folder, and a Tomcat 400 got a status/priority hint).
 */
function hint400(path: string, body: string, looksLikeHtml: boolean): string | undefined {
  const isSearch = /\/search$/.test(path);
  if (looksLikeHtml) {
    return `Jira answered with an HTML error page, so the request was probably rejected before it reached Zephyr Scale: "${htmlMessage(body)}". A key or path segment carrying a character that must be encoded (e.g. "/") is the usual cause.`;
  }
  // Every other 400 hint is selected from the body, so an empty one used to fall through with no hint at all
  // (except on /search, whose last-resort TQL lead is kept here: the query is that endpoint's only input).
  if (body === '') return isSearch ? `${EMPTY_400_HINT}\n${TQL_HINT}` : EMPTY_400_HINT;
  if (/already exists/i.test(body)) {
    return /folder/i.test(body)
      ? FOLDER_EXISTS_HINT
      : 'That entity already exists — this endpoint is not idempotent; read or update the existing one instead of creating it again.';
  }
  if (/only '?projectKey'? and '?folder'?/i.test(body)) return RUN_SEARCH_FIELDS_HINT;
  if (/unrecognized field/i.test(body)) return UNRECOGNIZED_FIELD_HINT;
  if (/query statement is not valid|invalid query|\btql\b/i.test(body)) {
    // /automation/testcases speaks its own dialect: the fields must be testCase.-prefixed there, so the
    // cheat sheet for /testcase/search would send the caller in the wrong direction (found live).
    return path.includes('/automation/testcases') ? AUTOMATION_TQL_HINT : TQL_HINT;
  }
  if (/invalid bdd script/i.test(body)) return BDD_HINT;
  if (/custom field/i.test(body)) return CUSTOM_FIELD_HINT;
  const valueField = /not found for field\s+"?([A-Za-z][A-Za-z0-9_.[\]]*)/i.exec(body)?.[1];
  if (valueField !== undefined) return valueFieldHint(valueField, isSearch, body);
  // Fallbacks for builds that phrase the same rejections differently than the audited one.
  if (/\bfolder\b/i.test(body)) return isSearch ? FOLDER_SEARCH_HINT : FOLDER_CREATE_HINT;
  if (/\bstatus\b|\bpriority\b/i.test(body)) return STATUS_HINT;
  if (/\bcomponent\b/i.test(body)) return COMPONENT_HINT;
  if (isSearch) return TQL_HINT; // last resort: the only input of a /search endpoint is the TQL query
  return undefined;
}

const GENERIC_SUBJECT = 'the key/id (test case: PROJ-T1, test plan: PROJ-P1, test run: PROJ-R1)';

/**
 * Path segments that address a THING, with the text naming it. A segment only addresses something when a
 * value follows it, so a path ending in a collection ("…/attachments", "…/testresult") contributes nothing.
 */
const ADDRESSABLE: Record<string, { numeric: boolean; text: (value: string) => string }> = {
  testcase: { numeric: false, text: () => 'the test case key (PROJ-T1)' },
  testrun: { numeric: false, text: () => 'the test run key (PROJ-R1, or PROJ-C1 on legacy builds)' },
  testplan: { numeric: false, text: () => 'the test plan key (PROJ-P1)' },
  issuelink: { numeric: false, text: () => 'the Jira issue key — the issue must exist and be visible to your account' },
  // /rest/api/2/issue/{key} — Jira's own endpoint, used when a tool resolves an issue key to its id.
  issue: { numeric: false, text: () => 'the Jira issue key — the issue must exist and be visible to your account' },
  project: { numeric: false, text: () => 'the PROJECT key — it must exist and be visible to your account' },
  folder: {
    numeric: true,
    text: () =>
      'the numeric folder id — the public API cannot list folders, so take the id from create_folder, get_folder_tree or the Jira UI',
  },
  testresult: { numeric: true, text: () => 'the numeric test result id (create_test_result and get_test_run_results return it)' },
  attachment: { numeric: true, text: () => 'the numeric attachment id (list_attachments gives the ids that exist)' },
  attachments: { numeric: true, text: () => 'the numeric attachment id (list_attachments gives the ids that exist)' },
  step: {
    numeric: true,
    text: (value) =>
      `the 0-based step index (${value}): an index past the last stored step answers 404 even when the key addressing the entity is perfectly valid, and get_test_case lists the steps that exist`,
  },
};

/** Sub-resources and verbs — never the value of the segment before them. */
const RESERVED_SEGMENTS = new Set([
  'search',
  'bulk',
  'link-issues',
  'latest',
  'page',
  'attachments',
  'attachment',
  'testresult',
  'testresults',
  'testcase',
  'testcases',
  'testrun',
  'testplan',
  'step',
  'delete',
]);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Walk the path and collect every segment that addresses an entity, in path order. */
function addressableEntities(path: string): string[] {
  const segments = path.split('/').filter((segment) => segment !== '');
  const found: string[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const spec = ADDRESSABLE[decodeSegment(segments[i]).toLowerCase()];
    if (spec === undefined) continue;
    const value = decodeSegment(segments[i + 1]);
    if (RESERVED_SEGMENTS.has(value.toLowerCase())) continue;
    if (spec.numeric && !/^\d+$/.test(value)) continue;
    found.push(spec.text(value));
  }
  return found;
}

/**
 * What a 404 on this path is about, so the hint names the thing the caller actually passed. The whole path
 * is walked and the LAST addressable segment is named first — found live, naming the first entity instead
 * sent callers to check a test case key that was provably valid while the step index or the run key was the
 * wrong one. Every other addressable segment of the path is named too, rather than silently discarded.
 */
/**
 * Case sensitivity differs by key family, and claiming otherwise sends people hunting for a typo that
 * is not there: Zephyr's own keys are case-sensitive, Jira issue keys are not (live: "nbul-1" resolves).
 */
function keyCaseNote(path: string): string {
  return /\/issuelink\/|\/rest\/api\/2\//.test(path)
    ? 'Jira issue and project keys are matched case-insensitively, so a wrong project or a deleted issue is more likely than a typo in the case.'
    : 'Zephyr keys are case-sensitive.';
}

function notFoundSubject(path: string): string {
  // POST/PUT /testrun/{runKey}/testcase/{caseKey}/testresult carries two keys and only one of them can 404:
  // an unknown CASE key is answered with a 400 naming the field, so an empty 404 points at the run key.
  if (/\/testrun\/[^/]+\/testcase\/[^/]+\/testresult/.test(path)) {
    return (
      'BOTH keys this path carries — the test run key (PROJ-R1, or PROJ-C1 on legacy builds) first, the test case key ' +
      '(PROJ-T1) second: on this endpoint an unknown test CASE key is reported as 400 "The key … cannot be found for field ' +
      'testCaseKey.", so a 404 here points at the run key rather than at the case'
    );
  }
  const entities = addressableEntities(path);
  if (entities.length === 0) return GENERIC_SUBJECT;
  const last = entities[entities.length - 1];
  const earlier = entities.slice(0, -1).reverse();
  const subject = earlier.length === 0 ? last : `${last}, and then ${earlier.join(' and ')}`;
  // GET /testcase/{key}/testresult[/latest] — the run-composition 404 belongs to this endpoint only.
  return /\/testcase\/[^/]+\/testresult/.test(path)
    ? `${subject} — this endpoint also answers 404 while the case is not an item of any test run`
    : subject;
}

/**
 * Hint for a 404. The three bodies mean three different things and must not be conflated (found live):
 * an HTML page under the plugin base really is "no handler mounted there", a body with an API message
 * speaks for itself, and an EMPTY body is what this build answers for a key that does not exist — it is
 * no evidence at all about the plugin, so it must not send the caller to audit the installation.
 */
/** The <message> of Jira's container-level XML error document, when there is one. */
function xmlMessage(body: string): string | undefined {
  const message = /<message>([\s\S]*?)<\/message>/i.exec(body)?.[1]?.trim();
  return message && message !== 'null' ? message : undefined;
}

function hint404(path: string, body: string, looksLikeHtml: boolean): string {
  if (/^\s*<\?xml/i.test(body)) {
    const message = xmlMessage(body);
    return (
      'Jira answered with its container-level XML error document rather than an API response, which means nothing is ' +
      `mounted at this path${message ? ` (${message})` : ''}. That is a wrong path or a wrong id in it — not evidence ` +
      'about the Zephyr Scale plugin, which answers its own 404s as JSON or as an empty body.'
    );
  }
  if (looksLikeHtml && path.startsWith(ATM_BASE)) return PLUGIN_UNREACHABLE_HINT;
  const subject = notFoundSubject(path);
  if (body === '') {
    return (
      `Entity not found: the response carried no error details, which on this build means nothing exists at this path. ` +
      `A wrong, mistyped or already-deleted key is by far the usual cause — check ${subject}; ${keyCaseNote(path)} ` +
      `Zephyr keys are never reused after a delete and must be of the right entity type. Less often the endpoint itself ` +
      `is missing on this Zephyr Scale build, which health_check can tell apart.`
    );
  }
  return `Entity not found — check ${subject}.`;
}

/**
 * Hint for a 5xx. Only an HTML page and an empty body carry information; a real error body speaks for itself.
 *
 * The empty-bodied branch is reached by several endpoints and must not guess: a response with no message
 * establishes only that the request was answered by the API itself and failed there. Everything else is a
 * candidate, and is phrased as one (found live: the old text named one cause and predicted the retry).
 */
function hint5xx(status: number, path: string, body: string, looksLikeHtml: boolean): string | undefined {
  if (looksLikeHtml) {
    return `The server answered with an HTML error page rather than a Zephyr Scale error: "${htmlMessage(body)}". The request may have been handled by Jira or a proxy instead of the plugin; health_check confirms whether the plugin answers.`;
  }
  if (body === '') {
    const reached = path.startsWith(ATM_BASE) ? 'reached the Zephyr Scale plugin' : 'reached the API';
    return (
      `The server answered ${status} with an empty body: it failed without a message, so this response does not say why. ` +
      `What it does establish is that the request ${reached} and was answered there — a bare status, not a validation ` +
      `error and not a page from a proxy — and that the failure happened while the request was being handled. The cause ` +
      `is recorded only in the Jira server log, which holds the stack trace. Candidates, none of them established by ` +
      `this response: an input the endpoint cannot process (an over-long or otherwise unhandled value), an operation ` +
      `this build does not implement, or a transient fault. A 500 is no proof that nothing happened — on a write, read ` +
      `the entity back before sending the same request once more.`
    );
  }
  return undefined;
}

function buildHint(status: number, path: string, body: string, looksLikeHtml: boolean): string | undefined {
  const text = body.trim();
  switch (status) {
    case 400:
      return hint400(path, text, looksLikeHtml);
    case 401:
      return 'Authentication failed — check JIRA_PAT (or JIRA_USERNAME/JIRA_PASSWORD) and that the token is not expired or revoked.';
    case 403:
      return 'Missing permission — the response body may name the required Zephyr Scale permission (e.g. CREATE_TEST_CASE). Check the Zephyr permission scheme of the project.';
    case 404:
      return hint404(path, text, looksLikeHtml);
    case 405:
      return 'HTTP 405 means the endpoint exists but does not accept this method — on Zephyr Scale that normally means the operation is not available on this build; do it in the Jira UI instead.';
    default:
      return status >= 500 ? hint5xx(status, path, text, looksLikeHtml) : undefined;
  }
}

function retryDelayMs(attempt: number, retryAfter: string | null, baseMs: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return baseMs * 2 ** attempt + Math.floor(Math.random() * 100);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function toApiError(res: Response, opts: ZephyrFetchOptions): Promise<ZephyrApiError> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // keep empty body
  }
  const contentType = res.headers.get('content-type') ?? '';
  // An EMPTY body is never an HTML page, whatever the content-type claims: found live, this build answers a
  // missing entity with 404 + content-type text/html + a zero-length body, which used to be reported as
  // "the plugin is not reachable" on the single most common error of the whole server.
  // XML is not HTML: Jira's container answers an unknown path under /rest with an XML <status> document,
  // and matching it as "an HTML page" blamed the Zephyr plugin for what is really a wrong path (found live).
  const looksLikeXml = bodyText.trim() !== '' && (contentType.includes('xml') || /^\s*<\?xml/i.test(bodyText));
  const looksLikeHtml = !looksLikeXml && bodyText.trim() !== '' && (contentType.includes('html') || /^\s*</.test(bodyText));
  const body = truncate(bodyText.trim()) || res.statusText || '(empty response body)';
  return new ZephyrApiError(res.status, opts.method, opts.path, body, buildHint(res.status, opts.path, bodyText, looksLikeHtml), looksLikeHtml, looksLikeXml);
}

async function parseSuccess(res: Response, binary: boolean): Promise<unknown> {
  if (binary) {
    // Keep the Buffer contract even for empty 204/205 responses.
    if (res.status === 204 || res.status === 205) return Buffer.alloc(0);
    return Buffer.from(await res.arrayBuffer());
  }
  if (res.status === 204 || res.status === 205) return {};
  const text = await res.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Perform an HTTP request against Jira / Zephyr Scale.
 *
 * Retry policy (per spec §9): 429/503 are retried for any method honoring Retry-After;
 * other 5xx, network errors and timeouts are retried for GET only, with exponential
 * backoff (retryBaseDelayMs * 2^n + jitter), at most cfg.maxRetries retries.
 */
export async function zephyrFetch(cfg: Config, opts: ZephyrFetchOptions): Promise<unknown> {
  const url = new URL(cfg.baseUrl + opts.path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const maxAttempts = cfg.maxRetries + 1;
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= maxAttempts - 1;
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers: {
          Authorization: authHeader(cfg),
          Accept: opts.binaryResponse ? '*/*' : 'application/json',
          // For form bodies fetch sets multipart/form-data with the boundary itself.
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (cause) {
      const reason =
        cause instanceof Error && cause.name === 'TimeoutError'
          ? `timed out after ${cfg.timeoutMs} ms`
          : cause instanceof Error
            ? `${cause.message}${cause.cause instanceof Error ? ` (${cause.cause.message})` : ''}`
            : String(cause);
      if (opts.method === 'GET' && !isLastAttempt) {
        log('debug', `retrying ${opts.method} ${opts.path} after network error: ${reason}`);
        await sleep(retryDelayMs(attempt, null, cfg.retryBaseDelayMs));
        continue;
      }
      throw new NetworkError(`Network error (${opts.method} ${opts.path}): ${reason}`);
    }

    if (res.ok) return parseSuccess(res, opts.binaryResponse === true);

    const retryable = res.status === 429 || res.status === 503 || (opts.method === 'GET' && res.status >= 500);
    if (retryable && !isLastAttempt) {
      await res.text().catch(() => undefined); // drain the body so the connection can be reused
      log('debug', `retrying ${opts.method} ${opts.path} after HTTP ${res.status}`);
      await sleep(retryDelayMs(attempt, res.headers.get('retry-after'), cfg.retryBaseDelayMs));
      continue;
    }
    throw await toApiError(res, opts);
  }
}
