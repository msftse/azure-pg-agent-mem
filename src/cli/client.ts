/**
 * HTTP client helpers for CLI → Worker communication.
 *
 * Every hook handler needs to resolve the worker URL and current user ID.
 * This module centralises that logic.
 */

import os from 'node:os';
import crypto from 'node:crypto';
import { getSetting } from '../shared/settings.js';
import { logger } from '../shared/logger.js';

const log = logger.child('Client');

// ---------------------------------------------------------------------------
// User ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the current user ID.
 * Priority: AGENT_MEM_USER_ID env / settings → SHA-256 hash of OS user + hostname.
 *
 * Must produce the same value as `resolveUserId()` in `postgres/client.ts`
 * so RLS policies match.
 */
export function resolveUserId(): string {
  const configured = getSetting('USER_ID');
  if (configured) return configured;

  const raw = `${os.userInfo().username}@${os.hostname()}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  log.debug('Derived user ID', { raw, hash });
  return hash;
}

// ---------------------------------------------------------------------------
// Worker base URL
// ---------------------------------------------------------------------------

/** Build the worker base URL from settings. */
export function workerBaseUrl(): string {
  const host = getSetting('WORKER_HOST');
  const port = getSetting('WORKER_PORT');
  return `http://${host}:${port}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * POST JSON to the worker.
 * Returns the parsed response body, or throws on non-2xx status.
 */
export async function workerPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${workerBaseUrl()}${path}`;
  log.debug('POST', { url });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker POST ${path} failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return undefined as T;
}

/**
 * GET from the worker.
 * Returns the parsed response body, or throws on non-2xx status.
 */
export async function workerGet<T = unknown>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const base = `${workerBaseUrl()}${path}`;
  const url = params
    ? `${base}?${new URLSearchParams(params).toString()}`
    : base;
  log.debug('GET', { url });

  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker GET ${path} failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return undefined as T;
}
