# Agent Memory: Persistent Memory System

You have persistent memory across sessions via agent-mem (Azure Postgres + pgvector).

## Memory Tools (MCP)

Use the 3-layer progressive disclosure pattern to efficiently search past work:

1. **search** - Find observations by query, project, type, date (~50-100 tokens/result)
2. **timeline** - Get chronological context around an observation (~200-500 tokens)
3. **get_observations** - Full details for specific IDs (~500-1000 tokens/result)

ALWAYS start with search, then narrow with timeline, then fetch full details. Never skip layers.

## What Gets Saved

- Tool executions (file edits, commands, searches) are automatically observed
- Session summaries are generated when you stop
- Trivial operations (ls, pwd) are filtered out

## Privacy

Content wrapped in `<private>...</private>` tags is stripped before storage.
Each user's memory is isolated - you can only access your own observations.
