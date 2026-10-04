const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** All logging goes to stderr — stdout is reserved for the MCP protocol. */
export function log(level: LogLevel, message: string): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  process.stderr.write(`[zephyr-scale-mcp] ${level.toUpperCase()} ${message}\n`);
}
