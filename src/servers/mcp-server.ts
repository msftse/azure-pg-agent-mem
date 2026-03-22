/**
 * MCP Server for claude-azure-pg-mem.
 *
 * A thin stdio-based proxy that exposes memory-retrieval tools over the
 * Model Context Protocol. All heavy lifting is delegated to the Worker HTTP
 * API – this process only serialises/deserialises JSON-RPC and forwards
 * requests.
 *
 * Three tools implement a **progressive disclosure** pattern:
 *   1. search           – lightweight results (~50-100 tokens each)
 *   2. timeline         – medium context   (~200-500 tokens)
 *   3. get_observations – full details      (~500-1000 tokens each)
 *
 * Lifecycle:
 *   - Reads the worker port from shared settings (default 37778).
 *   - Verifies worker connectivity before accepting tool calls.
 *   - Exits automatically if the parent process dies (heartbeat every 30 s).
 */

// Redirect console.log → stderr *immediately*. MCP uses stdout exclusively
// for JSON-RPC traffic; any stray console.log would corrupt the protocol.
const _origLog = console.log;
console.log = (...args: unknown[]) => {
  console.error(...args);
};

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import os from 'node:os';
import { getSetting } from '../shared/settings.js';
import { logger } from '../shared/logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const log = logger.child('MCP');

const WORKER_PORT = getSetting('WORKER_PORT') || '37778';
const WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;

// ---------------------------------------------------------------------------
// User-ID resolution (must match cli/client.ts and postgres/client.ts)
// ---------------------------------------------------------------------------

function resolveUserId(): string {
  const explicit = getSetting('USER_ID');
  if (explicit) return explicit;

  const raw = `${os.userInfo().username}@${os.hostname()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Worker HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Issue a GET request to the Worker API with query-string parameters.
 * Automatically injects `user_id` for RLS.
 * Returns the MCP tool result format: `{ content: [{ type, text }] }`.
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, unknown>,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const url = new URL(endpoint, WORKER_BASE);

  // Inject user_id for RLS.
  url.searchParams.set('user_id', resolveUserId());

  // Append non-undefined params as query-string entries.
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString());
  const body = await res.text();

  if (!res.ok) {
    log.error('Worker API error', { endpoint, status: res.status, body });
    return { content: [{ type: 'text', text: `Error (${res.status}): ${body}` }] };
  }

  return { content: [{ type: 'text', text: body }] };
}

/**
 * Issue a POST request to the Worker API with a JSON body.
 * Automatically injects `user_id` for RLS.
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: unknown,
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const url = new URL(endpoint, WORKER_BASE);

  // Merge user_id into the body for RLS.
  const enrichedBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? { user_id: resolveUserId(), ...body }
      : { user_id: resolveUserId(), data: body };

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(enrichedBody),
  });

  const text = await res.text();

  if (!res.ok) {
    log.error('Worker API error', { endpoint, status: res.status, body: text });
    return { content: [{ type: 'text', text: `Error (${res.status}): ${text}` }] };
  }

  return { content: [{ type: 'text', text }] };
}

/**
 * Verify the Worker daemon is reachable before serving tool calls.
 * Throws if the worker is not running.
 */
async function verifyWorkerConnection(): Promise<void> {
  try {
    const res = await fetch(`${WORKER_BASE}/api/health`);
    if (!res.ok) {
      throw new Error(`Worker health check failed with status ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    log.info('Worker connection verified', { version: data.version, pid: data.pid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Cannot reach worker daemon', { url: WORKER_BASE, error: message });
    throw new Error(
      `Worker daemon is not reachable at ${WORKER_BASE}. ` +
        'Start it with: claude-azure-pg-mem worker start',
    );
  }
}

// ---------------------------------------------------------------------------
// Parent-process heartbeat
// ---------------------------------------------------------------------------

/**
 * Poll the parent PID every 30 s. If the parent has exited (ppid becomes 1 on
 * Linux or changes on macOS), terminate this process so orphaned MCP servers
 * don't linger.
 */
function startParentHeartbeat(): void {
  const parentPid = process.ppid;

  const interval = setInterval(() => {
    if (process.ppid !== parentPid) {
      log.warn('Parent process exited – shutting down MCP server', {
        originalPpid: parentPid,
        currentPpid: process.ppid,
      });
      clearInterval(interval);
      process.exit(0);
    }
  }, 30_000);

  // Allow the Node.js event loop to exit naturally if nothing else keeps it alive.
  interval.unref();
}

// ---------------------------------------------------------------------------
// MCP Server definition
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'claude-azure-pg-mem',
  version: '0.1.0',
});

// ── Tool 1: search ──────────────────────────────────────────────────────────
// Lightweight results for broad exploration (~50-100 tokens per result).

server.tool(
  'search',
  'Search observations in memory. Returns compact results ideal for scanning. ' +
    'Filter by project, type, obs_type, date range. Supports full-text and ' +
    'semantic search via the query parameter. Use get_observations to fetch ' +
    'full details for interesting IDs.',
  {
    query: z.string().optional().describe('Free-text / semantic search query'),
    project: z.string().optional().describe('Filter by project name'),
    type: z
      .string()
      .optional()
      .describe('Record type: observations, sessions, prompts'),
    obs_type: z
      .string()
      .optional()
      .describe('Observation category: bugfix, feature, refactor, discovery, decision, change'),
    limit: z.number().optional().default(20).describe('Max results to return'),
    offset: z.number().optional().default(0).describe('Pagination offset'),
    dateStart: z.string().optional().describe('Start date filter (ISO 8601)'),
    dateEnd: z.string().optional().describe('End date filter (ISO 8601)'),
    orderBy: z
      .string()
      .optional()
      .describe('Sort order: date_desc, date_asc, relevance. Defaults to relevance when query is provided, date_desc otherwise.'),
  },
  async (params) => {
    // Auto-default to relevance ordering when a query is provided.
    const effectiveParams = { ...params };
    if (params.query && !params.orderBy) {
      effectiveParams.orderBy = 'relevance';
    }
    return callWorkerAPI('/api/search', effectiveParams);
  },
);

// ── Tool 2: timeline ────────────────────────────────────────────────────────
// Medium-detail chronological view around an anchor (~200-500 tokens).

server.tool(
  'timeline',
  'Show a chronological timeline of observations around an anchor point. ' +
    'Returns observations before and after the anchor with moderate detail, ' +
    'useful for understanding the sequence of events.',
  {
    anchor: z
      .number()
      .optional()
      .describe('Observation ID to center the timeline on (defaults to latest)'),
    query: z.string().optional().describe('Optional text filter'),
    depth_before: z
      .number()
      .optional()
      .default(3)
      .describe('Number of observations to show before the anchor'),
    depth_after: z
      .number()
      .optional()
      .default(3)
      .describe('Number of observations to show after the anchor'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async (params) => callWorkerAPI('/api/timeline', params),
);

// ── Tool 3: get_observations ────────────────────────────────────────────────
// Full-detail retrieval by ID (~500-1000 tokens per result).

server.tool(
  'get_observations',
  'Retrieve full observation details by ID. Returns complete text, metadata, ' +
    'and context for each requested observation. Use this after search/timeline ' +
    'to drill into specific items.',
  {
    ids: z.array(z.number()).describe('Array of observation IDs to retrieve'),
    orderBy: z.string().optional().describe('Sort order for results'),
    limit: z.number().optional().describe('Max results to return'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async (params) => callWorkerAPIPost('/api/observations/batch', params),
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info('Starting MCP server', { workerUrl: WORKER_BASE });

  // Verify the worker is reachable before we accept traffic.
  await verifyWorkerConnection();

  // Start the parent-process heartbeat to auto-exit on orphan.
  startParentHeartbeat();

  // Connect via stdio transport (JSON-RPC over stdin/stdout).
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('MCP server connected via stdio');
}

main().catch((err) => {
  log.error('MCP server failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
