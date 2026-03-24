/**
 * Worker daemon service for claude-azure-pg-mem.
 *
 * An Express HTTP server that owns all business logic: database queries,
 * embedding generation, session management, and observation storage.
 * The MCP server (and CLI hooks) communicate with this process over HTTP.
 *
 * Lifecycle:
 *   - `WorkerService.start()`   – spawn as a background daemon
 *   - `WorkerService.stop()`    – send SIGTERM to the running daemon
 *   - `WorkerService.restart()` – stop + start
 *   - `WorkerService.status()`  – check if the daemon is alive
 *
 * RLS enforcement:
 *   Every data route **must** call `withUserContext()` before touching the DB.
 *   This issues `SET LOCAL app.user_id = …` inside a transaction so Postgres
 *   Row-Level Security policies scope all queries to the authenticated user.
 */

import express, { type Request, type Response } from 'express';
import { Pool, type PoolClient } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSetting, DATA_DIR } from '../shared/settings.js';
import { logger } from '../shared/logger.js';
import { createEmbedder, type EmbedFn, type EmbedderInfo } from './embeddings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log = logger.child('Worker');

/** PID file used to track the running daemon. */
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

/** Package version – injected at build or read from package.json at dev time. */
const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** Create a pg Pool from the configured DATABASE_URL. */
function createPool(): Pool {
  const databaseUrl = getSetting('DATABASE_URL');
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not configured. Set it via environment variable or ' +
        '~/.agent-mem/settings.json.',
    );
  }

  const needsSsl =
    databaseUrl.includes('sslmode=require') || databaseUrl.includes('.postgres.database.azure.com');

  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

/**
 * Execute a callback within a transaction that has `app.user_id` set for RLS.
 *
 * CRITICAL: Every data route **must** use this wrapper. Postgres RLS policies
 * rely on `current_setting('app.user_id')` to filter rows, so skipping this
 * would either leak data or return empty results.
 */
async function withUserContext<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET doesn't support $1 parameter placeholders, so we use set_config()
    // which is a regular function and accepts parameterised input safely.
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Embedding initialisation
// ---------------------------------------------------------------------------

// The embedding function and provider info are set by createEmbedder() from
// embeddings.ts, which reads the EMBEDDING_PROVIDER setting to decide between
// local Nomic, Azure OpenAI, or no-op. Captured here so the /api/health
// endpoint can report which provider is active.

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

function writePidFile(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  log.debug('PID file written', { path: PID_FILE, pid: process.pid });
}

function removePidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function readPidFile(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Check whether a given PID is still running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Express route helpers
// ---------------------------------------------------------------------------

/**
 * Extract `user_id` from request query or body params.
 * Returns null if not provided – callers must validate.
 */
function extractUserId(req: Request): string | null {
  const fromQuery = req.query.user_id;
  const fromBody = req.body?.user_id;
  const value = (fromQuery ?? fromBody) as string | undefined;
  return value && typeof value === 'string' ? value : null;
}

/**
 * Strip content wrapped in `<private>...</private>` tags before storage.
 * Supports multiline content and multiple occurrences.
 */
function stripPrivateTags(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, '').trim();
}

/**
 * Respond with a standardised JSON error.
 */
function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

// ---------------------------------------------------------------------------
// WorkerService class
// ---------------------------------------------------------------------------

export class WorkerService {
  // ── Instance (daemon) API ──────────────────────────────────────────────

  /**
   * Start the Express server, initialise the database pool, and write the
   * PID file. This method blocks until the server is shut down.
   */
  async startDaemon(): Promise<void> {
    const port = parseInt(getSetting('WORKER_PORT') || '37778', 10);
    const host = getSetting('WORKER_HOST') || '127.0.0.1';
    const startTime = Date.now();

    // ── Database ──────────────────────────────────────────────────────
    const pool = createPool();

    // Verify connectivity early so we fail fast on misconfiguration.
    try {
      const testClient = await pool.connect();
      testClient.release();
      log.info('Database connection verified');
    } catch (err) {
      log.error('Database connection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    // ── Embedder ─────────────────────────────────────────────────────
    const { embed, info: embedderInfo } = createEmbedder();
    log.info('Embedding provider initialised', { ...embedderInfo });

    // Nomic models require 'search_document:' / 'search_query:' prefixes
    // for best results. Other providers (Azure OpenAI) don't use them.
    const isNomic = embedderInfo.provider === 'nomic';
    const docPrefix = isNomic ? 'search_document: ' : '';
    const queryPrefix = isNomic ? 'search_query: ' : '';

    // ── Express app ──────────────────────────────────────────────────
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    // ── GET /api/health ──────────────────────────────────────────────
    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        version: VERSION,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        pid: process.pid,
        embedding: embedderInfo,
      });
    });

    // ── GET /api/search ──────────────────────────────────────────────
    // Searches observations using pgvector cosine similarity combined
    // with tsvector full-text search for hybrid retrieval.
    app.get('/api/search', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      try {
        const {
          query,
          project,
          type,
          obs_type,
          limit = '20',
          offset = '0',
          dateStart,
          dateEnd,
          orderBy: rawOrderBy,
        } = req.query as Record<string, string | undefined>;

        // Default to relevance-ranked results when a search query is present.
        const orderBy = rawOrderBy || (query ? 'relevance' : 'date_desc');

        const result = await withUserContext(pool, userId, async (client) => {
          // Build the WHERE clauses dynamically.
          const conditions: string[] = [];
          const values: unknown[] = [];
          let paramIdx = 1;

          if (project) {
            conditions.push(`project = $${paramIdx++}`);
            values.push(project);
          }
          if (type) {
            conditions.push(`type = $${paramIdx++}`);
            values.push(type);
          }
          if (obs_type && !type) {
            // obs_type is an alias for type used by the MCP tool.
            conditions.push(`type = $${paramIdx++}`);
            values.push(obs_type);
          }
          if (dateStart) {
            conditions.push(`created_at >= $${paramIdx++}`);
            values.push(dateStart);
          }
          if (dateEnd) {
            conditions.push(`created_at <= $${paramIdx++}`);
            values.push(dateEnd);
          }

          // Semantic search: compute embedding similarity if a query is provided.
          let semanticClause = '';
          let orderClause = 'ORDER BY created_at DESC';

          if (query) {
            const queryEmbedding = await embed(`${queryPrefix}${query}`);
            const embeddingLiteral = `'[${queryEmbedding.join(',')}]'::vector`;

            // Hybrid: combine cosine similarity score with tsvector rank.
            semanticClause = `,
              1 - (embedding <=> ${embeddingLiteral}) AS semantic_score,
              ts_rank_cd(COALESCE(search_vector, ''::tsvector), plainto_tsquery('english', $${paramIdx})) AS text_score`;
            values.push(query);
            paramIdx++;

            // Full-text filter: boost results that match the tsvector.
            conditions.push(
              `(search_vector @@ plainto_tsquery('english', $${paramIdx - 1}) ` +
                `OR 1 - (embedding <=> ${embeddingLiteral}) > 0.3)`,
            );

            if (orderBy === 'relevance') {
              // Use the computed expressions directly since aliases
              // may not be visible in ORDER BY on all PG versions.
              orderClause = `ORDER BY (
                (1 - (embedding <=> ${embeddingLiteral})) * 0.7 +
                ts_rank_cd(COALESCE(search_vector, ''::tsvector), plainto_tsquery('english', $${paramIdx - 1})) * 0.3
              ) DESC`;
            }
          }

          if (orderBy === 'date_asc') orderClause = 'ORDER BY created_at ASC';

          const whereSQL = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

          const sql = `
            SELECT id, type, project, title,
                   LEFT(text, 200) AS content_preview,
                   created_at ${semanticClause}
            FROM cpm_observations
            ${whereSQL}
            ${orderClause}
            LIMIT $${paramIdx++} OFFSET $${paramIdx++}
          `;

          values.push(parseInt(limit ?? '20', 10), parseInt(offset ?? '0', 10));

          return client.query(sql, values);
        });

        res.json(result.rows);
      } catch (err) {
        log.error('Search failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'Search failed');
      }
    });

    // ── GET /api/timeline ────────────────────────────────────────────
    // Returns chronological observations around an anchor observation ID.
    app.get('/api/timeline', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      try {
        const {
          anchor,
          query,
          depth_before = '3',
          depth_after = '3',
          project,
        } = req.query as Record<string, string | undefined>;

        const result = await withUserContext(pool, userId, async (client) => {
          const before = parseInt(depth_before ?? '3', 10);
          const after = parseInt(depth_after ?? '3', 10);
          const values: unknown[] = [];
          let paramIdx = 1;

          let projectFilter = '';
          if (project) {
            projectFilter = `AND project = $${paramIdx++}`;
            values.push(project);
          }

          let queryFilter = '';
          if (query) {
            queryFilter = `AND search_vector @@ plainto_tsquery('english', $${paramIdx++})`;
            values.push(query);
          }

          if (anchor) {
            // Fetch rows before and after the anchor ID in chronological order.
            const anchorId = parseInt(anchor, 10);
            values.push(anchorId, before, anchorId, after);

            const sql = `
              (
                SELECT id, type, project, title, LEFT(text, 300) AS text_preview, created_at
                FROM cpm_observations
                WHERE id < $${paramIdx++} ${projectFilter} ${queryFilter}
                ORDER BY id DESC
                LIMIT $${paramIdx++}
              )
              UNION ALL
              (
                SELECT id, type, project, title, LEFT(text, 300) AS text_preview, created_at
                FROM cpm_observations
                WHERE id >= $${paramIdx++} ${projectFilter} ${queryFilter}
                ORDER BY id ASC
                LIMIT $${paramIdx++}
              )
              ORDER BY created_at ASC
            `;

            return client.query(sql, values);
          } else {
            // No anchor – return the most recent observations.
            const total = before + after + 1;
            values.push(total);

            const sql = `
              SELECT id, type, project, title, LEFT(text, 300) AS text_preview, created_at
              FROM cpm_observations
              WHERE true ${projectFilter} ${queryFilter}
              ORDER BY created_at DESC
              LIMIT $${paramIdx++}
            `;

            return client.query(sql, values);
          }
        });

        res.json(result.rows);
      } catch (err) {
        log.error('Timeline failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'Timeline query failed');
      }
    });

    // ── POST /api/observations/batch ─────────────────────────────────
    // Returns full observation details for an array of IDs.
    app.post('/api/observations/batch', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      const { ids, orderBy, limit: rawLimit, project } = req.body as {
        ids?: number[];
        orderBy?: string;
        limit?: number;
        project?: string;
      };

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return sendError(res, 400, 'ids array is required and must not be empty');
      }

      try {
        const result = await withUserContext(pool, userId, async (client) => {
          const values: unknown[] = [ids];
          let paramIdx = 2;

          let projectFilter = '';
          if (project) {
            projectFilter = `AND project = $${paramIdx++}`;
            values.push(project);
          }

          let orderClause = 'ORDER BY created_at DESC';
          if (orderBy === 'date_asc') orderClause = 'ORDER BY created_at ASC';
          if (orderBy === 'id') orderClause = 'ORDER BY id ASC';

          let limitClause = '';
          if (rawLimit && rawLimit > 0) {
            limitClause = `LIMIT $${paramIdx++}`;
            values.push(rawLimit);
          }

          const sql = `
            SELECT id, type, project, title, text, narrative,
                   memory_session_id, created_at
            FROM cpm_observations
            WHERE id = ANY($1) ${projectFilter}
            ${orderClause}
            ${limitClause}
          `;

          return client.query(sql, values);
        });

        res.json(result.rows);
      } catch (err) {
        log.error('Batch get failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'Batch get failed');
      }
    });

    // ── POST /api/sessions/init ──────────────────────────────────────
    // Create or resume a session.
    // Uses cpm_sessions for lightweight session tracking and
    // cpm_sdk_sessions for full SDK session lifecycle.
    app.post('/api/sessions/init', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      const { project, session_id, metadata, user_prompt, source } = req.body as {
        project?: string;
        session_id?: string;
        metadata?: Record<string, unknown>;
        user_prompt?: string;
        source?: string;
      };

      if (!session_id) return sendError(res, 400, 'session_id is required');
      if (!project) return sendError(res, 400, 'project is required');

      try {
        const result = await withUserContext(pool, userId, async (client) => {
          // Check if this session already exists in cpm_sdk_sessions.
          const existing = await client.query(
            'SELECT * FROM cpm_sdk_sessions WHERE content_session_id = $1',
            [session_id],
          );
          if (existing.rows.length > 0) {
            // Bump prompt counter on resume.
            await client.query(
              'UPDATE cpm_sdk_sessions SET prompt_counter = prompt_counter + 1 WHERE content_session_id = $1',
              [session_id],
            );
            return existing.rows[0];
          }

          const now = new Date();
          const nowISO = now.toISOString();
          const nowEpoch = Math.floor(now.getTime() / 1000);
          const memorySessionId = `mem_${session_id}`;

          // Insert into cpm_sessions (lightweight tracking).
          await client.query(
            `INSERT INTO cpm_sessions (session_id, project, user_id, created_at, created_at_epoch, source, metadata_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (session_id) DO NOTHING`,
            [session_id, project, userId, nowISO, nowEpoch, source || 'cli', metadata ? JSON.stringify(metadata) : null],
          );

          // Insert into cpm_sdk_sessions (full lifecycle).
          const insertResult = await client.query(
            `INSERT INTO cpm_sdk_sessions
               (content_session_id, memory_session_id, project, user_id, user_prompt,
                started_at, started_at_epoch, status, prompt_counter)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1)
             RETURNING *`,
            [session_id, memorySessionId, project, userId, user_prompt || null, nowISO, nowEpoch],
          );
          return insertResult.rows[0];
        });

        res.json(result);
      } catch (err) {
        log.error('Session init failed', { error: err instanceof Error ? err.message : String(err) });
        sendError(res, 500, 'Session init failed');
      }
    });

    // ── POST /api/sessions/complete ──────────────────────────────────
    // Mark a session as completed (uses cpm_sdk_sessions which has lifecycle columns).
    app.post('/api/sessions/complete', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      const { session_id } = req.body as { session_id?: string };
      if (!session_id) return sendError(res, 400, 'session_id is required');

      try {
        await withUserContext(pool, userId, async (client) => {
          const now = new Date();
          const nowISO = now.toISOString();
          const nowEpoch = Math.floor(now.getTime() / 1000);

          await client.query(
            `UPDATE cpm_sdk_sessions
             SET status = 'completed', completed_at = $2, completed_at_epoch = $3
             WHERE content_session_id = $1`,
            [session_id, nowISO, nowEpoch],
          );
        });

        res.json({ status: 'completed', session_id });
      } catch (err) {
        log.error('Session complete failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        sendError(res, 500, 'Session complete failed');
      }
    });

    // ── POST /api/observations ───────────────────────────────────────
    // Store a new observation with embedding generation.
    app.post('/api/observations', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      const {
        session_id,
        tool_name,
        tool_input,
        tool_response,
        project,
        type,
        title,
        subtitle,
        text: rawText,
        narrative,
        facts,
        concepts,
        files_read,
        files_modified,
        prompt_number,
      } = req.body as {
        session_id?: string;
        tool_name?: string;
        tool_input?: Record<string, unknown>;
        tool_response?: string;
        project?: string;
        type?: string;
        title?: string;
        subtitle?: string;
        text?: string;
        narrative?: string;
        facts?: string[] | string;
        concepts?: string[] | string;
        files_read?: string[] | string;
        files_modified?: string[] | string;
        prompt_number?: number;
      };

      // Build observation text from either raw text or tool data.
      let observationText: string;
      let observationTitle = title || null;
      let observationType = type || 'tool_use';

      if (rawText) {
        observationText = stripPrivateTags(rawText);
      } else if (tool_name && tool_response) {
        // Construct text from tool call data.
        const inputStr = tool_input ? JSON.stringify(tool_input, null, 2) : '';
        const respPreview = tool_response.length > 2000
          ? tool_response.slice(0, 2000) + '…'
          : tool_response;
        observationText = stripPrivateTags(
          `Tool: ${tool_name}\nInput: ${inputStr}\nOutput: ${respPreview}`,
        );
        observationTitle = observationTitle || `${tool_name} call`;
        observationType = 'tool_use';
      } else {
        return sendError(res, 400, 'Either text or tool_name+tool_response is required');
      }

      if (!project) return sendError(res, 400, 'project is required');

      try {
        // Generate the embedding for the observation text.
        const textToEmbed = [observationTitle, observationText].filter(Boolean).join(' – ');
        const embedding = await embed(`${docPrefix}${textToEmbed}`);

        const now = new Date();
        const nowISO = now.toISOString();
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const memorySessionId = session_id ? `mem_${session_id}` : `mem_${Date.now()}`;

        // Compute content hash for deduplication.
        const { createHash } = await import('node:crypto');
        const contentHash = createHash('sha256').update(observationText).digest('hex');

        // Serialise array fields to JSON strings.
        const toJsonStr = (v: string[] | string | undefined): string | null => {
          if (!v) return null;
          if (typeof v === 'string') return v;
          return JSON.stringify(v);
        };

        const result = await withUserContext(pool, userId, async (client) => {
          // Deduplication: check if an observation with the same content_hash
          // already exists for this user to avoid storing duplicates.
          const existing = await client.query(
            'SELECT id, type, project, title, created_at FROM cpm_observations WHERE content_hash = $1 AND user_id = $2 LIMIT 1',
            [contentHash, userId],
          );
          if (existing.rows.length > 0) {
            log.debug('Duplicate observation skipped', { contentHash, existingId: existing.rows[0].id });
            return existing;
          }

          const sql = `
            INSERT INTO cpm_observations
              (memory_session_id, project, user_id, text, type, title, subtitle,
               facts, narrative, concepts, files_read, files_modified,
               prompt_number, content_hash, created_at, created_at_epoch,
               embedding, search_vector)
            VALUES ($1, $2, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, $12,
                    $13, $14, $15, $16,
                    $17::vector, to_tsvector('english', $18))
            RETURNING id, type, project, title, created_at
          `;
          return client.query(sql, [
            memorySessionId,
            project,
            userId,
            observationText,
            observationType,
            observationTitle,
            subtitle || null,
            toJsonStr(facts),
            narrative || null,
            toJsonStr(concepts),
            toJsonStr(files_read),
            toJsonStr(files_modified),
            prompt_number ?? null,
            contentHash,
            nowISO,
            nowEpoch,
            `[${embedding.join(',')}]`,
            [observationTitle, observationText].filter(Boolean).join(' '),
          ]);
        });

        res.status(201).json(result.rows[0]);
      } catch (err) {
        log.error('Store observation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        sendError(res, 500, 'Store observation failed');
      }
    });

    // ── POST /api/summaries ──────────────────────────────────────────
    // Store a session summary with structured fields.
    app.post('/api/summaries', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      const {
        session_id,
        project,
        summary,
        request,
        investigated,
        learned,
        completed,
        next_steps,
        files_read,
        files_edited,
        notes,
        prompt_number,
      } = req.body as {
        session_id?: string;
        project?: string;
        summary?: string;
        request?: string;
        investigated?: string;
        learned?: string;
        completed?: string;
        next_steps?: string;
        files_read?: string[] | string;
        files_edited?: string[] | string;
        notes?: string;
        prompt_number?: number;
      };

      if (!session_id) return sendError(res, 400, 'session_id is required');

      // If a flat 'summary' string is provided (from older handlers), parse or
      // store it in the 'notes' field.
      const effectiveNotes = notes || summary || null;

      try {
        // Build text for embedding from all structured fields.
        const embeddingParts = [request, investigated, learned, completed, next_steps, effectiveNotes]
          .filter(Boolean);
        const embeddingText = embeddingParts.length > 0
          ? embeddingParts.join(' ')
          : 'session summary';
        const embedding = await embed(`${docPrefix}${embeddingText}`);

        const now = new Date();
        const nowISO = now.toISOString();
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const memorySessionId = `mem_${session_id}`;

        const toJsonStr = (v: string[] | string | undefined): string | null => {
          if (!v) return null;
          if (typeof v === 'string') return v;
          return JSON.stringify(v);
        };

        const result = await withUserContext(pool, userId, async (client) => {
          // Look up the project from the sdk session if not provided.
          let effectiveProject = project;
          if (!effectiveProject) {
            const sess = await client.query(
              'SELECT project FROM cpm_sdk_sessions WHERE content_session_id = $1',
              [session_id],
            );
            effectiveProject = sess.rows[0]?.project || 'unknown';
          }

          const sql = `
            INSERT INTO cpm_session_summaries
              (memory_session_id, project, user_id, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, created_at, created_at_epoch,
               embedding, search_vector)
            VALUES ($1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11,
                    $12, $13, $14,
                    $15::vector, to_tsvector('english', $16))
            RETURNING id, memory_session_id, project, created_at
          `;
          return client.query(sql, [
            memorySessionId,
            effectiveProject,
            userId,
            request || null,
            investigated || null,
            learned || null,
            completed || null,
            next_steps || null,
            toJsonStr(files_read),
            toJsonStr(files_edited),
            effectiveNotes,
            prompt_number ?? null,
            nowISO,
            nowEpoch,
            `[${embedding.join(',')}]`,
            embeddingText,
          ]);
        });

        res.status(201).json(result.rows[0]);
      } catch (err) {
        log.error('Store summary failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        sendError(res, 500, 'Store summary failed');
      }
    });

    // ── POST /api/context ────────────────────────────────────────────
    // Return recent observations for context injection into agent prompts.
    app.post('/api/context', async (req: Request, res: Response) => {
      const userId = extractUserId(req);
      if (!userId) return sendError(res, 400, 'user_id is required');

      const { project, limit: rawLimit } = req.body as {
        project?: string;
        limit?: number;
      };

      const maxObs = rawLimit || parseInt(getSetting('CONTEXT_OBSERVATIONS') || '50', 10);

      try {
        const result = await withUserContext(pool, userId, async (client) => {
          const values: unknown[] = [];
          let paramIdx = 1;

          let projectFilter = '';
          if (project) {
            projectFilter = `AND project = $${paramIdx++}`;
            values.push(project);
          }

          values.push(maxObs);

          const sql = `
            SELECT id, type, project, title, LEFT(text, 300) AS text_preview, created_at
            FROM cpm_observations
            WHERE true ${projectFilter}
            ORDER BY created_at DESC
            LIMIT $${paramIdx++}
          `;

          return client.query(sql, values);
        });

        res.json(result.rows);
      } catch (err) {
        log.error('Context fetch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        sendError(res, 500, 'Context fetch failed');
      }
    });

    // ── POST /shutdown ───────────────────────────────────────────────
    // Graceful shutdown – allows the CLI to stop the daemon remotely.
    app.post('/shutdown', (_req: Request, res: Response) => {
      log.info('Shutdown requested via HTTP');
      res.json({ status: 'shutting_down' });

      // Give the response time to flush before terminating.
      setTimeout(async () => {
        await pool.end();
        removePidFile();
        process.exit(0);
      }, 500);
    });

    // ── Start listening ──────────────────────────────────────────────
    const httpServer = app.listen(port, host, () => {
      writePidFile();
      log.info('Worker daemon started', { host, port, pid: process.pid });
    });

    // ── Graceful shutdown on signals ─────────────────────────────────
    const shutdown = async (signal: string) => {
      log.info('Received signal, shutting down…', { signal });
      httpServer.close();
      await pool.end();
      removePidFile();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }

  // ── Static management API ──────────────────────────────────────────────

  /**
   * Start the worker daemon as a background process.
   * If a daemon is already running, this is a no-op.
   */
  static async start(): Promise<void> {
    const existing = WorkerService.status();
    if (existing.running) {
      log.info('Worker daemon already running', { pid: existing.pid });
      return;
    }

    // Remove stale PID file if the process is no longer alive.
    removePidFile();

    // In "start" mode we run in the foreground (the CLI can daemonise via
    // spawn with detached + stdio 'ignore'). This keeps the implementation
    // simple and testable.
    const worker = new WorkerService();
    await worker.startDaemon();
  }

  /**
   * Stop the running worker daemon by sending SIGTERM.
   */
  static stop(): void {
    const pid = readPidFile();
    if (pid === null) {
      log.info('No PID file found – worker is not running');
      return;
    }

    if (!isProcessAlive(pid)) {
      log.info('Stale PID file – process already exited', { pid });
      removePidFile();
      return;
    }

    log.info('Stopping worker daemon', { pid });
    process.kill(pid, 'SIGTERM');
    removePidFile();
  }

  /**
   * Restart the worker daemon (stop then start).
   */
  static async restart(): Promise<void> {
    WorkerService.stop();
    // Brief pause to let the port free up.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await WorkerService.start();
  }

  /**
   * Check whether the worker daemon is currently running.
   */
  static status(): { running: boolean; pid: number | null } {
    const pid = readPidFile();
    if (pid === null) return { running: false, pid: null };
    const alive = isProcessAlive(pid);
    if (!alive) {
      removePidFile();
      return { running: false, pid: null };
    }
    return { running: true, pid };
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
// The package.json "worker:start" script runs this file directly with an
// argument: `tsx src/services/worker-service.ts start`

const cliCommand = process.argv[2];
if (cliCommand === 'start') {
  WorkerService.start().catch((err) => {
    log.error('Worker start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
} else if (cliCommand === 'stop') {
  WorkerService.stop();
} else if (cliCommand === 'restart') {
  WorkerService.restart().catch((err) => {
    log.error('Worker restart failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
} else if (cliCommand === 'status') {
  const s = WorkerService.status();
  if (s.running) {
    log.info('Worker is running', { pid: s.pid });
  } else {
    log.info('Worker is not running');
  }
}
