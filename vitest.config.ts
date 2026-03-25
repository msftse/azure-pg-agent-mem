import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // E2E tests hit a live Azure PostgreSQL + Azure OpenAI embeddings API.
    // Individual operations (embedding generation, DB round-trips via RLS
    // transactions) routinely take 2-10s, so we need generous timeouts.
    testTimeout: 60_000,
    hookTimeout: 30_000,

    // Run tests sequentially — the E2E suite has ordered dependencies
    // (session init → observations → search → timeline → completion).
    sequence: {
      concurrent: false,
    },
  },
});
