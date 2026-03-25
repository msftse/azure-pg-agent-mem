/**
 * Hook handler: observation (PostToolUse)
 *
 * Called after each tool execution. Reads tool data from stdin,
 * filters out trivial tools, and posts the observation to the worker.
 */

import path from 'node:path';
import { readStdinJson } from '../stdin-reader.js';
import { resolveUserId, workerPost } from '../client.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Hook:Observation');

// ---------------------------------------------------------------------------
// Stdin payload shape from Claude Code
// ---------------------------------------------------------------------------

interface ObservationInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
  session_id: string;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Trivial-tool filter
// ---------------------------------------------------------------------------

/** Tools whose output is too small / noisy to be worth persisting. */
const TRIVIAL_TOOLS = new Set(['ls', 'pwd']);

/**
 * Heuristic: consider `cat` (and Read-like tools) trivial when the
 * response is very short (small file reads / directory listings).
 */
const TRIVIAL_RESPONSE_THRESHOLD = 200; // characters

function isTrivial(input: ObservationInput): boolean {
  if (TRIVIAL_TOOLS.has(input.tool_name)) return true;

  // cat / Read for small files — not worth storing.
  if (
    input.tool_name === 'cat' ||
    input.tool_name === 'Read'
  ) {
    if (
      typeof input.tool_response === 'string' &&
      input.tool_response.length < TRIVIAL_RESPONSE_THRESHOLD
    ) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function handleObservation(): Promise<void> {
  const t0 = Date.now();
  log.info('▶ PostToolUse hook fired');

  try {
    const data = await readStdinJson<ObservationInput>();

    if (isTrivial(data)) {
      log.info('⊘ Skipping trivial tool', { tool: data.tool_name });
      return;
    }

    const userId = resolveUserId();
    const project = path.basename(data.cwd);

    log.info('Recording observation', {
      tool: data.tool_name,
      sessionId: data.session_id,
      responseLen: (data.tool_response || '').length,
    });

    await workerPost('/api/observations', {
      session_id: data.session_id,
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      user_id: userId,
      project,
    });

    const elapsed = Date.now() - t0;
    log.info('✔ Observation recorded', { tool: data.tool_name, elapsed_ms: elapsed });
  } catch (err) {
    const elapsed = Date.now() - t0;
    log.error('✘ Observation failed', {
      error: err instanceof Error ? err.message : String(err),
      elapsed_ms: elapsed,
    });
    process.exitCode = 1;
  }
}

// Direct execution – hook entry point.
handleObservation();
