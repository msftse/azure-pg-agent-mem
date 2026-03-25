/**
 * Settings manager for claude-azure-pg-mem.
 *
 * Reads / writes a JSON file at ~/.agent-mem/settings.json.
 * Priority order (highest wins):
 *   1. Environment variables  (AGENT_MEM_*, DATABASE_URL)
 *   2. settings.json values
 *   3. Hard-coded defaults
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base data directory – overridable via env. */
export const DATA_DIR =
  process.env.AGENT_MEM_DATA_DIR || path.join(os.homedir(), '.agent-mem');

/** Path to the settings JSON file. */
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ---------------------------------------------------------------------------
// Defaults & env-var mapping
// ---------------------------------------------------------------------------

/** Keys we recognise, their defaults, and corresponding env vars. */
const SETTING_DEFS: Record<
  string,
  { default: string; env: string | string[] }
> = {
  DATABASE_URL: {
    default: '',
    env: ['DATABASE_URL', 'AGENT_MEM_DATABASE_URL'],
  },
  // PostgreSQL authentication method: 'password' (default, uses DATABASE_URL
  // credentials), 'entra_id' (Azure AD / Entra ID token auth via az login),
  // or 'auto' (detects from DATABASE_URL — if password present, uses password;
  // otherwise uses Entra ID).
  AUTH_METHOD: {
    default: 'auto',
    env: 'AGENT_MEM_AUTH_METHOD',
  },
  USER_ID: { default: '', env: 'AGENT_MEM_USER_ID' },
  WORKER_PORT: { default: '37778', env: 'AGENT_MEM_WORKER_PORT' },
  WORKER_HOST: { default: '127.0.0.1', env: 'AGENT_MEM_WORKER_HOST' },
  LOG_LEVEL: { default: 'INFO', env: 'AGENT_MEM_LOG_LEVEL' },
  CONTEXT_OBSERVATIONS: {
    default: '50',
    env: 'AGENT_MEM_CONTEXT_OBSERVATIONS',
  },

  // ── Embedding provider settings ──────────────────────────────────────
  // Which embedding provider to use: 'nomic' (default, local) or 'azure_openai'.
  EMBEDDING_PROVIDER: {
    default: 'nomic',
    env: 'AGENT_MEM_EMBEDDING_PROVIDER',
  },
  // Target dimensionality for embeddings. Must match the DB vector(N) column.
  // Nomic Embed Text v1 produces 768-dim. Azure OpenAI text-embedding-3-*
  // supports a 'dimensions' parameter to truncate output to any size.
  // Default: 768 (matches the DB schema's vector(768) column).
  EMBEDDING_DIMENSIONS: {
    default: '768',
    env: 'AGENT_MEM_EMBEDDING_DIMENSIONS',
  },
  // Azure OpenAI endpoint (e.g. https://<resource>.openai.azure.com).
  AZURE_OPENAI_ENDPOINT: {
    default: '',
    env: 'AGENT_MEM_AZURE_OPENAI_ENDPOINT',
  },
  // Azure OpenAI API key.
  AZURE_OPENAI_API_KEY: {
    default: '',
    env: 'AGENT_MEM_AZURE_OPENAI_API_KEY',
  },
  // Azure OpenAI deployment name for the embedding model
  // (e.g. 'text-embedding-3-small').
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: {
    default: '',
    env: 'AGENT_MEM_AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
  },
  // Azure OpenAI API version (defaults to latest stable).
  AZURE_OPENAI_API_VERSION: {
    default: '2024-06-01',
    env: 'AGENT_MEM_AZURE_OPENAI_API_VERSION',
  },
};

const log = logger.child('Settings');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Settings = Record<string, string>;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Load the settings file from disk.
 * Returns an empty object if the file does not exist or is malformed.
 */
export function loadSettings(): Settings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('settings.json is not a plain object – ignoring');
      return {};
    }
    return parsed as Settings;
  } catch (err) {
    log.warn('Failed to read settings.json', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/**
 * Persist a full settings object to disk, creating the directory if needed.
 */
export function saveSettings(settings: Settings): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    log.debug('Settings saved', { path: SETTINGS_FILE });
  } catch (err) {
    log.error('Failed to write settings.json', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Getters / setters
// ---------------------------------------------------------------------------

/**
 * Retrieve a single setting value.
 * Resolution order: env var → settings.json → default.
 */
export function getSetting(key: string): string {
  const def = SETTING_DEFS[key];

  // 1. Check env vars (may be a single string or array of candidates).
  if (def) {
    const envKeys = Array.isArray(def.env) ? def.env : [def.env];
    for (const envKey of envKeys) {
      const envVal = process.env[envKey];
      if (envVal !== undefined && envVal !== '') return envVal;
    }
  } else {
    // Unknown key – still honour a prefixed env var.
    const envVal = process.env[`AGENT_MEM_${key}`];
    if (envVal !== undefined && envVal !== '') return envVal;
  }

  // 2. Check settings.json.
  const file = loadSettings();
  if (file[key] !== undefined && file[key] !== '') return file[key];

  // 3. Fall back to default.
  return def?.default ?? '';
}

/**
 * Persist a single key into settings.json (does not touch env vars).
 */
export function setSetting(key: string, value: string): void {
  const current = loadSettings();
  current[key] = value;
  saveSettings(current);
}
