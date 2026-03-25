/**
 * CLI command: db embedding-test
 *
 * Verifies the configured embedding provider works end-to-end:
 *   1. Reads the EMBEDDING_PROVIDER setting
 *   2. Initialises the embedder
 *   3. Generates a test embedding for a sample string
 *   4. Validates dimensions match the expected value
 *   5. Optionally round-trips through the database (pgvector cast)
 */

import { Pool } from 'pg';
import { createEmbedder } from '../../services/embeddings.js';
import { getSetting } from '../../shared/settings.js';
import { shouldUseEntraAuth, createEntraPoolConfig } from '../../services/postgres/auth.js';

const TEST_TEXT = 'The quick brown fox jumps over the lazy dog.';

export async function embeddingTest(): Promise<void> {
  console.log('Embedding provider test\n');

  // ── 1. Show active configuration ──────────────────────────────────────
  const providerSetting = getSetting('EMBEDDING_PROVIDER') || 'nomic';
  const dimensionsSetting = getSetting('EMBEDDING_DIMENSIONS') || '768';
  console.log(`Configured provider : ${providerSetting}`);
  console.log(`Configured dimensions: ${dimensionsSetting}`);

  if (providerSetting === 'azure_openai') {
    const endpoint = getSetting('AZURE_OPENAI_ENDPOINT');
    const deployment = getSetting('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
    const apiVersion = getSetting('AZURE_OPENAI_API_VERSION') || '2024-06-01';
    const hasKey = !!getSetting('AZURE_OPENAI_API_KEY');
    console.log(`Endpoint             : ${endpoint || '(not set)'}`);
    console.log(`Deployment           : ${deployment || '(not set)'}`);
    console.log(`API version          : ${apiVersion}`);
    console.log(`API key              : ${hasKey ? '(set)' : '(NOT SET)'}`);
  }
  console.log('');

  // ── 2. Create embedder ────────────────────────────────────────────────
  let embedder: ReturnType<typeof createEmbedder>;
  try {
    embedder = createEmbedder();
  } catch (err) {
    console.error(
      `Failed to create embedder: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Active provider : ${embedder.info.provider}`);
  console.log(`Active model    : ${embedder.info.model}`);
  console.log(`Active dimensions: ${embedder.info.dimensions}`);

  if (embedder.info.provider === 'noop') {
    console.log('\nWarning: noop embedder is active — this produces zero vectors.');
    console.log('Semantic search will not work. Check your provider configuration.');
    if (providerSetting === 'azure_openai') {
      console.error(
        '\nAzure OpenAI was configured but fell back to noop. Check the missing settings above.',
      );
      process.exitCode = 1;
      return;
    }
  }

  // ── 3. Generate test embedding ────────────────────────────────────────
  console.log(`\nTest text: "${TEST_TEXT}"`);
  console.log('Generating embedding...');

  const startMs = Date.now();
  let vector: number[];
  try {
    vector = await embedder.embed(TEST_TEXT);
  } catch (err) {
    console.error(
      `\nEmbedding generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }
  const elapsedMs = Date.now() - startMs;

  console.log(`Embedding generated in ${elapsedMs}ms`);
  console.log(`Vector length: ${vector.length}`);
  console.log(`First 5 values: [${vector.slice(0, 5).map((v) => v.toFixed(6)).join(', ')}]`);

  // ── 4. Validate dimensions ────────────────────────────────────────────
  const expectedDim = embedder.info.dimensions;
  if (vector.length !== expectedDim) {
    console.error(
      `\nDimension mismatch! Expected ${expectedDim} but got ${vector.length}.`,
    );
    console.error('This will cause pgvector INSERT errors. Fix your EMBEDDING_DIMENSIONS setting.');
    process.exitCode = 1;
    return;
  }
  console.log(`Dimension check: PASS (${vector.length} == ${expectedDim})`);

  // ── 5. Validate vector values ─────────────────────────────────────────
  const hasNaN = vector.some((v) => Number.isNaN(v));
  const hasInf = vector.some((v) => !Number.isFinite(v));
  const allZero = vector.every((v) => v === 0);

  if (hasNaN || hasInf) {
    console.error('\nVector contains NaN or Infinity values — this will break pgvector.');
    process.exitCode = 1;
    return;
  }
  console.log('NaN/Infinity check: PASS');

  if (allZero && embedder.info.provider !== 'noop') {
    console.warn('Warning: Vector is all zeros — semantic search will not be useful.');
  }

  // ── 6. Optional: round-trip through database ──────────────────────────
  const databaseUrl = getSetting('DATABASE_URL');
  if (!databaseUrl) {
    console.log('\nNo DATABASE_URL configured — skipping database round-trip test.');
    console.log('\nResult: PASS (embedding provider works)');
    return;
  }

  console.log('\nTesting database round-trip (pgvector cast)...');

  const authMethod = getSetting('AUTH_METHOD');
  const useEntra = shouldUseEntraAuth(authMethod, databaseUrl);

  let pool: Pool;
  if (useEntra) {
    const entraConfig = createEntraPoolConfig(databaseUrl);
    pool = new Pool({ ...entraConfig, max: 1 });
  } else {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('azure') ? { rejectUnauthorized: false } : undefined,
      max: 1,
    });
  }

  try {
    const client = await pool.connect();
    try {
      // Cast to vector and back — verifies pgvector accepts the dimensions.
      const vectorStr = `[${vector.join(',')}]`;
      const result = await client.query(
        `SELECT ($1::vector(${expectedDim}))::text AS v`,
        [vectorStr],
      );
      const returned = (result.rows[0] as { v: string }).v;
      console.log(`pgvector cast: PASS (returned ${returned.length} chars)`);

      // Test cosine similarity with itself (should be ~1.0 or 0.0 distance).
      const simResult = await client.query(
        `SELECT 1 - ($1::vector(${expectedDim}) <=> $1::vector(${expectedDim})) AS cosine_sim`,
        [vectorStr],
      );
      const sim = parseFloat((simResult.rows[0] as { cosine_sim: string }).cosine_sim);
      console.log(`Self-similarity: ${sim.toFixed(6)} (expected ~1.0)`);

      if (Math.abs(sim - 1.0) > 0.001 && embedder.info.provider !== 'noop') {
        console.warn('Warning: Self-similarity is not ~1.0 — unexpected.');
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(
      `Database round-trip failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  } finally {
    await pool.end();
  }

  console.log('\nResult: PASS (embedding provider + database verified)');
}
