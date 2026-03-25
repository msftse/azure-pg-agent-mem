/**
 * Hook handler: context (SessionStart)
 *
 * Fetches recent memory from the worker and writes a markdown-formatted
 * timeline to stdout so Claude Code can inject it into the session.
 */

import { resolveUserId, workerPost } from '../client.js';
import { getSetting } from '../../shared/settings.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Hook:Context');

// ---------------------------------------------------------------------------
// Response shape from the worker
// ---------------------------------------------------------------------------

/** Matches the rows returned by the worker's POST /api/context endpoint. */
interface ContextObservation {
  id: number;
  type?: string;
  project?: string;
  title?: string;
  text_preview?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

function formatTimeline(observations: ContextObservation[]): string {
  if (observations.length === 0) {
    return '<!-- agent-mem: no prior observations -->\n';
  }

  const lines: string[] = [
    '## Recent Memory (auto-injected by agent-mem)',
    '',
  ];

  for (const obs of observations) {
    const ts = new Date(obs.created_at).toISOString().replace('T', ' ').slice(0, 19);
    const label = obs.title ?? obs.type ?? 'observation';
    const preview = obs.text_preview ? ` — ${obs.text_preview}` : '';
    const proj = obs.project ? ` [${obs.project}]` : '';
    lines.push(`- **${ts}**${proj} \`${label}\`${preview}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function handleContext(): Promise<void> {
  const t0 = Date.now();
  log.info('▶ SessionStart hook fired — fetching prior context');

  try {
    const userId = resolveUserId();
    const limit = getSetting('CONTEXT_OBSERVATIONS');

    log.info('Requesting context', { userId, limit });

    // Worker POST /api/context returns a flat array of observation rows.
    const data = await workerPost<ContextObservation[]>('/api/context', {
      user_id: userId,
      limit: parseInt(limit || '50', 10),
    });

    const observations = Array.isArray(data) ? data : [];
    const md = formatTimeline(observations);

    // Write to stdout – Claude Code captures this as injected context.
    process.stdout.write(md);

    const elapsed = Date.now() - t0;
    log.info('✔ Context injected', { count: observations.length, elapsed_ms: elapsed });
  } catch (err) {
    const elapsed = Date.now() - t0;
    // Context injection is best-effort; failing silently is acceptable.
    log.warn('✘ Context fetch failed', {
      error: err instanceof Error ? err.message : String(err),
      elapsed_ms: elapsed,
    });
  }
}

// Direct execution – hook entry point.
handleContext();
