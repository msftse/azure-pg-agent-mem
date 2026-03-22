/**
 * CLI command: db push
 *
 * Pushes the database schema to Azure PostgreSQL,
 * creates pgvector extension, tables, indexes, and RLS policies.
 */

import { pushSchema } from '../../services/postgres/schema-push.js';
import { getSetting } from '../../shared/settings.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('DB:Push');

export async function pushSchemaCmd(): Promise<void> {
  const databaseUrl = getSetting('DATABASE_URL');
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    console.error('Run: claude-azure-pg-mem config set DATABASE_URL "postgres://..."');
    process.exitCode = 1;
    return;
  }

  log.info('Pushing schema to database...');
  await pushSchema(databaseUrl);
  log.info('Schema push complete.');
}

// Re-export as the name the CLI expects
export { pushSchemaCmd as pushSchema };
