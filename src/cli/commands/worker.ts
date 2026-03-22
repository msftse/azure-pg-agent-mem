/**
 * CLI commands: start / stop / status for worker daemon.
 *
 * Manages the worker HTTP service lifecycle.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { DATA_DIR } from '../../shared/settings.js';
import { logger } from '../../shared/logger.js';

const log = logger.child('Worker');

const PID_FILE = join(DATA_DIR, 'worker.pid');
const DEFAULT_PORT = 37778;

function getWorkerPort(): number {
  return parseInt(process.env.AGENT_MEM_WORKER_PORT || '37778', 10) || DEFAULT_PORT;
}

interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function readPidFile(): PidInfo | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, 'utf-8')) as PidInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startWorker(): Promise<void> {
  const port = getWorkerPort();

  // Check if already running
  if (await isPortInUse(port)) {
    console.log(`Worker already running on port ${port}`);
    return;
  }

  // Clean stale PID file
  const pidInfo = readPidFile();
  if (pidInfo && !isProcessAlive(pidInfo.pid)) {
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  log.info('Starting worker daemon', { port });

  // Resolve the worker script path.
  // When running from compiled dist/: use dist/services/worker-service.js
  // When running from source via tsx: use src/services/worker-service.ts
  // We detect by checking if we're in a .ts context (tsx) or .js context (node)
  const selfPath = import.meta.url;
  const isTsx = selfPath.endsWith('.ts');

  let workerScript: string;
  let execArgs: string[];

  if (isTsx) {
    // Running from source — need to use tsx to execute the .ts file
    const { fileURLToPath } = await import('node:url');
    const selfFile = fileURLToPath(selfPath);
    workerScript = join(selfFile, '..', '..', '..', 'services', 'worker-service.ts');
    // Use npx tsx (or find tsx in node_modules)
    const tsxBin = join(selfFile, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    execArgs = existsSync(tsxBin)
      ? [tsxBin, workerScript, 'start']
      : ['npx', 'tsx', workerScript, 'start'];
  } else {
    // Running from compiled dist/ — use node directly
    const { fileURLToPath } = await import('node:url');
    const selfFile = fileURLToPath(selfPath);
    workerScript = join(selfFile, '..', '..', '..', 'services', 'worker-service.js');
    execArgs = [workerScript, 'start', '--foreground'];
  }

  const executable = isTsx ? execArgs.shift()! : process.execPath;

  const child = spawn(executable, execArgs, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENT_MEM_WORKER_PORT: String(port),
    },
  });

  child.unref();

  // Wait for health
  const startTime = Date.now();
  const timeout = 30_000;
  let healthy = false;

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isPortInUse(port)) {
      healthy = true;
      break;
    }
  }

  if (healthy) {
    console.log(`Worker started on port ${port} (PID ${child.pid})`);
  } else {
    console.error('Worker failed to start within 30 seconds.');
    process.exitCode = 1;
  }
}

export async function stopWorker(): Promise<void> {
  const port = getWorkerPort();

  if (!(await isPortInUse(port))) {
    console.log('No worker running.');
    // Clean stale PID file
    const pidInfo = readPidFile();
    if (pidInfo && !isProcessAlive(pidInfo.pid)) {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    }
    return;
  }

  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    console.log('Worker stopped.');
  } catch {
    // Force kill via PID
    const pidInfo = readPidFile();
    if (pidInfo && isProcessAlive(pidInfo.pid)) {
      try {
        process.kill(pidInfo.pid, 'SIGTERM');
        console.log(`Sent SIGTERM to PID ${pidInfo.pid}`);
      } catch {
        console.error('Failed to stop worker');
      }
    }
  }

  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

export async function workerStatus(): Promise<void> {
  const port = getWorkerPort();

  if (!(await isPortInUse(port))) {
    console.log(`Worker: not running (port ${port})`);
    return;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const health = (await res.json()) as {
      status: string;
      version: string;
      uptime: number;
      pid: number;
    };
    console.log(`Worker: running`);
    console.log(`  Port:    ${port}`);
    console.log(`  PID:     ${health.pid}`);
    console.log(`  Version: ${health.version}`);
    console.log(`  Uptime:  ${Math.round(health.uptime)}s`);
  } catch {
    console.log(`Worker: port ${port} in use but health check failed`);
  }
}
