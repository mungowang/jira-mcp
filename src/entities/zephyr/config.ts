import type { LogLevel } from './log.ts';

export interface Config {
  /** Jira base URL without a trailing slash, e.g. https://jira.example.com */
  baseUrl: string;
  auth: 'pat' | 'basic';
  pat?: string;
  username?: string;
  password?: string;
  timeoutMs: number;
  maxRetries: number;
  /** Base delay for exponential backoff (not exposed via env; overridable in tests). */
  retryBaseDelayMs: number;
  tlsRejectUnauthorized: boolean;
  defaultProjectKey?: string;
  readonly: boolean;
  /** Enables UNOFFICIAL tools backed by the internal /rest/tests/1.0 API (§7.6); off by default. */
  allowInternalApi: boolean;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function parseBoolean(name: string, rawValue: string | undefined, dflt: boolean, errors: string[]): boolean {
  if (rawValue === undefined || rawValue === '') return dflt;
  // A set-but-blank flag is a mistake, not "unset": silently defaulting ZEPHYR_READONLY=' ' to false
  // would start a write-enabled server for someone who believes writes are off. Numeric settings are
  // different (see parseInteger) — there, blank has no unsafe reading.
  const raw = rawValue.trim();
  if (/^(true|1|yes)$/i.test(raw)) return true;
  if (/^(false|0|no)$/i.test(raw)) return false;
  errors.push(`${name} must be 'true' or 'false', got '${raw}'`);
  return dflt;
}

function parseInteger(name: string, rawValue: string | undefined, dflt: number, min: number, errors: string[]): number {
  // Trim first: a whitespace-only value must mean "unset" (Number('  ') is 0, which silently
  // disabled retries when JIRA_MAX_RETRIES was set to spaces).
  const raw = rawValue?.trim();
  if (raw === undefined || raw === '') return dflt;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    errors.push(`${name} must be an integer >= ${min}, got '${raw}'`);
    return dflt;
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const errors: string[] = [];

  const rawBaseUrl = env.JIRA_BASE_URL?.trim();
  let baseUrl = '';
  if (!rawBaseUrl) {
    errors.push('JIRA_BASE_URL is required (e.g. https://jira.example.com)');
  } else {
    try {
      const url = new URL(rawBaseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.push(`JIRA_BASE_URL must use http/https, got '${url.protocol}'`);
      }
      baseUrl = rawBaseUrl.replace(/\/+$/, '');
    } catch {
      errors.push(`JIRA_BASE_URL is not a valid URL: '${rawBaseUrl}'`);
    }
  }

  const auth = (env.JIRA_AUTH?.trim() || 'pat') as Config['auth'];
  if (auth !== 'pat' && auth !== 'basic') {
    errors.push(`JIRA_AUTH must be 'pat' or 'basic', got '${env.JIRA_AUTH}'`);
  }

  const pat = env.JIRA_PAT;
  const username = env.JIRA_USERNAME;
  const password = env.JIRA_PASSWORD;
  if (auth === 'pat' && !pat) {
    errors.push('JIRA_PAT is required when JIRA_AUTH=pat');
  }
  if (auth === 'basic' && (!username || !password)) {
    errors.push('JIRA_USERNAME and JIRA_PASSWORD are required when JIRA_AUTH=basic');
  }

  const timeoutMs = parseInteger('JIRA_TIMEOUT_MS', env.JIRA_TIMEOUT_MS, 30_000, 1, errors);
  const maxRetries = parseInteger('JIRA_MAX_RETRIES', env.JIRA_MAX_RETRIES, 2, 0, errors);
  const tlsRejectUnauthorized = parseBoolean('JIRA_TLS_REJECT_UNAUTHORIZED', env.JIRA_TLS_REJECT_UNAUTHORIZED, true, errors);
  const readonly = parseBoolean('ZEPHYR_READONLY', env.ZEPHYR_READONLY, false, errors);
  const allowInternalApi = parseBoolean('ZEPHYR_ALLOW_INTERNAL_API', env.ZEPHYR_ALLOW_INTERNAL_API, false, errors);

  const logLevel = (env.ZEPHYR_LOG_LEVEL?.trim() || 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    errors.push(`ZEPHYR_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got '${env.ZEPHYR_LOG_LEVEL}'`);
  }

  if (errors.length > 0) {
    throw new ConfigError(errors.map((e) => `- ${e}`).join('\n'));
  }

  for (const [name, value] of [
    ['JIRA_PAT', pat],
    ['JIRA_PASSWORD', password],
  ] as const) {
    if (value && value.length < 6) {
      process.stderr.write(
        `[zephyr-scale-mcp] WARN ${name} is shorter than 6 characters — it will NOT be redacted from tool output or logs\n`,
      );
    }
  }

  if (!tlsRejectUnauthorized) {
    // Global fetch (undici) has no per-request TLS option; this is the documented Node switch.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.stderr.write(
      '[zephyr-scale-mcp] WARN JIRA_TLS_REJECT_UNAUTHORIZED=false — TLS certificate verification is DISABLED for all requests\n',
    );
  }

  const config: Config = {
    baseUrl,
    auth,
    timeoutMs,
    maxRetries,
    retryBaseDelayMs: 500,
    tlsRejectUnauthorized,
    readonly,
    allowInternalApi,
    logLevel,
  };
  if (pat) config.pat = pat;
  if (username) config.username = username;
  if (password) config.password = password;
  const defaultProjectKey = env.ZEPHYR_DEFAULT_PROJECT_KEY?.trim();
  if (defaultProjectKey) config.defaultProjectKey = defaultProjectKey;
  return config;
}
