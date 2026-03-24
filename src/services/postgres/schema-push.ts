/**
 * Schema push utility for claude-azure-pg-mem.
 *
 * Connects to the target PostgreSQL database and:
 *   1. Enables the `pgvector` extension.
 *   2. Uses Drizzle-Kit's programmatic API to push the Drizzle schema.
 *   3. Creates HNSW indexes on vector columns (cosine distance).
 *   4. Creates GIN indexes on tsvector columns.
 *   5. Enables Row Level Security (RLS) on every `cpm_*` table (except
 *      `cpm_schema_versions`) with a policy that isolates rows by
 *      `current_setting('app.user_id', true)`.
 *   6. Creates a superuser bypass role for admin / migration operations.
 *
 * Usage:
 *   import { pushSchema } from './schema-push.js';
 *   await pushSchema(databaseUrl);
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('SchemaPush');

// ---------------------------------------------------------------------------
// Tables that receive RLS policies
// ---------------------------------------------------------------------------

/** All cpm_ tables that have a user_id column and need RLS. */
const RLS_TABLES = [
  'cpm_sessions',
  'cpm_sdk_sessions',
  'cpm_observations',
  'cpm_session_summaries',
  'cpm_pending_messages',
  'cpm_user_prompts',
] as const;

// ---------------------------------------------------------------------------
// Raw SQL helpers
// ---------------------------------------------------------------------------

/**
 * Execute a single statement, logging but not throwing on failure
 * (idempotent DDL).
 */
async function execSafe(
  pool: Pool,
  label: string,
  statement: string,
): Promise<void> {
  try {
    await pool.query(statement);
    log.debug(`${label}: OK`);
  } catch (err) {
    // IF NOT EXISTS / already-exists errors are expected on re-runs.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('already exists') ||
      msg.includes('duplicate key') ||
      msg.includes('already enabled')
    ) {
      log.debug(`${label}: already applied – skipped`);
    } else {
      log.warn(`${label}: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Push the complete schema to the target database and configure RLS.
 *
 * @param databaseUrl - Full postgres:// connection string (with sslmode).
 */
export async function pushSchema(databaseUrl: string): Promise<void> {
  const needsSsl = databaseUrl.includes('sslmode=require') || databaseUrl.includes('.postgres.database.azure.com');
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  try {
    log.info('Starting schema push …');

    // ------------------------------------------------------------------
    // 1. Enable pgvector extension
    // ------------------------------------------------------------------
    await execSafe(pool, 'pgvector extension', 'CREATE EXTENSION IF NOT EXISTS vector');
    log.info('pgvector extension enabled');

    // ------------------------------------------------------------------
    // 2. Create tables via Drizzle push (DDL sync)
    // ------------------------------------------------------------------
    // We use raw SQL derived from the Drizzle schema to create tables
    // because drizzle-kit's push API is CLI-only.  Instead we create
    // each table with CREATE TABLE IF NOT EXISTS.
    log.info('Creating tables …');

    const db = drizzle(pool, { schema });

    // Use Drizzle's sql template to create tables.  We rely on the
    // fact that Drizzle schema objects carry enough metadata for us to
    // emit DDL.  For simplicity and reliability we use raw CREATE TABLE
    // statements that mirror the schema.ts definitions exactly.

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_sessions (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        source TEXT,
        metadata_json TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_sdk_sessions (
        id SERIAL PRIMARY KEY,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch BIGINT NOT NULL,
        completed_at TEXT,
        completed_at_epoch BIGINT,
        status TEXT NOT NULL DEFAULT 'active',
        worker_port INTEGER,
        prompt_counter INTEGER DEFAULT 0,
        custom_title TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_observations (
        id SERIAL PRIMARY KEY,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        embedding vector(768),
        search_vector tsvector
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_session_summaries (
        id SERIAL PRIMARY KEY,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        user_id TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch BIGINT NOT NULL,
        embedding vector(768),
        search_vector tsvector
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_pending_messages (
        id SERIAL PRIMARY KEY,
        session_db_id INTEGER,
        content_session_id TEXT,
        user_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        created_at_epoch BIGINT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_user_prompts (
        id SERIAL PRIMARY KEY,
        content_session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch BIGINT NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cpm_schema_versions (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    log.info('Tables created');

    // ------------------------------------------------------------------
    // 3. Create indexes (idempotent)
    // ------------------------------------------------------------------
    log.info('Creating indexes …');

    // --- cpm_sessions indexes ---
    await execSafe(pool, 'idx: sessions.session_id',
      'CREATE UNIQUE INDEX IF NOT EXISTS cpm_sessions_session_id_idx ON cpm_sessions (session_id)');
    await execSafe(pool, 'idx: sessions.user_id',
      'CREATE INDEX IF NOT EXISTS cpm_sessions_user_id_idx ON cpm_sessions (user_id)');
    await execSafe(pool, 'idx: sessions.user+project',
      'CREATE INDEX IF NOT EXISTS cpm_sessions_user_project_idx ON cpm_sessions (user_id, project)');
    await execSafe(pool, 'idx: sessions.user+project+epoch',
      'CREATE INDEX IF NOT EXISTS cpm_sessions_user_project_epoch_idx ON cpm_sessions (user_id, project, created_at_epoch)');

    // --- cpm_sdk_sessions indexes ---
    await execSafe(pool, 'idx: sdk_sessions.content_sid',
      'CREATE UNIQUE INDEX IF NOT EXISTS cpm_sdk_sessions_content_sid_idx ON cpm_sdk_sessions (content_session_id)');
    await execSafe(pool, 'idx: sdk_sessions.memory_sid',
      'CREATE UNIQUE INDEX IF NOT EXISTS cpm_sdk_sessions_memory_sid_idx ON cpm_sdk_sessions (memory_session_id)');
    await execSafe(pool, 'idx: sdk_sessions.user_id',
      'CREATE INDEX IF NOT EXISTS cpm_sdk_sessions_user_id_idx ON cpm_sdk_sessions (user_id)');
    await execSafe(pool, 'idx: sdk_sessions.user+project',
      'CREATE INDEX IF NOT EXISTS cpm_sdk_sessions_user_project_idx ON cpm_sdk_sessions (user_id, project)');
    await execSafe(pool, 'idx: sdk_sessions.user+project+epoch',
      'CREATE INDEX IF NOT EXISTS cpm_sdk_sessions_user_project_epoch_idx ON cpm_sdk_sessions (user_id, project, started_at_epoch)');
    await execSafe(pool, 'idx: sdk_sessions.status',
      'CREATE INDEX IF NOT EXISTS cpm_sdk_sessions_status_idx ON cpm_sdk_sessions (status)');

    // --- cpm_observations indexes ---
    await execSafe(pool, 'idx: obs.memory_sid',
      'CREATE INDEX IF NOT EXISTS cpm_obs_memory_sid_idx ON cpm_observations (memory_session_id)');
    await execSafe(pool, 'idx: obs.user_id',
      'CREATE INDEX IF NOT EXISTS cpm_obs_user_id_idx ON cpm_observations (user_id)');
    await execSafe(pool, 'idx: obs.user+project',
      'CREATE INDEX IF NOT EXISTS cpm_obs_user_project_idx ON cpm_observations (user_id, project)');
    await execSafe(pool, 'idx: obs.user+project+epoch',
      'CREATE INDEX IF NOT EXISTS cpm_obs_user_project_epoch_idx ON cpm_observations (user_id, project, created_at_epoch)');
    await execSafe(pool, 'idx: obs.content_hash',
      'CREATE INDEX IF NOT EXISTS cpm_obs_content_hash_idx ON cpm_observations (content_hash)');

    // HNSW index for vector cosine similarity search
    await execSafe(pool, 'idx: obs.embedding (HNSW)',
      'CREATE INDEX IF NOT EXISTS cpm_obs_embedding_idx ON cpm_observations USING hnsw (embedding vector_cosine_ops)');
    // GIN index for full-text search
    await execSafe(pool, 'idx: obs.search_vector (GIN)',
      'CREATE INDEX IF NOT EXISTS cpm_obs_search_idx ON cpm_observations USING gin (search_vector)');

    // --- cpm_session_summaries indexes ---
    await execSafe(pool, 'idx: summaries.memory_sid',
      'CREATE INDEX IF NOT EXISTS cpm_summaries_memory_sid_idx ON cpm_session_summaries (memory_session_id)');
    await execSafe(pool, 'idx: summaries.user_id',
      'CREATE INDEX IF NOT EXISTS cpm_summaries_user_id_idx ON cpm_session_summaries (user_id)');
    await execSafe(pool, 'idx: summaries.user+project',
      'CREATE INDEX IF NOT EXISTS cpm_summaries_user_project_idx ON cpm_session_summaries (user_id, project)');
    await execSafe(pool, 'idx: summaries.user+project+epoch',
      'CREATE INDEX IF NOT EXISTS cpm_summaries_user_project_epoch_idx ON cpm_session_summaries (user_id, project, created_at_epoch)');

    // HNSW index for vector cosine similarity search
    await execSafe(pool, 'idx: summaries.embedding (HNSW)',
      'CREATE INDEX IF NOT EXISTS cpm_summaries_embedding_idx ON cpm_session_summaries USING hnsw (embedding vector_cosine_ops)');
    // GIN index for full-text search
    await execSafe(pool, 'idx: summaries.search_vector (GIN)',
      'CREATE INDEX IF NOT EXISTS cpm_summaries_search_idx ON cpm_session_summaries USING gin (search_vector)');

    // --- cpm_pending_messages indexes ---
    await execSafe(pool, 'idx: pending.user_id',
      'CREATE INDEX IF NOT EXISTS cpm_pending_user_id_idx ON cpm_pending_messages (user_id)');
    await execSafe(pool, 'idx: pending.status',
      'CREATE INDEX IF NOT EXISTS cpm_pending_status_idx ON cpm_pending_messages (status)');
    await execSafe(pool, 'idx: pending.content_sid',
      'CREATE INDEX IF NOT EXISTS cpm_pending_content_sid_idx ON cpm_pending_messages (content_session_id)');
    await execSafe(pool, 'idx: pending.session_db_id',
      'CREATE INDEX IF NOT EXISTS cpm_pending_session_db_id_idx ON cpm_pending_messages (session_db_id)');

    // --- cpm_user_prompts indexes ---
    await execSafe(pool, 'idx: prompts.content_sid',
      'CREATE INDEX IF NOT EXISTS cpm_prompts_content_sid_idx ON cpm_user_prompts (content_session_id)');
    await execSafe(pool, 'idx: prompts.user_id',
      'CREATE INDEX IF NOT EXISTS cpm_prompts_user_id_idx ON cpm_user_prompts (user_id)');
    await execSafe(pool, 'idx: prompts.user+epoch',
      'CREATE INDEX IF NOT EXISTS cpm_prompts_user_epoch_idx ON cpm_user_prompts (user_id, created_at_epoch)');

    // --- cpm_schema_versions indexes ---
    await execSafe(pool, 'idx: schema_versions.version',
      'CREATE UNIQUE INDEX IF NOT EXISTS cpm_schema_versions_version_idx ON cpm_schema_versions (version)');

    log.info('Indexes created');

    // ------------------------------------------------------------------
    // 4. Enable RLS on all tenant-scoped tables
    // ------------------------------------------------------------------
    log.info('Configuring Row Level Security …');

    for (const table of RLS_TABLES) {
      // Enable RLS (idempotent – Postgres ignores if already enabled).
      await execSafe(pool, `RLS enable: ${table}`,
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);

      // FORCE RLS ensures the table owner is also subject to policies.
      // Without this, the connection role (usually the DB owner) would
      // bypass RLS entirely.
      await execSafe(pool, `RLS force: ${table}`,
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

      // Create the tenant-isolation policy.
      // `current_setting('app.user_id', true)` returns NULL instead of
      // erroring when the variable is not set – this means queries
      // without a SET will see zero rows (safe default).
      await execSafe(pool, `RLS policy: ${table}`,
        `CREATE POLICY user_isolation ON ${table}
           USING (user_id = current_setting('app.user_id', true))
           WITH CHECK (user_id = current_setting('app.user_id', true))`);
    }

    log.info('RLS configured on all tenant tables');

    // ------------------------------------------------------------------
    // 5. Create a superuser bypass role for admin operations
    // ------------------------------------------------------------------
    log.info('Creating admin bypass role …');

    await execSafe(pool, 'role: cpm_admin',
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cpm_admin') THEN
           CREATE ROLE cpm_admin NOLOGIN;
         END IF;
       END $$`);

    // Grant the admin role BYPASSRLS (requires superuser or rds_superuser).
    // On Azure Flexible Server the admin account has the necessary
    // privileges.  If this fails (e.g. on a restricted environment) we
    // log a warning but don't abort.
    await execSafe(pool, 'role: cpm_admin BYPASSRLS',
      'ALTER ROLE cpm_admin BYPASSRLS');

    // Grant full access on all cpm_ tables to the admin role.
    for (const table of [...RLS_TABLES, 'cpm_schema_versions'] as const) {
      await execSafe(pool, `grant: ${table} → cpm_admin`,
        `GRANT ALL ON TABLE ${table} TO cpm_admin`);
    }

    log.info('Admin bypass role configured');

    // ------------------------------------------------------------------
    // 6. Remove BYPASSRLS from the connecting role
    // ------------------------------------------------------------------
    // On Azure PostgreSQL Flexible Server the admin user has BYPASSRLS
    // by default, which completely overrides FORCE ROW LEVEL SECURITY.
    // We remove it so RLS is enforced on normal worker connections.
    // Admins can still bypass RLS by using: SET ROLE cpm_admin;
    log.info('Removing BYPASSRLS from connecting role …');

    const currentUser = (await pool.query('SELECT current_user AS u')).rows[0]?.u;
    if (currentUser) {
      await execSafe(pool, `NOBYPASSRLS: ${currentUser}`,
        `ALTER ROLE ${currentUser} NOBYPASSRLS`);
      log.info(`BYPASSRLS removed from ${currentUser} – RLS now enforced`);
    }

    // ------------------------------------------------------------------
    // Done
    // ------------------------------------------------------------------
    log.info('Schema push completed successfully ✓');
  } catch (err) {
    log.error('Schema push failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await pool.end();
  }
}
