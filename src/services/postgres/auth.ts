/**
 * Azure Entra ID (AAD) authentication provider for PostgreSQL.
 *
 * Uses @azure/identity DefaultAzureCredential to obtain access tokens
 * for Azure Database for PostgreSQL Flexible Server. The token is used
 * as the password in the `pg` Pool configuration.
 *
 * Token lifecycle:
 *   - Tokens are cached and automatically refreshed 5 minutes before expiry.
 *   - The `pg` Pool supports `password` as an async function, so each new
 *     connection calls `getPostgresToken()` and gets a fresh token if needed.
 *
 * Prerequisites:
 *   1. Azure PostgreSQL server must have "Microsoft Entra authentication" enabled
 *      (Portal → Server → Security → Authentication).
 *   2. An Entra ID admin must be set on the server.
 *   3. Database roles must be created for Entra ID users:
 *        SELECT * FROM pgaadauth_create_principal('<user-or-group>', false, false);
 *   4. Users must be logged in via `az login` (or have a managed identity).
 *
 * Usage:
 *   import { createEntraPoolConfig } from './auth.js';
 *   const pool = new Pool({ ...createEntraPoolConfig(databaseUrl) });
 */

import { logger } from '../../shared/logger.js';

const log = logger.child('EntraAuth');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * OAuth2 scope for Azure Database for PostgreSQL (OSS RDBMS).
 * This is the standard scope for all Azure PostgreSQL Flexible Server tokens.
 */
const POSTGRES_TOKEN_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/** Refresh margin — acquire a new token 5 minutes before the old one expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresOnTimestamp: number } | null = null;

/**
 * Obtain an Azure AD access token for PostgreSQL.
 *
 * The token is cached and only refreshed when it is within 5 minutes of
 * expiry. Uses `DefaultAzureCredential` which tries (in order):
 *   - Environment variables (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET)
 *   - Azure CLI (`az login`)
 *   - Managed identity
 *   - Visual Studio Code credential
 *   - etc.
 *
 * @returns The access token string (used as the PG password).
 */
export async function getPostgresToken(): Promise<string> {
  const now = Date.now();

  // Return cached token if still valid (with 5-minute margin)
  if (cachedToken && cachedToken.expiresOnTimestamp - now > REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }

  // Lazily import to avoid pulling in the SDK unless Entra auth is actually used.
  const { DefaultAzureCredential } = await import('@azure/identity');
  const credential = new DefaultAzureCredential();

  const accessToken = await credential.getToken(POSTGRES_TOKEN_SCOPE);

  if (!accessToken) {
    throw new Error(
      'Failed to obtain Entra ID token for Azure PostgreSQL. ' +
        'Ensure you are logged in (az login) or have a valid managed identity.',
    );
  }

  cachedToken = {
    token: accessToken.token,
    expiresOnTimestamp: accessToken.expiresOnTimestamp,
  };

  log.info('Azure AD token acquired for PostgreSQL', {
    expiresIn: Math.round((accessToken.expiresOnTimestamp - now) / 1000) + 's',
  });

  return accessToken.token;
}

// ---------------------------------------------------------------------------
// Pool configuration helper
// ---------------------------------------------------------------------------

/**
 * Determines if Entra ID authentication should be used.
 *
 * Detection logic (in order):
 *   1. If AUTH_METHOD setting is explicitly 'entra_id' → use Entra ID
 *   2. If AUTH_METHOD setting is explicitly 'password' → use password
 *   3. If DATABASE_URL contains a password (user:password@host) → use password
 *   4. Otherwise → use Entra ID
 */
export function shouldUseEntraAuth(
  authMethod: string,
  databaseUrl: string,
): boolean {
  // Explicit setting takes priority
  if (authMethod === 'entra_id') return true;
  if (authMethod === 'password') return false;

  // Auto-detect: if URL has a non-empty password segment, use password auth
  try {
    const url = new URL(databaseUrl);
    if (url.password && url.password.length > 0) {
      return false; // URL has a password → use password auth
    }
  } catch {
    // Not a valid URL — fall through to Entra ID
  }

  return true; // Default: use Entra ID
}

/**
 * Parse a DATABASE_URL into components needed for Entra ID pool config.
 *
 * When using Entra ID, the password in the URL is ignored and replaced
 * by a token from `getPostgresToken()`. The username in the URL should
 * be the Entra ID principal name (email or display name).
 */
export interface EntraPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: () => Promise<string>;
  ssl: { rejectUnauthorized: false };
}

/**
 * Create a `pg` Pool configuration object that uses Entra ID tokens.
 *
 * The `password` field is an async function — `pg` Pool calls it on each
 * new connection, ensuring tokens are always fresh.
 *
 * @param databaseUrl - The connection string (password portion is ignored).
 * @returns Partial Pool config to spread into `new Pool({ ... })`.
 */
export function createEntraPoolConfig(databaseUrl: string): EntraPoolConfig {
  const url = new URL(databaseUrl);

  return {
    host: url.hostname,
    port: parseInt(url.port || '5432', 10),
    database: url.pathname.replace(/^\//, ''), // strip leading '/'
    user: decodeURIComponent(url.username),
    password: getPostgresToken,
    ssl: { rejectUnauthorized: false }, // Azure PG always requires SSL
  };
}

/**
 * Clear the cached token. Useful for testing or when re-authenticating.
 */
export function clearTokenCache(): void {
  cachedToken = null;
  log.debug('Token cache cleared');
}
