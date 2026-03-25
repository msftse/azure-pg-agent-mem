/**
 * Hook handler: session-init (UserPromptSubmit)
 *
 * Called when the user submits a prompt. Reads hook data from stdin
 * and registers / updates the session with the worker.
 */

import path from 'node:path';
import { readStdinJson } from '../stdin-reader.js';
import { resolveUserId, workerPost } from '../client.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Hook:SessionInit');

// ---------------------------------------------------------------------------
// Stdin payload shape from Claude Code
// ---------------------------------------------------------------------------

interface SessionInitInput {
  session_id: string;
  cwd: string;
  user_message: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function handleSessionInit(): Promise<void> {
  const t0 = Date.now();
  log.info('▶ UserPromptSubmit hook fired — initialising session');

  try {
    const data = await readStdinJson<SessionInitInput>();
    const userId = resolveUserId();
    const project = path.basename(data.cwd);

    log.info('Registering session', {
      sessionId: data.session_id,
      project,
      promptPreview: (data.user_message || '').slice(0, 80),
    });

    await workerPost('/api/sessions/init', {
      session_id: data.session_id,
      project,
      user_id: userId,
      user_prompt: data.user_message,
    });

    const elapsed = Date.now() - t0;
    log.info('✔ Session initialised', { sessionId: data.session_id, elapsed_ms: elapsed });
  } catch (err) {
    const elapsed = Date.now() - t0;
    log.error('✘ Session-init failed', {
      error: err instanceof Error ? err.message : String(err),
      elapsed_ms: elapsed,
    });
    process.exitCode = 1;
  }
}

// Direct execution – hook entry point.
handleSessionInit();
