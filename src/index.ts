#!/usr/bin/env node

/**
 * CLI entry point for claude-azure-pg-mem.
 *
 * Keeps startup fast by importing handlers lazily.
 * Parse args from process.argv — no external CLI framework needed.
 */

import { logger } from './shared/logger.js';

const log = logger.child('CLI');

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const USAGE = `
claude-azure-pg-mem – Azure Postgres persistent memory for coding agents

Usage:
  claude-azure-pg-mem config set <key> <value>   Set a config value
  claude-azure-pg-mem config get <key>            Get a config value
  claude-azure-pg-mem config list                 List all settings
  claude-azure-pg-mem db push                     Push schema to database
  claude-azure-pg-mem db status                   Check DB connection & table counts
  claude-azure-pg-mem db embedding-test           Test configured embedding provider
  claude-azure-pg-mem install                     Register as Claude Code plugin
  claude-azure-pg-mem uninstall                   Remove plugin registration
  claude-azure-pg-mem start                       Start worker daemon
  claude-azure-pg-mem stop                        Stop worker daemon
  claude-azure-pg-mem status                      Show worker status
  claude-azure-pg-mem hook <adapter> <handler>    Called by Claude Code hooks
`.trim();

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (cmd) {
    // ---- config ---------------------------------------------------------
    case 'config': {
      const { getSetting, setSetting, loadSettings } = await import('./shared/settings.js');

      if (sub === 'set') {
        const key = args[2];
        const value = args[3];
        if (!key || value === undefined) {
          console.error('Usage: claude-azure-pg-mem config set <key> <value>');
          process.exitCode = 1;
          return;
        }
        setSetting(key, value);
        console.log(`Set ${key} = ${value}`);
        return;
      }

      if (sub === 'get') {
        const key = args[2];
        if (!key) {
          console.error('Usage: claude-azure-pg-mem config get <key>');
          process.exitCode = 1;
          return;
        }
        const val = getSetting(key);
        console.log(val || '(not set)');
        return;
      }

      if (sub === 'list') {
        const settings = loadSettings();
        if (Object.keys(settings).length === 0) {
          console.log('No settings configured (using defaults / env vars).');
        } else {
          for (const [k, v] of Object.entries(settings)) {
            console.log(`${k} = ${v}`);
          }
        }
        return;
      }

      console.error(`Unknown config subcommand: ${sub}`);
      console.error('Valid subcommands: set, get, list');
      process.exitCode = 1;
      return;
    }

    // ---- db -------------------------------------------------------------
    case 'db': {
      if (sub === 'push') {
        const { pushSchema } = await import('./cli/commands/schema-push.js');
        await pushSchema();
        return;
      }

      if (sub === 'status') {
        const { dbStatus } = await import('./cli/commands/db-status.js');
        await dbStatus();
        return;
      }

      if (sub === 'embedding-test') {
        const { embeddingTest } = await import('./cli/commands/embedding-test.js');
        await embeddingTest();
        return;
      }

      console.error(`Unknown db subcommand: ${sub}`);
      console.error('Valid subcommands: push, status, embedding-test');
      process.exitCode = 1;
      return;
    }

    // ---- install / uninstall -------------------------------------------
    case 'install': {
      const { install } = await import('./cli/commands/install.js');
      await install();
      return;
    }

    case 'uninstall': {
      const { uninstall } = await import('./cli/commands/install.js');
      await uninstall();
      return;
    }

    // ---- worker lifecycle ----------------------------------------------
    case 'start': {
      const { startWorker } = await import('./cli/commands/worker.js');
      await startWorker();
      return;
    }

    case 'stop': {
      const { stopWorker } = await import('./cli/commands/worker.js');
      await stopWorker();
      return;
    }

    case 'status': {
      const { workerStatus } = await import('./cli/commands/worker.js');
      await workerStatus();
      return;
    }

    // ---- hook -----------------------------------------------------------
    case 'hook': {
      const adapter = args[1]; // e.g. "claude-code"
      const handler = args[2]; // e.g. "session-init", "observation", etc.

      if (!adapter || !handler) {
        console.error('Usage: claude-azure-pg-mem hook <adapter> <handler>');
        process.exitCode = 1;
        return;
      }

      log.debug('Hook invoked', { adapter, handler });

      switch (handler) {
        case 'session-init': {
          // Import triggers execution (module calls handleSessionInit at top level).
          await import('./cli/handlers/session-init.js');
          return;
        }
        case 'observation': {
          await import('./cli/handlers/observation.js');
          return;
        }
        case 'context': {
          await import('./cli/handlers/context.js');
          return;
        }
        case 'summarize': {
          await import('./cli/handlers/summarize.js');
          return;
        }
        case 'session-complete': {
          await import('./cli/handlers/session-complete.js');
          return;
        }
        default: {
          console.error(`Unknown hook handler: ${handler}`);
          console.error('Valid handlers: session-init, observation, context, summarize, session-complete');
          process.exitCode = 1;
          return;
        }
      }
    }

    // ---- help / fallback ------------------------------------------------
    case '--help':
    case '-h':
    case 'help':
    case undefined: {
      console.log(USAGE);
      return;
    }

    default: {
      console.error(`Unknown command: ${cmd}`);
      console.log(USAGE);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  log.error('Unhandled error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
