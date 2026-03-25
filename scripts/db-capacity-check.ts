import { Pool } from 'pg';
import { getSetting } from '../src/shared/settings.js';
import { shouldUseEntraAuth, createEntraPoolConfig } from '../src/services/postgres/auth.js';

async function main() {
  const databaseUrl = getSetting('DATABASE_URL');
  const authMethod = getSetting('AUTH_METHOD');
  const useEntra = shouldUseEntraAuth(authMethod, databaseUrl);

  let pool: Pool;
  if (useEntra) {
    const entraConfig = createEntraPoolConfig(databaseUrl);
    pool = new Pool({ ...entraConfig, max: 1 });
  } else {
    const needsSsl =
      databaseUrl.includes('sslmode=require') || databaseUrl.includes('.postgres.database.azure.com');
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });
  }

  const client = await pool.connect();

  // Current DB size
  const sizeRes = await client.query("SELECT pg_size_pretty(pg_database_size(current_database())) as db_size");
  console.log('Database size:', sizeRes.rows[0].db_size);

  // Table sizes
  const tableSizes = await client.query(`
    SELECT 
      relname as table_name,
      pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
      pg_size_pretty(pg_relation_size(c.oid)) as data_size,
      pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) as index_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE relname LIKE 'cpm_%' AND relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `);
  console.log('\nTable sizes:');
  for (const row of tableSizes.rows) {
    console.log(`  ${row.table_name}: total=${row.total_size}, data=${row.data_size}, indexes=${row.index_size}`);
  }

  // Row counts  
  const tables = ['cpm_observations', 'cpm_sessions', 'cpm_session_summaries', 'cpm_sdk_sessions', 'cpm_pending_messages', 'cpm_user_prompts'];
  console.log('\nRow counts:');
  for (const t of tables) {
    const res = await client.query('SELECT count(*) as cnt FROM ' + t);
    console.log(`  ${t}: ${res.rows[0].cnt}`);
  }

  // Estimate single observation row size (with vector)
  const avgRowSize = await client.query(`
    SELECT 
      pg_size_pretty(avg(pg_column_size(t.*))::bigint) as avg_row_size
    FROM cpm_observations t
  `);
  console.log('\nAvg observation row size:', avgRowSize.rows[0].avg_row_size || '(no data yet)');

  // Estimate row size from column definitions
  // vector(768) = 768 * 4 bytes = 3072 bytes overhead
  // Plus text columns, timestamps, UUIDs, tsvector index
  console.log('\nEstimated observation row sizes:');
  console.log('  vector(768) column alone: ~3,072 bytes (768 floats × 4 bytes)');
  console.log('  text + metadata: ~500-2000 bytes (varies by observation text length)');
  console.log('  tsvector index entry: ~200-500 bytes');
  console.log('  HNSW index overhead per row: ~500-1000 bytes');
  console.log('  Estimated total per observation: ~4-7 KB');

  // Max connections
  const maxConn = await client.query('SHOW max_connections');
  console.log('\nMax connections:', maxConn.rows[0].max_connections);

  // Shared buffers
  const sharedBuf = await client.query('SHOW shared_buffers');
  console.log('Shared buffers:', sharedBuf.rows[0].shared_buffers);

  // Work mem
  const workMem = await client.query('SHOW work_mem');
  console.log('Work mem:', workMem.rows[0].work_mem);

  client.release();
  await pool.end();
}

main().catch(console.error);
