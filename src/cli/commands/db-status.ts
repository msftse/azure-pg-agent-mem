/**
 * CLI command: db status
 *
 * Checks database connection and reports table row counts.
 */

import { Pool } from 'pg';
import { getSetting } from '../../shared/settings.js';
import { logger } from '../../shared/logger.js';
import { shouldUseEntraAuth, createEntraPoolConfig } from '../../services/postgres/auth.js';

const log = logger.child('DB:Status');

const TABLES = [
  'cpm_sessions',
  'cpm_sdk_sessions',
  'cpm_observations',
  'cpm_session_summaries',
  'cpm_pending_messages',
  'cpm_user_prompts',
  'cpm_schema_versions',
];

export async function dbStatus(): Promise<void> {
  const databaseUrl = getSetting('DATABASE_URL');
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    console.error('Run: claude-azure-pg-mem config set DATABASE_URL "postgres://..."');
    process.exitCode = 1;
    return;
  }

  const authMethod = getSetting('AUTH_METHOD');
  const useEntra = shouldUseEntraAuth(authMethod, databaseUrl);

  let pool: Pool;
  if (useEntra) {
    const entraConfig = createEntraPoolConfig(databaseUrl);
    pool = new Pool({ ...entraConfig, max: 1 });
  } else {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: (databaseUrl.includes('sslmode=require') || databaseUrl.includes('.postgres.database.azure.com'))
        ? { rejectUnauthorized: false }
        : undefined,
      max: 1,
    });
  }

  try {
    // Test connection
    const client = await pool.connect();
    const versionResult = await client.query('SELECT version()');
    console.log(`Connected: ${(versionResult.rows[0] as { version: string }).version.split(',')[0]}`);

    // Check pgvector
    try {
      const extResult = await client.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
      );
      if (extResult.rows.length > 0) {
        const ver = (extResult.rows[0] as { extversion: string }).extversion;
        console.log(`pgvector: enabled (v${ver})`);
      } else {
        console.log('pgvector: NOT enabled (run "db push" first)');
      }
    } catch {
      console.log('pgvector: NOT enabled (run "db push" first)');
    }

    // Table counts — use pg_stat_user_tables for estimated row counts.
    // Direct COUNT(*) returns 0 because NOBYPASSRLS is set on the admin role
    // and no app.user_id context is set in this diagnostic connection.
    console.log('\nTable row counts (estimated):');
    for (const table of TABLES) {
      try {
        const result = await client.query(
          `SELECT n_live_tup AS cnt FROM pg_stat_user_tables WHERE relname = $1`,
          [table],
        );
        if (result.rows.length > 0) {
          const count = (result.rows[0] as { cnt: string }).cnt;
          console.log(`  ${table}: ~${count}`);
        } else {
          console.log(`  ${table}: (not found — run "db push")`);
        }
      } catch {
        console.log(`  ${table}: (not found — run "db push")`);
      }
    }

    // Check RLS status
    console.log('\nRow Level Security:');
    const rlsResult = await client.query(`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE tablename LIKE 'cpm_%' 
      ORDER BY tablename
    `);
    for (const row of rlsResult.rows as Array<{ tablename: string; rowsecurity: boolean }>) {
      console.log(`  ${row.tablename}: ${row.rowsecurity ? 'ENABLED' : 'disabled'}`);
    }

    client.release();
  } catch (err) {
    log.error('Connection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
