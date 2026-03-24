/**
 * CLI command: setup
 *
 * One-command interactive setup that:
 *   1. Prompts for DATABASE_URL (or accepts --database-url flag)
 *   2. Prompts for embedding config (Azure OpenAI or local Nomic)
 *   3. Saves all settings to ~/.agent-mem/settings.json
 *   4. Pushes the database schema (tables, indexes, RLS, pgvector)
 *   5. Starts the worker daemon
 *   6. Verifies health
 *   7. Installs the Claude Code plugin
 *
 * Usage:
 *   npx tsx src/index.ts setup
 *   npx tsx src/index.ts setup --database-url "postgres://..." --embedding-provider nomic
 */

import * as readline from 'node:readline';
import { getSetting, setSetting } from '../../shared/settings.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Setup');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPrompt(): (question: string) => Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });

  // Attach close so caller can clean up
  (ask as any).close = () => rl.close();
  return ask;
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Parse CLI flags (so users can skip the interactive prompts)
// ---------------------------------------------------------------------------

interface SetupFlags {
  databaseUrl?: string;
  embeddingProvider?: string;
  azureOpenaiEndpoint?: string;
  azureOpenaiKey?: string;
  azureOpenaiDeployment?: string;
  skipPrompts?: boolean;
}

export function parseSetupFlags(argv: string[]): SetupFlags {
  const flags: SetupFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--database-url' && next) { flags.databaseUrl = next; i++; }
    else if (arg === '--embedding-provider' && next) { flags.embeddingProvider = next; i++; }
    else if (arg === '--azure-openai-endpoint' && next) { flags.azureOpenaiEndpoint = next; i++; }
    else if (arg === '--azure-openai-key' && next) { flags.azureOpenaiKey = next; i++; }
    else if (arg === '--azure-openai-deployment' && next) { flags.azureOpenaiDeployment = next; i++; }
    else if (arg === '--yes' || arg === '-y') { flags.skipPrompts = true; }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Main setup flow
// ---------------------------------------------------------------------------

export async function setup(flags: SetupFlags = {}): Promise<void> {
  const ask = createPrompt();

  console.log('');
  console.log('=== agent-mem setup ===');
  console.log('This will configure your persistent memory system for AI coding agents.');
  console.log('');

  try {
    // ------------------------------------------------------------------
    // Step 1: DATABASE_URL
    // ------------------------------------------------------------------
    console.log('--- Step 1/5: Database ---');

    let dbUrl = flags.databaseUrl || getSetting('DATABASE_URL');
    if (!dbUrl) {
      console.log('');
      console.log('You need an Azure PostgreSQL Flexible Server with pgvector enabled.');
      console.log('The connection string looks like:');
      console.log('  postgres://user:password@server.postgres.database.azure.com:5432/dbname?sslmode=require');
      console.log('');
      dbUrl = await ask('DATABASE_URL: ');
    } else {
      console.log(`Using DATABASE_URL: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`);
    }

    if (!dbUrl) {
      console.error('DATABASE_URL is required. Aborting.');
      process.exitCode = 1;
      return;
    }
    setSetting('DATABASE_URL', dbUrl);
    console.log('  Saved.');
    console.log('');

    // ------------------------------------------------------------------
    // Step 2: Embedding provider
    // ------------------------------------------------------------------
    console.log('--- Step 2/5: Embeddings ---');

    let provider = flags.embeddingProvider || getSetting('EMBEDDING_PROVIDER');
    if (!provider || (provider !== 'azure_openai' && provider !== 'nomic')) {
      console.log('');
      console.log('Choose an embedding provider:');
      console.log('  1. azure_openai  – Azure OpenAI text-embedding-3-small (recommended)');
      console.log('  2. nomic         – Local Nomic Embed (no API key needed, slower)');
      console.log('');
      const choice = await ask('Embedding provider [1/2, default=1]: ');
      provider = choice === '2' ? 'nomic' : 'azure_openai';
    }

    setSetting('EMBEDDING_PROVIDER', provider);
    console.log(`  Provider: ${provider}`);

    if (provider === 'azure_openai') {
      let endpoint = flags.azureOpenaiEndpoint || getSetting('AZURE_OPENAI_ENDPOINT');
      if (!endpoint) {
        console.log('');
        console.log('  Enter your Azure OpenAI endpoint (e.g. https://myresource.openai.azure.com)');
        endpoint = await ask('  AZURE_OPENAI_ENDPOINT: ');
      }
      if (endpoint) setSetting('AZURE_OPENAI_ENDPOINT', endpoint);

      let deployment = flags.azureOpenaiDeployment || getSetting('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
      if (!deployment) {
        deployment = 'text-embedding-3-small';
        console.log(`  Using default deployment: ${deployment}`);
      }
      setSetting('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', deployment);

      let apiKey = flags.azureOpenaiKey || getSetting('AZURE_OPENAI_API_KEY');
      if (!apiKey) {
        console.log('');
        console.log('  API key (leave blank to use Azure AD / DefaultAzureCredential via az login):');
        apiKey = await ask('  AZURE_OPENAI_API_KEY [optional]: ');
      }
      if (apiKey) setSetting('AZURE_OPENAI_API_KEY', apiKey);

      console.log('  Embedding config saved.');
    }
    console.log('');

    // ------------------------------------------------------------------
    // Step 3: Push schema
    // ------------------------------------------------------------------
    console.log('--- Step 3/5: Database schema ---');
    console.log('  Pushing tables, indexes, pgvector, and RLS policies...');

    const { pushSchema } = await import('../../services/postgres/schema-push.js');
    await pushSchema(getSetting('DATABASE_URL'));
    console.log('  Schema push complete.');
    console.log('');

    // ------------------------------------------------------------------
    // Step 4: Start worker
    // ------------------------------------------------------------------
    console.log('--- Step 4/5: Worker daemon ---');

    const port = parseInt(getSetting('WORKER_PORT') || '37778', 10);

    // Check if already running
    let alreadyRunning = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      alreadyRunning = res.ok;
    } catch { /* not running */ }

    if (alreadyRunning) {
      console.log(`  Worker already running on port ${port}.`);
    } else {
      console.log(`  Starting worker on port ${port}...`);
      const { startWorker } = await import('./worker.js');
      await startWorker();
    }

    // Verify health
    const healthy = await waitForHealth(port);
    if (healthy) {
      console.log('  Worker is healthy.');
    } else {
      console.error('  WARNING: Worker health check failed. Check logs in ~/.agent-mem/');
    }
    console.log('');

    // ------------------------------------------------------------------
    // Step 5: Install plugin
    // ------------------------------------------------------------------
    console.log('--- Step 5/5: Plugin install ---');

    const { install } = await import('./install.js');
    await install();
    console.log('');

    // ------------------------------------------------------------------
    // Done
    // ------------------------------------------------------------------
    console.log('=== Setup complete ===');
    console.log('');
    console.log('Your agent-mem system is ready. Restart Claude Code to activate.');
    console.log('');
    console.log('Useful commands:');
    console.log('  npx tsx src/index.ts status         Check worker status');
    console.log('  npx tsx src/index.ts db status       Check database connection');
    console.log('  npx tsx src/index.ts stop            Stop worker');
    console.log('  npx tsx src/index.ts start           Start worker');
    console.log('');
  } finally {
    (ask as any).close();
  }
}
