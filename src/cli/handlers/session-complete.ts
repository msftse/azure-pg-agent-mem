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
  try {
    const data = await readStdinJson<SessionCompleteInput>();
    const userId = resolveUserId();

    log.debug('Marking session complete', { sessionId: data.session_id });

    await workerPost('/api/sessions/complete', {
      session_id: data.session_id,
      user_id: userId,
    });

    log.debug('Session marked complete');
  } catch (err) {
    log.error('session-complete failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}

// Direct execution – hook entry point.
handleSessionComplete();
