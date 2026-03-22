/**
 * Configurable embedding providers for claude-azure-pg-mem.
 *
 * Supported providers:
 *   - 'nomic'        – Local Nomic Embed Text v1 via @huggingface/transformers (768-dim, no API key)
 *   - 'azure_openai' – Azure OpenAI Embeddings API (text-embedding-3-small/large, configurable dim)
 *   - 'noop'         – Zero vector (testing / offline)
 *
 * Configuration via settings / env vars:
 *   AGENT_MEM_EMBEDDING_PROVIDER            – 'nomic' (default) | 'azure_openai'
 *   AGENT_MEM_EMBEDDING_DIMENSIONS          – target vector size (default: 768)
 *   AGENT_MEM_AZURE_OPENAI_ENDPOINT         – e.g. https://<resource>.openai.azure.com
 *   AGENT_MEM_AZURE_OPENAI_API_KEY          – API key (optional — if omitted, uses Entra ID / AAD)
 *   AGENT_MEM_AZURE_OPENAI_EMBEDDING_DEPLOYMENT – deployment name
 *   AGENT_MEM_AZURE_OPENAI_API_VERSION      – API version (default: 2024-06-01)
 *
 * Authentication priority for Azure OpenAI:
 *   1. If AZURE_OPENAI_API_KEY is set, uses API key auth (api-key header)
 *   2. Otherwise, uses DefaultAzureCredential (Entra ID / AAD bearer token)
 *      — works with Azure CLI login, managed identity, env vars, etc.
 *
 * The DB column is vector(768). When using Azure OpenAI with models that natively
 * produce 1536-dim (text-embedding-3-small) or 3072-dim (text-embedding-3-large),
 * we pass `dimensions: 768` in the API request so the model truncates output to
 * match the DB schema — no column migration needed.
 */

import { logger } from '../shared/logger.js';
import { getSetting } from '../shared/settings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Signature for any embedding function used throughout the system. */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Metadata about the active embedding provider. */
export interface EmbedderInfo {
  provider: string;
  dimensions: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log = logger.child('Embeddings');

// ---------------------------------------------------------------------------
// Nomic Embed Text v1 (local, default)
// ---------------------------------------------------------------------------

/** HuggingFace model identifier for Nomic. */
const NOMIC_MODEL_ID = 'nomic-ai/nomic-embed-text-v1';
const NOMIC_DIM = 768;

/**
 * Create an embedding function backed by Nomic Embed Text v1 (local inference).
 *
 * The HuggingFace transformers pipeline is lazily initialised on first call.
 * Subsequent calls reuse the cached pipeline. Produces 768-dim vectors.
 */
export function createNomicEmbedder(): EmbedFn {
  let pipelineInstance: ReturnType<typeof createPipelinePromise> | null = null;

  async function createPipelinePromise() {
    log.info('Loading local embedding model…', { model: NOMIC_MODEL_ID });
    const { pipeline } = await import('@huggingface/transformers');
    const extractor = await pipeline('feature-extraction', NOMIC_MODEL_ID, {
      dtype: 'fp32',
    });
    log.info('Local embedding model loaded', { model: NOMIC_MODEL_ID, dim: NOMIC_DIM });
    return extractor;
  }

  return async (text: string): Promise<number[]> => {
    if (!pipelineInstance) {
      pipelineInstance = createPipelinePromise();
    }

    const extractor = await pipelineInstance;
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(result.data as Float32Array).slice(0, NOMIC_DIM);

    if (vector.length !== NOMIC_DIM) {
      log.warn('Unexpected Nomic embedding dimension', {
        expected: NOMIC_DIM,
        got: vector.length,
      });
    }

    return vector;
  };
}

// ---------------------------------------------------------------------------
// Azure OpenAI Embeddings
// ---------------------------------------------------------------------------

/** Scope required for Azure OpenAI / Cognitive Services tokens. */
const AZURE_COGNITIVESERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

/**
 * Helper: create a function that returns an auth header for Azure OpenAI.
 *
 * If an API key is provided, returns `{ 'api-key': key }` (static).
 * Otherwise, uses DefaultAzureCredential to obtain a bearer token and
 * caches it, refreshing 5 minutes before expiry.
 */
function createAuthHeaderProvider(
  apiKey: string | undefined,
): () => Promise<Record<string, string>> {
  if (apiKey) {
    const headers = { 'api-key': apiKey };
    return async () => headers;
  }

  // AAD / Entra ID token auth via DefaultAzureCredential.
  let cachedToken: { token: string; expiresOnTimestamp: number } | null = null;
  const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

  return async () => {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresOnTimestamp - now > REFRESH_MARGIN_MS) {
      return { Authorization: `Bearer ${cachedToken.token}` };
    }

    // Lazily import to avoid pulling in the SDK when using API key or Nomic.
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential();
    const accessToken = await credential.getToken(AZURE_COGNITIVESERVICES_SCOPE);

    if (!accessToken) {
      throw new Error(
        'Failed to obtain Entra ID token for Azure Cognitive Services. ' +
          'Ensure you are logged in (az login) or have a valid managed identity.',
      );
    }

    cachedToken = {
      token: accessToken.token,
      expiresOnTimestamp: accessToken.expiresOnTimestamp,
    };
    log.info('Azure AD token acquired for Cognitive Services', {
      expiresIn: Math.round((accessToken.expiresOnTimestamp - now) / 1000) + 's',
    });

    return { Authorization: `Bearer ${cachedToken.token}` };
  };
}

/**
 * Create an embedding function backed by Azure OpenAI Embeddings API.
 *
 * Uses a plain HTTPS fetch — no SDK dependency required. The `dimensions`
 * parameter is sent in the request body so models like text-embedding-3-small
 * (natively 1536-dim) truncate their output to match the DB column width.
 *
 * Authentication:
 *   - If `apiKey` is provided, uses API key auth (api-key header).
 *   - If `apiKey` is undefined/empty, uses DefaultAzureCredential (Entra ID)
 *     for bearer token auth. Tokens are cached and refreshed automatically.
 *
 * @param endpoint    - Azure OpenAI endpoint URL
 * @param apiKey      - API key (optional — omit for AAD auth)
 * @param deployment  - Deployment/model name
 * @param dimensions  - Desired output dimensionality (default: 768)
 * @param apiVersion  - API version string
 */
export function createAzureOpenAIEmbedder(
  endpoint: string,
  apiKey: string | undefined,
  deployment: string,
  dimensions: number = 768,
  apiVersion: string = '2024-06-01',
): EmbedFn {
  // Normalise endpoint: strip trailing slash.
  const baseUrl = endpoint.replace(/\/+$/, '');
  const url = `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${apiVersion}`;

  const authMode = apiKey ? 'api-key' : 'entra-id';
  const getAuthHeaders = createAuthHeaderProvider(apiKey);

  log.info('Azure OpenAI embedder configured', {
    endpoint: baseUrl,
    deployment,
    dimensions,
    apiVersion,
    authMode,
  });

  return async (text: string): Promise<number[]> => {
    const body = JSON.stringify({
      input: text,
      dimensions,
    });

    const authHeaders = await getAuthHeaders();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '(no body)');
      throw new Error(
        `Azure OpenAI embeddings request failed: ${response.status} ${response.statusText} – ${errBody}`,
      );
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    if (!json.data?.[0]?.embedding) {
      throw new Error('Azure OpenAI response missing embedding data');
    }

    const vector = json.data[0].embedding;

    if (vector.length !== dimensions) {
      log.warn('Azure OpenAI embedding dimension mismatch', {
        expected: dimensions,
        got: vector.length,
      });
    }

    return vector;
  };
}

// ---------------------------------------------------------------------------
// No-op embedder (testing / offline fallback)
// ---------------------------------------------------------------------------

/**
 * Return an embedding function that always produces a zero vector.
 * Useful in tests or when no embedding provider is available.
 */
export function noopEmbedder(dimensions: number = 768): EmbedFn {
  const zeroVector = new Array<number>(dimensions).fill(0);
  return async (_text: string): Promise<number[]> => zeroVector;
}

// ---------------------------------------------------------------------------
// Factory: create embedder from settings
// ---------------------------------------------------------------------------

/**
 * Create the appropriate embedder based on the current settings / env vars.
 *
 * Resolution:
 *   1. Read EMBEDDING_PROVIDER from settings (default: 'nomic')
 *   2. For 'azure_openai', validate required config and build the Azure embedder
 *   3. For 'nomic', return the local Nomic embedder
 *   4. On any failure, fall back to noopEmbedder with a warning
 *
 * @returns An object with `embed` (the EmbedFn) and `info` (metadata).
 */
export function createEmbedder(): { embed: EmbedFn; info: EmbedderInfo } {
  const provider = getSetting('EMBEDDING_PROVIDER').toLowerCase() || 'nomic';
  const dimensions = parseInt(getSetting('EMBEDDING_DIMENSIONS') || '768', 10);

  if (provider === 'azure_openai') {
    const endpoint = getSetting('AZURE_OPENAI_ENDPOINT');
    const apiKey = getSetting('AZURE_OPENAI_API_KEY') || undefined; // undefined = use AAD
    const deployment = getSetting('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
    const apiVersion = getSetting('AZURE_OPENAI_API_VERSION') || '2024-06-01';

    if (!endpoint || !deployment) {
      const missing: string[] = [];
      if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
      if (!deployment) missing.push('AZURE_OPENAI_EMBEDDING_DEPLOYMENT');

      log.error(
        `Azure OpenAI embedder selected but missing required settings: ${missing.join(', ')}. ` +
          'Falling back to no-op embedder. ' +
          '(AZURE_OPENAI_API_KEY is optional — omit it for Entra ID / AAD auth.)',
      );
      return {
        embed: noopEmbedder(dimensions),
        info: { provider: 'noop', dimensions, model: 'none (misconfigured azure_openai)' },
      };
    }

    try {
      const embed = createAzureOpenAIEmbedder(endpoint, apiKey, deployment, dimensions, apiVersion);
      return {
        embed,
        info: { provider: 'azure_openai', dimensions, model: deployment },
      };
    } catch (err) {
      log.error('Failed to create Azure OpenAI embedder – falling back to no-op', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        embed: noopEmbedder(dimensions),
        info: { provider: 'noop', dimensions, model: 'none (azure_openai init failed)' },
      };
    }
  }

  if (provider === 'noop') {
    log.info('No-op embedder selected');
    return {
      embed: noopEmbedder(dimensions),
      info: { provider: 'noop', dimensions, model: 'none' },
    };
  }

  // Default: Nomic (local).
  if (provider !== 'nomic') {
    log.warn(`Unknown embedding provider "${provider}" – defaulting to nomic`);
  }

  try {
    const embed = createNomicEmbedder();
    return {
      embed,
      info: { provider: 'nomic', dimensions: NOMIC_DIM, model: NOMIC_MODEL_ID },
    };
  } catch (err) {
    log.warn('Failed to initialise Nomic embedder – falling back to no-op', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      embed: noopEmbedder(dimensions),
      info: { provider: 'noop', dimensions, model: 'none (nomic init failed)' },
    };
  }
}
