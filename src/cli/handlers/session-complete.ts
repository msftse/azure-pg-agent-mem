/**
 * Hook handler: session-complete (Stop)
 *
 * Marks a session as completed by notifying the worker.
 */

import { readStdinJson } from '../stdin-reader.js';
import { resolveUserId, workerPost } from '../client.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Hook:SessionComplete');

// ---------------------------------------------------------------------------
// Stdin payload shape from Claude Code
// ---------------------------------------------------------------------------

interface SessionCompleteInput {
  session_id: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function handleSessionComplete(): Promise<void> {
  const t0 = Date.now();
  log.info('▶ Stop hook fired — marking session complete');

  try {
    const data = await readStdinJson<SessionCompleteInput>();
    const userId = resolveUserId();

    log.info('Completing session', { sessionId: data.session_id });

    await workerPost('/api/sessions/complete', {
      session_id: data.session_id,
      user_id: userId,
    });

    const elapsed = Date.now() - t0;
    log.info('✔ Session marked complete', { sessionId: data.session_id, elapsed_ms: elapsed });
  } catch (err) {
    const elapsed = Date.now() - t0;
    log.error('✘ Session-complete failed', {
      error: err instanceof Error ? err.message : String(err),
      elapsed_ms: elapsed,
    });
    process.exitCode = 1;
  }
}

// Direct execution – hook entry point.
handleSessionComplete();
