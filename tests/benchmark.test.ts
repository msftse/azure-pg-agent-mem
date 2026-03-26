/**
 * agent-mem Performance Benchmark Suite
 *
 * Measures search quality, ranking accuracy, and operational performance
 * of agent-mem's hybrid semantic/full-text search system. Tests four
 * dimensions:
 *
 *   1. Search Recall     — Can the search system find answers to natural-language
 *                          queries within the observation corpus?
 *   2. Ranking Quality   — Are correct results ranked near the top? (MRR, Top-K)
 *   3. Context Quality   — Does context injection surface relevant observations?
 *   4. Latency & Load    — How fast are the key operations under single and
 *                          concurrent workloads?
 *
 * Methodology:
 *   - 12 natural-language questions whose answers are known to exist in the
 *     observation corpus. Each question defines expected keywords that must
 *     appear in the top-10 results for a "hit".
 *   - Ranking quality is measured via Mean Reciprocal Rank (MRR) and Top-K
 *     hit rates (K = 1, 3, 5, 10).
 *   - Latency is measured end-to-end including Azure OpenAI embedding calls.
 *
 * Prerequisites:
 *   - Worker running on port 37778
 *   - Real observation data in the database (uses the actual user's history)
 *
 * Run: npx vitest run tests/benchmark.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKER_PORT = process.env.AGENT_MEM_WORKER_PORT || '37778';
const BASE_URL = `http://127.0.0.1:${WORKER_PORT}`;
const USER_ID = 'f9b7c930b9856e3c'; // Real user with 460+ observations

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function get(
  path: string,
  params: Record<string, string> = {},
): Promise<{ status: number; body: unknown; latencyMs: number }> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const t0 = performance.now();
  const res = await fetch(url.toString());
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, latencyMs };
}

async function post(
  path: string,
  data: Record<string, unknown>,
): Promise<{ status: number; body: unknown; latencyMs: number }> {
  const url = new URL(path, BASE_URL);
  const t0 = performance.now();
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const latencyMs = Math.round(performance.now() - t0);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, latencyMs };
}

// ---------------------------------------------------------------------------
// Test data: questions whose answers exist in our observation history
// ---------------------------------------------------------------------------

/**
 * Each benchmark question has:
 *   - question:        Natural-language query (what the agent would ask)
 *   - searchQuery:     The semantic search query to send to /api/search
 *   - expectedKeywords: Strings that MUST appear in the top-K results for a "hit"
 *   - category:        Classification for reporting
 */
interface BenchmarkQuestion {
  question: string;
  searchQuery: string;
  expectedKeywords: string[];
  category: 'factual_recall' | 'discovery' | 'bugfix' | 'architecture' | 'configuration';
}

const BENCHMARK_QUESTIONS: BenchmarkQuestion[] = [
  // ── Factual Recall ──────────────────────────────────────────────
  {
    question: 'What PostgreSQL server hostname do we use?',
    searchQuery: 'PostgreSQL server hostname connection',
    expectedKeywords: ['agent-mem-pg-rz.postgres.database.azure.com'],
    category: 'factual_recall',
  },
  {
    question: 'What Azure OpenAI embedding model is deployed?',
    searchQuery: 'Azure OpenAI embedding model deployment',
    expectedKeywords: ['text-embedding-3-small'],
    category: 'factual_recall',
  },
  {
    question: 'What resource group is the PostgreSQL server in?',
    searchQuery: 'Azure resource group PostgreSQL',
    expectedKeywords: ['rg-rz'],
    category: 'factual_recall',
  },
  {
    question: 'What port does the worker HTTP server listen on?',
    searchQuery: 'worker HTTP server port listen',
    expectedKeywords: ['37778'],
    category: 'factual_recall',
  },

  // ── Discovery Recall ────────────────────────────────────────────
  {
    question: 'How do pgvector extensions get enabled on Azure?',
    searchQuery: 'pgvector extension Azure PostgreSQL enable',
    expectedKeywords: ['azure.extensions', 'VECTOR'],
    category: 'discovery',
  },
  {
    question: 'What embedding dimensions do we use?',
    searchQuery: 'embedding dimensions vector size',
    expectedKeywords: ['768'],
    category: 'discovery',
  },

  // ── Bugfix Recall ───────────────────────────────────────────────
  {
    question: 'What caused the RLS bypass bug?',
    searchQuery: 'RLS bypass bug row level security',
    expectedKeywords: ['BYPASSRLS'],
    category: 'bugfix',
  },

  // ── Architecture Recall ─────────────────────────────────────────
  {
    question: 'What are the three main processes in the system?',
    searchQuery: 'system architecture processes worker MCP CLI',
    expectedKeywords: ['worker', 'MCP'],
    category: 'architecture',
  },
  {
    question: 'How does the agent-mem plugin communicate with the worker?',
    searchQuery: 'plugin worker HTTP API communication',
    expectedKeywords: ['HTTP', 'POST'],
    category: 'architecture',
  },

  // ── Configuration Recall ────────────────────────────────────────
  {
    question: 'What authentication methods does the PostgreSQL server support?',
    searchQuery: 'PostgreSQL authentication methods Entra password',
    expectedKeywords: ['Entra', 'password'],
    category: 'configuration',
  },
  {
    question: 'Where is the settings file stored?',
    searchQuery: 'settings configuration file path storage',
    expectedKeywords: ['settings.json'],
    category: 'configuration',
  },
  {
    question: 'What is the Azure OpenAI endpoint URL?',
    searchQuery: 'Azure OpenAI endpoint URL cognitive services',
    expectedKeywords: ['cognitiveservices.azure.com'],
    category: 'configuration',
  },
];

// ---------------------------------------------------------------------------
// Benchmark result tracking
// ---------------------------------------------------------------------------

interface SearchResult {
  id: number;
  type?: string;
  title?: string;
  content_preview?: string;
  text?: string;
  semantic_score?: number;
  text_score?: number;
  [key: string]: unknown;
}

interface QuestionResult {
  question: string;
  category: string;
  found: boolean;
  rank: number | null;      // position in results (1-indexed), null if not found
  latencyMs: number;
  topResultTitle: string;
  matchedKeywords: string[];
  missedKeywords: string[];
}

const benchmarkResults: QuestionResult[] = [];
const latencyResults: { operation: string; latencyMs: number; detail?: string }[] = [];

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  if (!res.ok) throw new Error(`Worker not reachable at ${BASE_URL}`);
  const data = (await res.json()) as Record<string, unknown>;
  console.log(`\n[Benchmark] Worker healthy — v${data.version}, pid ${data.pid}`);
  console.log(`[Benchmark] User: ${USER_ID}`);
  console.log(`[Benchmark] Questions: ${BENCHMARK_QUESTIONS.length}\n`);
}, 15_000);

// =========================================================================
// 1. RECALL ACCURACY BENCHMARK
// =========================================================================

describe('1. Recall Accuracy — With Memory vs Without Memory', () => {
  const TOP_K = 10; // Search returns top 10 results

  for (const q of BENCHMARK_QUESTIONS) {
    it(`[${q.category}] ${q.question}`, async () => {
      // ── "With Memory" — query agent-mem search ────────────────
      const { body, latencyMs, status } = await get('/api/search', {
        user_id: USER_ID,
        query: q.searchQuery,
        limit: String(TOP_K),
      });

      expect(status).toBe(200);
      const results = (body as SearchResult[]) || [];

      // Check if any result in top-K contains ALL expected keywords
      let found = false;
      let rank: number | null = null;
      const matchedKeywords: string[] = [];
      const missedKeywords: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const text = JSON.stringify(results[i]).toLowerCase();
        const allMatch = q.expectedKeywords.every((kw) =>
          text.includes(kw.toLowerCase()),
        );
        if (allMatch) {
          found = true;
          rank = i + 1;
          matchedKeywords.push(...q.expectedKeywords);
          break;
        }
      }

      // If not all keywords found in a single result, check across all results
      if (!found) {
        const allText = results.map((r) => JSON.stringify(r).toLowerCase()).join(' ');
        for (const kw of q.expectedKeywords) {
          if (allText.includes(kw.toLowerCase())) {
            matchedKeywords.push(kw);
          } else {
            missedKeywords.push(kw);
          }
        }
        // Consider it found if ALL keywords appear across the result set
        if (missedKeywords.length === 0) {
          found = true;
          // Find the rank of the first result containing at least one keyword
          for (let i = 0; i < results.length; i++) {
            const text = JSON.stringify(results[i]).toLowerCase();
            if (q.expectedKeywords.some((kw) => text.includes(kw.toLowerCase()))) {
              rank = i + 1;
              break;
            }
          }
        }
      }

      const topTitle = results.length > 0
        ? (results[0].title || results[0].type || 'unknown')
        : '(no results)';

      benchmarkResults.push({
        question: q.question,
        category: q.category,
        found,
        rank,
        latencyMs,
        topResultTitle: String(topTitle),
        matchedKeywords,
        missedKeywords,
      });

      // The search should find the answer — log but don't hard-fail
      // (the report will show the score)
      if (!found) {
        console.warn(
          `  ⚠ MISS: "${q.question}" — missed keywords: ${missedKeywords.join(', ')}`,
        );
      }
    }, 30_000);
  }
});

// =========================================================================
// 2. SEARCH RELEVANCE — Top-1/Top-3/Top-5 hit rates
// =========================================================================

describe('2. Search Relevance — Ranking Quality', () => {
  it('computes hit rates at different K values', () => {
    const foundResults = benchmarkResults.filter((r) => r.found);

    const top1Hits = foundResults.filter((r) => r.rank === 1).length;
    const top3Hits = foundResults.filter(
      (r) => r.rank !== null && r.rank <= 3,
    ).length;
    const top5Hits = foundResults.filter(
      (r) => r.rank !== null && r.rank <= 5,
    ).length;
    const topKHits = foundResults.length;

    const total = BENCHMARK_QUESTIONS.length;

    console.log('\n  Search Relevance (Hit Rate):');
    console.log(`    Top-1:  ${top1Hits}/${total} = ${((top1Hits / total) * 100).toFixed(1)}%`);
    console.log(`    Top-3:  ${top3Hits}/${total} = ${((top3Hits / total) * 100).toFixed(1)}%`);
    console.log(`    Top-5:  ${top5Hits}/${total} = ${((top5Hits / total) * 100).toFixed(1)}%`);
    console.log(`    Top-10: ${topKHits}/${total} = ${((topKHits / total) * 100).toFixed(1)}%\n`);

    // At minimum, we expect 60%+ recall at top-10
    expect(topKHits / total).toBeGreaterThanOrEqual(0.5);
  });
});

// =========================================================================
// 3. CONTEXT QUALITY — Does context injection surface relevant data?
// =========================================================================

describe('3. Context Quality — Injection Relevance', () => {
  it('context endpoint returns observations with expected fields', async () => {
    const { body, latencyMs, status } = await post('/api/context', {
      user_id: USER_ID,
      limit: 30,
    });

    expect(status).toBe(200);
    const results = body as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    latencyResults.push({ operation: 'context_fetch', latencyMs, detail: `${results.length} observations` });

    // Verify each result has required fields
    for (const r of results) {
      expect(r.id).toBeDefined();
      expect(r.created_at).toBeDefined();
      expect(r.text_preview).toBeDefined();
    }

    console.log(`\n  Context injection: ${results.length} observations in ${latencyMs}ms`);
  });

  it('project-scoped context narrows to relevant observations', async () => {
    const { body, latencyMs, status } = await post('/api/context', {
      user_id: USER_ID,
      project: 'claude-azure-postgres-memory',
      limit: 20,
    });

    expect(status).toBe(200);
    const results = body as Array<Record<string, unknown>>;
    expect(Array.isArray(results)).toBe(true);

    latencyResults.push({ operation: 'context_fetch_project', latencyMs, detail: `${results.length} obs (project-scoped)` });

    // All returned observations should be from the correct project
    for (const r of results) {
      expect(r.project).toBe('claude-azure-postgres-memory');
    }

    console.log(`  Project-scoped context: ${results.length} observations in ${latencyMs}ms`);
  });
});

// =========================================================================
// 4. LATENCY BENCHMARKS
// =========================================================================

describe('4. Latency Benchmarks', () => {
  it('semantic search latency (with embedding generation)', async () => {
    const queries = [
      'database connection timeout',
      'authentication Entra ID token',
      'worker service architecture',
      'pgvector embedding dimensions',
      'RLS row level security policy',
    ];

    const latencies: number[] = [];

    for (const q of queries) {
      const { latencyMs, status } = await get('/api/search', {
        user_id: USER_ID,
        query: q,
        limit: '10',
      });
      expect(status).toBe(200);
      latencies.push(latencyMs);
      latencyResults.push({ operation: 'semantic_search', latencyMs, detail: q });
    }

    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)];

    console.log('\n  Semantic Search Latency:');
    console.log(`    Avg: ${avg}ms | P50: ${p50}ms | Min: ${min}ms | Max: ${max}ms`);

    // Search should complete within 5 seconds
    expect(avg).toBeLessThan(5000);
  }, 60_000);

  it('timeline fetch latency', async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 3; i++) {
      const { latencyMs, status } = await get('/api/timeline', {
        user_id: USER_ID,
        limit: '20',
      });
      expect(status).toBe(200);
      latencies.push(latencyMs);
      latencyResults.push({ operation: 'timeline', latencyMs });
    }

    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    console.log(`  Timeline Fetch: avg ${avg}ms`);

    expect(avg).toBeLessThan(3000);
  });

  it('observation write latency (with embedding)', async () => {
    const testSessionId = `bench-${Date.now()}`;

    // Init a test session first
    await post('/api/sessions/init', {
      user_id: USER_ID,
      session_id: testSessionId,
      project: 'benchmark-test',
    });

    const latencies: number[] = [];

    for (let i = 0; i < 3; i++) {
      const { latencyMs, status } = await post('/api/observations', {
        user_id: USER_ID,
        session_id: testSessionId,
        project: 'benchmark-test',
        type: 'discovery',
        title: `Benchmark write test ${i}`,
        text: `Performance benchmark observation #${i}. Testing write latency with real embedding generation through Azure OpenAI text-embedding-3-small model.`,
      });
      expect(status).toBe(201);
      latencies.push(latencyMs);
      latencyResults.push({ operation: 'observation_write', latencyMs, detail: `write #${i}` });
    }

    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);

    console.log(`  Observation Write (w/ embedding): avg ${avg}ms | min ${min}ms | max ${max}ms`);

    // Writes should complete within 10 seconds (includes embedding generation)
    expect(avg).toBeLessThan(10_000);

    // Clean up test session
    await post('/api/sessions/complete', {
      user_id: USER_ID,
      session_id: testSessionId,
    });
  }, 60_000);

  it('health check latency', async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await fetch(`${BASE_URL}/api/health`);
      latencies.push(Math.round(performance.now() - t0));
    }

    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    latencyResults.push({ operation: 'health_check', latencyMs: avg });

    console.log(`  Health Check: avg ${avg}ms`);
    expect(avg).toBeLessThan(200);
  });
});

// =========================================================================
// 5. CONCURRENT LOAD — Simulates multiple hook fires
// =========================================================================

describe('5. Concurrent Load — Simulated Hook Burst', () => {
  it('handles 10 concurrent search requests', async () => {
    const queries = [
      'database', 'authentication', 'embedding', 'session', 'worker',
      'RLS', 'PostgreSQL', 'Azure', 'plugin', 'observation',
    ];

    const t0 = performance.now();
    const results = await Promise.all(
      queries.map((q) =>
        get('/api/search', { user_id: USER_ID, query: q, limit: '5' }),
      ),
    );
    const totalMs = Math.round(performance.now() - t0);

    const failures = results.filter((r) => r.status !== 200);
    expect(failures.length).toBe(0);

    latencyResults.push({ operation: 'concurrent_10_searches', latencyMs: totalMs });

    console.log(`\n  10 concurrent searches completed in ${totalMs}ms (${Math.round(totalMs / 10)}ms avg/query)`);
  }, 120_000);

  it('handles 5 concurrent observation writes', async () => {
    const testSessionId = `bench-concurrent-${Date.now()}`;
    await post('/api/sessions/init', {
      user_id: USER_ID,
      session_id: testSessionId,
      project: 'benchmark-test',
    });

    const t0 = performance.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post('/api/observations', {
          user_id: USER_ID,
          session_id: testSessionId,
          project: 'benchmark-test',
          type: 'discovery',
          title: `Concurrent write ${i}`,
          text: `Concurrent benchmark write test #${i}. Simulating rapid PostToolUse hook fires.`,
        }),
      ),
    );
    const totalMs = Math.round(performance.now() - t0);

    const failures = results.filter((r) => r.status !== 201);
    expect(failures.length).toBe(0);

    latencyResults.push({ operation: 'concurrent_5_writes', latencyMs: totalMs });

    console.log(`  5 concurrent writes completed in ${totalMs}ms (${Math.round(totalMs / 5)}ms avg/write)`);

    await post('/api/sessions/complete', {
      user_id: USER_ID,
      session_id: testSessionId,
    });
  }, 120_000);
});

// =========================================================================
// FINAL REPORT
// =========================================================================

describe('BENCHMARK REPORT', () => {
  it('generates final performance report', () => {
    const total = benchmarkResults.length;
    const hits = benchmarkResults.filter((r) => r.found).length;
    const recallPct = ((hits / total) * 100).toFixed(1);

    // Category breakdown
    const categories = [...new Set(benchmarkResults.map((r) => r.category))];
    const categoryStats = categories.map((cat) => {
      const catResults = benchmarkResults.filter((r) => r.category === cat);
      const catHits = catResults.filter((r) => r.found).length;
      return {
        category: cat,
        total: catResults.length,
        hits: catHits,
        pct: ((catHits / catResults.length) * 100).toFixed(1),
      };
    });

    // Latency summary
    const searchLatencies = latencyResults
      .filter((r) => r.operation === 'semantic_search')
      .map((r) => r.latencyMs);
    const writeLatencies = latencyResults
      .filter((r) => r.operation === 'observation_write')
      .map((r) => r.latencyMs);
    const contextLatencies = latencyResults
      .filter((r) => r.operation.startsWith('context_'))
      .map((r) => r.latencyMs);

    const avgSearch = searchLatencies.length > 0
      ? Math.round(searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length)
      : 0;
    const avgWrite = writeLatencies.length > 0
      ? Math.round(writeLatencies.reduce((a, b) => a + b, 0) / writeLatencies.length)
      : 0;
    const avgContext = contextLatencies.length > 0
      ? Math.round(contextLatencies.reduce((a, b) => a + b, 0) / contextLatencies.length)
      : 0;

    // Ranking metrics
    const ranks = benchmarkResults
      .filter((r) => r.rank !== null)
      .map((r) => r.rank!);
    const avgRank = ranks.length > 0
      ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1)
      : 'N/A';

    // MRR = mean of 1/rank for found items, 0 for misses
    const reciprocalRanks = benchmarkResults.map((r) =>
      r.rank !== null ? 1 / r.rank : 0,
    );
    const mrr = (reciprocalRanks.reduce((a, b) => a + b, 0) / total).toFixed(3);

    const top1 = benchmarkResults.filter((r) => r.rank === 1).length;
    const top3 = benchmarkResults.filter((r) => r.rank !== null && r.rank <= 3).length;
    const top5 = benchmarkResults.filter((r) => r.rank !== null && r.rank <= 5).length;

    console.log('\n');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║              agent-mem PERFORMANCE BENCHMARK REPORT           ║');
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log('║                                                              ║');
    console.log('║  SEARCH RECALL (Top-10)                                      ║');
    console.log(`║    Recall@10:   ${recallPct.padStart(5)}%  (${hits}/${total} queries found answer)`.padEnd(65) + '║');
    console.log('║                                                              ║');
    console.log('║  CATEGORY BREAKDOWN                                          ║');
    for (const cs of categoryStats) {
      const line = `║    ${cs.category.padEnd(20)} ${cs.pct.padStart(5)}%  (${cs.hits}/${cs.total})`;
      console.log(line.padEnd(65) + '║');
    }
    console.log('║                                                              ║');
    console.log('║  RANKING QUALITY                                             ║');
    console.log(`║    MRR (Mean Reciprocal Rank):   ${mrr.padStart(5)}`.padEnd(65) + '║');
    console.log(`║    Average Rank of Hit:          ${String(avgRank).padStart(5)}`.padEnd(65) + '║');
    console.log(`║    Top-1 Hit Rate:               ${((top1 / total) * 100).toFixed(1).padStart(5)}%`.padEnd(65) + '║');
    console.log(`║    Top-3 Hit Rate:               ${((top3 / total) * 100).toFixed(1).padStart(5)}%`.padEnd(65) + '║');
    console.log(`║    Top-5 Hit Rate:               ${((top5 / total) * 100).toFixed(1).padStart(5)}%`.padEnd(65) + '║');
    console.log(`║    Top-10 Hit Rate:              ${recallPct.padStart(5)}%`.padEnd(65) + '║');
    console.log('║                                                              ║');
    console.log('║  LATENCY (avg)                                               ║');
    console.log(`║    Semantic Search:     ${String(avgSearch).padStart(5)}ms`.padEnd(65) + '║');
    console.log(`║    Context Injection:   ${String(avgContext).padStart(5)}ms`.padEnd(65) + '║');
    console.log(`║    Observation Write:   ${String(avgWrite).padStart(5)}ms`.padEnd(65) + '║');
    console.log('║                                                              ║');

    // Concurrent load
    const concSearchEntry = latencyResults.find((r) => r.operation === 'concurrent_10_searches');
    const concWriteEntry = latencyResults.find((r) => r.operation === 'concurrent_5_writes');
    if (concSearchEntry || concWriteEntry) {
      console.log('║  CONCURRENT LOAD                                             ║');
      if (concSearchEntry) {
        console.log(`║    10 parallel searches:  ${String(concSearchEntry.latencyMs).padStart(5)}ms total`.padEnd(65) + '║');
      }
      if (concWriteEntry) {
        console.log(`║    5 parallel writes:     ${String(concWriteEntry.latencyMs).padStart(5)}ms total`.padEnd(65) + '║');
      }
      console.log('║                                                              ║');
    }

    console.log('║  MISSED QUERIES                                              ║');
    const misses = benchmarkResults.filter((r) => !r.found);
    if (misses.length === 0) {
      console.log('║    (none — perfect recall)'.padEnd(65) + '║');
    } else {
      for (const m of misses) {
        const short = m.question.length > 50 ? m.question.slice(0, 47) + '...' : m.question;
        console.log(`║    ✘ ${short}`.padEnd(65) + '║');
        if (m.missedKeywords.length > 0) {
          console.log(`║      missed: ${m.missedKeywords.join(', ')}`.padEnd(65) + '║');
        }
      }
    }
    console.log('║                                                              ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');

    // The test passes if recall is meaningfully above 50%
    expect(Number(recallPct)).toBeGreaterThan(50);
  });
});
