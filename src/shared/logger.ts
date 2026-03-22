/**
 * Logger utility for claude-azure-pg-mem.
 *
 * Design constraints:
 * - Writes exclusively to stderr so stdout stays clean for MCP JSON-RPC.
 * - Log level is controlled by AGENT_MEM_LOG_LEVEL env var or settings.json.
 * - Format: [LEVEL] [COMPONENT] message {metadata}
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported log levels in ascending severity order. */
const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric weight for quick comparison. */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the active log level from env, falling back to INFO. */
function resolveLevel(): LogLevel {
  const raw = process.env.AGENT_MEM_LOG_LEVEL?.toUpperCase();
  if (raw && LOG_LEVELS.includes(raw as LogLevel)) {
    return raw as LogLevel;
  }
  return 'INFO';
}

/** Format an optional metadata object into a compact JSON suffix. */
function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' [meta-serialization-error]';
  }
}

// ---------------------------------------------------------------------------
// Core write function
// ---------------------------------------------------------------------------

function write(
  level: LogLevel,
  component: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const threshold = resolveLevel();
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;

  const line = `[${level}] [${component}] ${message}${formatMeta(meta)}\n`;

  // Always write to stderr – never stdout – to avoid corrupting MCP traffic.
  process.stderr.write(line);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a component-scoped logger.
 *
 * ```ts
 * const log = logger.child('Worker');
 * log.info('Listening', { port: 37778 });
 * // => [INFO] [Worker] Listening {"port":37778}
 * ```
 */
function child(component: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) =>
      write('DEBUG', component, msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) =>
      write('INFO', component, msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      write('WARN', component, msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) =>
      write('ERROR', component, msg, meta),
  };
}

/** Default logger instance (component = "App"). */
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    write('DEBUG', 'App', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) =>
    write('INFO', 'App', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    write('WARN', 'App', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    write('ERROR', 'App', msg, meta),
  child,
};
