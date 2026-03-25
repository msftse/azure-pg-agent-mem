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
  const t0 = Date.now();
  log.info('▶ Stop hook fired — posting session summary');

  try {
    const data = await readStdinJson<SummarizeInput>();
    const userId = resolveUserId();

    log.info('Posting summary', {
      sessionId: data.session_id,
      summaryLen: (data.summary ?? '').length,
    });

    await workerPost('/api/summaries', {
      session_id: data.session_id,
      user_id: userId,
      summary: data.summary ?? '',
      cwd: data.cwd,
    });

    const elapsed = Date.now() - t0;
    log.info('✔ Summary posted', { sessionId: data.session_id, elapsed_ms: elapsed });
  } catch (err) {
    const elapsed = Date.now() - t0;
    log.error('✘ Summarize failed', {
      error: err instanceof Error ? err.message : String(err),
      elapsed_ms: elapsed,
    });
    process.exitCode = 1;
  }
}

// Direct execution – hook entry point.
handleSummarize();
