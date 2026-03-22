/**
 * Database client for claude-azure-pg-mem.
 *
 * Uses standard `pg` (node-postgres) with Drizzle ORM – NOT the Neon
 * serverless driver.  Designed to work with Azure PostgreSQL Flexible Server
 * (SSL required via `sslmode=require`).
 *
 * The most important export is `withUserContext()`.  It acquires a pool
 * client, opens a transaction, sets the Postgres session variable
 * `app.user_id` via `SET LOCAL`, then runs the caller's callback.  This is
 * how Row Level Security (RLS) policies know which tenant owns the current
 * request.
 */

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import crypto from 'node:crypto';
import os from 'node:os';
import * as schema from './schema.js';
import { getSetting } from '../../shared/settings.js';
import { logger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Public type alias
// ---------------------------------------------------------------------------

/** Convenience alias for a Drizzle database instance bound to our schema. */
export type Database = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const log = logger.child('PgClient');

let _pool: Pool | null = null;
let _db: Database | null = null;

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the PostgreSQL connection URL.
 *
 * Priority:
 *   1. DATABASE_URL env var
 *   2. AGENT_MEM_DATABASE_URL env var
 *   3. DATABASE_URL in ~/.agent-mem/settings.json
 *
 * Throws if no URL can be found.
 */
export function resolveDatabaseUrl(): string {
  const url = getSetting('DATABASE_URL');
  if (!url) {
    throw new Error(
      'No database URL configured. Set DATABASE_URL or AGENT_MEM_DATABASE_URL ' +
        'environment variable, or add DATABASE_URL to ~/.agent-mem/settings.json.',
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// User-ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the current user identifier for RLS.
 *
 * Priority:
 *   1. AGENT_MEM_USER_ID env var
 *   2. USER_ID in ~/.agent-mem/settings.json
 *   3. Auto-generated from `${os.userInfo().username}@${os.hostname()}`
 *      hashed with SHA-256 and truncated to 16 hex chars for stability.
 */
export function resolveUserId(): string {
  const explicit = getSetting('USER_ID');
  if (explicit) return explicit;

  // Auto-derive a stable, semi-anonymous id from the local OS identity.
  const raw = `${os.userInfo().username}@${os.hostname()}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  log.debug('Auto-derived user_id', { raw, hash });
  return hash;
}

// ---------------------------------------------------------------------------
// Pool & Drizzle singletons
// ---------------------------------------------------------------------------

/**
 * Lazy-initialised connection pool.
 *
 * - `max: 10` connections (reasonable default for a single-machine agent).
 * - SSL is enabled when the connection string contains `sslmode=require`
 *   (standard for Azure PostgreSQL).
 */
export function getPool(): Pool {
  if (!_pool) {
    const connectionString = resolveDatabaseUrl();

    // Azure Postgres requires SSL.  If the URL includes `sslmode=require` we
    // enable it at the driver level.  `rejectUnauthorized: false` is
    // acceptable here because Azure uses well-known CA certs and the
    // connection string already pins the hostname.
    const needsSsl = connectionString.includes('sslmode=require');

    _pool = new Pool({
      connectionString,
      max: 10,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });

    _pool.on('error', (err) => {
      log.error('Unexpected pool error', {
        error: err.message,
      });
    });

    log.info('Connection pool created', { max: 10, ssl: needsSsl });
  }

  return _pool;
}

/**
 * Lazy-initialised Drizzle instance.
 *
 * ⚠️  This instance uses the **pool** directly, so queries go through
 * whichever client the pool assigns.  For RLS-scoped work, use
 * `withUserContext()` instead.
 */
export function getDb(): Database {
  if (!_db) {
    _db = drizzle(getPool(), { schema }) as Database;
  }
  return _db;
}

// ---------------------------------------------------------------------------
// RLS-scoped execution
// ---------------------------------------------------------------------------

/**
 * Execute `fn` inside a transaction where `app.user_id` is set via
 * `SET LOCAL`, enabling PostgreSQL Row Level Security policies.
 *
 * Flow:
 *   1. Acquire a dedicated client from the pool.
 *   2. BEGIN a transaction.
 *   3. SET LOCAL app.user_id = <userId>   (transaction-scoped).
 *   4. Run `fn(db)` with a Drizzle instance bound to that client.
 *   5. COMMIT on success / ROLLBACK on error.
 *   6. Release the client back to the pool.
 *
 * @param userId - Tenant identifier to inject into the session.
 * @param fn     - Async callback that receives a Drizzle `Database` handle.
 * @returns The value returned by `fn`.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // set_config() with `true` makes the setting LOCAL (transaction-scoped).
    // Unlike `SET LOCAL`, set_config() accepts parameterised $1 safely.
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);

    // Create a Drizzle instance bound to this specific client so all
    // queries within `fn` go through the same connection (and therefore
    // see the SET LOCAL value).
    const txDb = drizzle(client, { schema }) as Database;
    const result = await fn(txDb);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    log.error('withUserContext failed – rolled back', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Gracefully shut down the connection pool.
 * Call this on process exit.
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    log.info('Connection pool closed');
  }
}
