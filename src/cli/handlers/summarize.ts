/**
 * Hook handler: summarize (Stop)
 *
 * Generates a session summary and posts it to the worker.
 * Called when the coding session ends.
 */

import { readStdinJson } from '../stdin-reader.js';
import { resolveUserId, workerPost } from '../client.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Hook:Summarize');

// ---------------------------------------------------------------------------
// Stdin payload shape from Claude Code
// ---------------------------------------------------------------------------

interface SummarizeInput {
  session_id: string;
  cwd: string;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function handleSummarize(): Promise<void> {
  try {
    const data = await readStdinJson<SummarizeInput>();
    const userId = resolveUserId();

    log.debug('Posting session summary', { sessionId: data.session_id });

    await workerPost('/api/summaries', {
      session_id: data.session_id,
      user_id: userId,
      summary: data.summary ?? '',
      cwd: data.cwd,
    });

    log.debug('Summary posted');
  } catch (err) {
    log.error('summarize failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}

// Direct execution – hook entry point.
handleSummarize();
