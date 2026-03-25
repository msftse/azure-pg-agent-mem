<p align="center">
  <img src="assets/azure-logo.svg" alt="Microsoft Azure" height="64" />
  &nbsp;&nbsp;&nbsp;
  <img src="assets/postgresql-logo.svg" alt="PostgreSQL" height="64" />
  &nbsp;&nbsp;&nbsp;
  <img src="assets/pgvector-logo.svg" alt="pgvector" height="40" />
</p>

<p align="center">
  <em>Works with</em>
</p>

<p align="center">
  <img src="assets/opencode-logo.svg" alt="OpenCode" height="28" />
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/claude-logo.svg" alt="Claude Code" height="28" />
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/github-copilot-logo.svg" alt="GitHub Copilot" height="28" />
</p>

<h1 align="center">Azure PostgreSQL Agent Memory</h1>

<p align="center">
  Multi-tenant persistent memory for AI coding agents, backed by Azure PostgreSQL Flexible Server with pgvector.
</p>

<p align="center">
  <a href="https://github.com/msftse/azure-pg-agent-mem/releases"><img src="https://img.shields.io/github/v/release/msftse/azure-pg-agent-mem?style=flat-square&label=release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/msftse/azure-pg-agent-mem?style=flat-square" alt="License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square" alt="TypeScript" /></a>
  <a href="https://learn.microsoft.com/azure/postgresql/"><img src="https://img.shields.io/badge/Azure-PostgreSQL%20Flexible%20Server-0078D4?style=flat-square&logo=microsoft-azure" alt="Azure PostgreSQL" /></a>
</p>

---

## Overview

Azure PostgreSQL Agent Memory captures tool usage observations from AI coding agent sessions, generates semantic summaries, and makes them searchable across sessions, projects, and machines. It is designed for teams where multiple engineers share a single Azure PostgreSQL instance, with each user's data isolated via **Row Level Security (RLS)**.

### Supported Agents

| Agent | Integration | Auto-Capture |
|-------|-------------|-------------|
| [OpenCode](https://opencode.ai) | MCP server + Plugin | Tool calls, session lifecycle |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | MCP server + Hooks | Tool calls, session lifecycle |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot) | MCP server | Manual search only |

### Key Features

- **Hybrid search** — pgvector semantic similarity + PostgreSQL full-text search (tsvector), combined with configurable ranking
- **Multi-tenant Row Level Security** — every table has a `user_id` column enforced by PostgreSQL RLS policies; users cannot access each other's data even when sharing the same database
- **Configurable embeddings** — local [Nomic Embed Text v1](https://huggingface.co/nomic-ai/nomic-embed-text-v1) (768-dim, no API key) or [Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/concepts/models#embeddings) with Entra ID or API key authentication
- **Progressive disclosure** — 3-layer MCP tool design (search, timeline, get_observations) that minimizes token usage by 10x compared to fetching full details upfront
- **One-command provisioning** — `db provision` creates the Azure PostgreSQL server, enables pgvector, pushes the schema, and saves the connection string
- **Session lifecycle tracking** — automatic session creation, observation recording, completion, and summarization

## Architecture

```
Coding Agent (OpenCode / Claude Code / Copilot CLI)

  ┌──────────────┐    ┌──────────────────┐
  │  MCP Server  │───>│     Worker       │
  │  (stdio)     │    │  (HTTP :37778)   │
  │  3 tools     │    │  Express API     │
  └──────────────┘    └────────┬─────────┘
                               │ withUserContext()
                               │ set_config('app.user_id', ...)
                        ┌──────▼──────────┐
                        │ Azure PostgreSQL│
                        │ Flexible Server │
                        │ + pgvector      │
                        │ + RLS           │
                        └─────────────────┘
```

**MCP Tools** (progressive disclosure):
1. **`search`** — lightweight results (~50-100 tokens each)
2. **`timeline`** — session timelines (~200-500 tokens)
3. **`get_observations`** — full observation details (~500-1000 tokens each)

## Prerequisites

- **Node.js 22+** — [Download](https://nodejs.org)
- **Azure CLI** (`az`) — [Install](https://learn.microsoft.com/cli/azure/install-azure-cli) and run `az login`
- **Azure subscription** — [Free account](https://azure.microsoft.com/free) works (B1ms PostgreSQL is free for 12 months)

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/msftse/azure-pg-agent-mem.git
cd azure-pg-agent-mem
npm install
```

### 2. Provision the database

One command creates the Azure PostgreSQL server, enables pgvector, creates the database, adds firewall rules, saves `DATABASE_URL`, and pushes the schema:

```bash
npx tsx src/index.ts db provision
```

Defaults: B1ms SKU, eastus region, PostgreSQL 16. Customize with flags:

```bash
npx tsx src/index.ts db provision \
  --name my-agent-mem-pg \
  --resource-group rg-my-team \
  --location westus3 \
  --admin-user myadmin \
  --sku Standard_B2s
```

| Flag | Default | Description |
|------|---------|-------------|
| `--name` | `agent-mem-pg-<random>` | Server name (globally unique) |
| `--resource-group`, `--rg` | `rg-agent-mem` | Resource group (created if needed) |
| `--location`, `--loc` | `eastus` | Azure region |
| `--admin-user` | `agentmemadmin` | Admin username |
| `--admin-password` | (auto-generated) | Admin password |
| `--sku` | `Standard_B1ms` | PostgreSQL SKU |
| `--database`, `--db` | `agent_memory` | Database name |
| `--no-push` | — | Skip schema push |

<details>
<summary>Manual setup (use an existing Azure PostgreSQL server)</summary>

```bash
# Option A: Environment variable
export DATABASE_URL="postgres://user:password@your-server.postgres.database.azure.com:5432/agent_memory?sslmode=require"

# Option B: Persistent setting (stored in ~/.agent-mem/settings.json)
npx tsx src/index.ts config set DATABASE_URL "postgres://user:password@your-server.postgres.database.azure.com:5432/agent_memory?sslmode=require"
```

Enable pgvector on your server:

```bash
az postgres flexible-server parameter set \
  --resource-group <rg> --server-name <server> \
  --name azure.extensions --value VECTOR
```

Push the schema:

```bash
npx tsx src/index.ts db push
```

</details>

### 3. Verify the connection

```bash
npx tsx src/index.ts db status
```

### 4. Start the worker daemon

```bash
npx tsx src/index.ts start
```

### 5. Install for your coding agent

#### OpenCode

**a) MCP server** — provides memory search tools to the agent:

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "agent-mem": {
      "type": "local",
      "command": ["npx", "tsx", "<path-to-repo>/src/servers/mcp-server.ts"],
      "enabled": true
    }
  }
}
```

**b) Plugin** — auto-captures observations from every tool call:

```bash
mkdir -p ~/.config/opencode/plugins
cp plugin/opencode/agent-mem.ts ~/.config/opencode/plugins/agent-mem.ts
```

Restart OpenCode for the plugin to take effect.

#### Claude Code

```bash
npx tsx src/index.ts install
```

This registers hooks for session lifecycle, the MCP server for search tools, and the `mem-search` skill.

## Configuration

All settings can be set via environment variables (prefixed with `AGENT_MEM_`) or through the CLI:

```bash
npx tsx src/index.ts config set <KEY> <value>
npx tsx src/index.ts config get <KEY>
npx tsx src/index.ts config list
```

Settings are stored in `~/.agent-mem/settings.json`.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `DATABASE_URL` | `DATABASE_URL` | — | Azure PostgreSQL connection string |
| `WORKER_PORT` | `AGENT_MEM_WORKER_PORT` | `37778` | Worker HTTP port |
| `WORKER_HOST` | `AGENT_MEM_WORKER_HOST` | `127.0.0.1` | Worker bind address |
| `LOG_LEVEL` | `AGENT_MEM_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARN, ERROR) |
| `USER_ID` | `AGENT_MEM_USER_ID` | auto | User ID for RLS (auto = SHA-256 of `user@hostname`) |

### Embedding Providers

By default, embeddings are generated locally using **Nomic Embed Text v1** (768 dimensions, no API key needed). You can switch to **Azure OpenAI** for higher quality.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `EMBEDDING_PROVIDER` | `AGENT_MEM_EMBEDDING_PROVIDER` | `nomic` | `nomic`, `azure_openai`, or `noop` |
| `EMBEDDING_DIMENSIONS` | `AGENT_MEM_EMBEDDING_DIMENSIONS` | `768` | Must match DB vector(N) column |
| `AZURE_OPENAI_ENDPOINT` | `AGENT_MEM_AZURE_OPENAI_ENDPOINT` | — | e.g. `https://<resource>.cognitiveservices.azure.com` |
| `AZURE_OPENAI_API_KEY` | `AGENT_MEM_AZURE_OPENAI_API_KEY` | — | API key (omit for Entra ID auth) |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | `AGENT_MEM_AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | — | Deployment name |
| `AZURE_OPENAI_API_VERSION` | `AGENT_MEM_AZURE_OPENAI_API_VERSION` | `2024-06-01` | API version |

**Entra ID / AAD (recommended):** Omit `AZURE_OPENAI_API_KEY`. The system uses `DefaultAzureCredential` from `@azure/identity`, which auto-chains Azure CLI login, managed identity, and environment credentials. Tokens are cached and refreshed automatically.

**API key:** Set `AZURE_OPENAI_API_KEY`. Simpler but less secure.

```bash
# Switch to Azure OpenAI (Entra ID)
npx tsx src/index.ts config set EMBEDDING_PROVIDER azure_openai
npx tsx src/index.ts config set AZURE_OPENAI_ENDPOINT "https://your-resource.cognitiveservices.azure.com"
npx tsx src/index.ts config set AZURE_OPENAI_EMBEDDING_DEPLOYMENT "text-embedding-3-small"
npx tsx src/index.ts db embedding-test

# Switch back to local Nomic
npx tsx src/index.ts config set EMBEDDING_PROVIDER nomic
```

> **Note:** The Azure OpenAI API supports a `dimensions` parameter, so `text-embedding-3-small` (natively 1536-dim) truncates its output to 768-dim to match the database schema. No migration is needed.

## Multi-Tenant Security

Every table includes a `user_id` column. PostgreSQL Row Level Security policies enforce that each query only sees rows matching the current user:

```sql
-- Applied automatically by `db push`
ALTER TABLE cpm_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpm_sessions_tenant ON cpm_sessions
  USING (user_id = current_setting('app.user_id', true));
```

The worker sets `app.user_id` via `SELECT set_config('app.user_id', '<hash>', true)` inside every transaction. This is transaction-scoped and safe with connection pooling.

User IDs are auto-derived from `SHA-256(os.username@os.hostname)` (truncated to 16 hex characters) or set explicitly via `AGENT_MEM_USER_ID`.

## Database Schema

Seven tables with `cpm_` prefix:

| Table | Purpose |
|-------|---------|
| `cpm_sessions` | Session metadata (project, timestamps, source) |
| `cpm_sdk_sessions` | Session lifecycle (status, prompts, completion) |
| `cpm_observations` | Tool call observations with pgvector embeddings |
| `cpm_session_summaries` | AI-generated structured session summaries |
| `cpm_pending_messages` | Queue for async processing |
| `cpm_user_prompts` | User prompt history |
| `cpm_schema_versions` | Schema migration tracking |

All vector columns use HNSW indexes (768-dim) and GIN indexes on tsvector columns for hybrid search.

## How It Works Internally

This section explains the full data lifecycle — how observations get captured, stored, indexed, and retrieved. Understanding this will help you debug, extend, or operate the system.

### The Three Processes

The system runs as three cooperating processes:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Your Coding Agent (OpenCode / Claude Code / Copilot CLI)          │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐                          │
│  │  MCP Server  │───>│     Worker       │                          │
│  │  (stdio)     │    │  (HTTP :37778)   │                          │
│  │  3 tools     │    │  Express daemon  │                          │
│  └──────────────┘    └────────┬─────────┘                          │
│                               │                                     │
│  ┌──────────────┐             │ withUserContext()                   │
│  │  Plugin /    │─────────────┘ SET app.user_id = '<hash>'         │
│  │  Hooks       │                                                   │
│  └──────────────┘       ┌─────▼─────────────┐                      │
│                         │ Azure PostgreSQL   │                      │
│                         │ + pgvector + RLS   │                      │
│                         └───────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

| Process | Transport | Role |
|---------|-----------|------|
| **Worker** (`worker-service.ts`) | Express HTTP on `127.0.0.1:37778` | All business logic: DB queries, embedding generation, session management, observation storage. Runs as a long-lived daemon. |
| **MCP Server** (`mcp-server.ts`) | JSON-RPC over stdio | Thin proxy that translates MCP tool calls into Worker HTTP requests. Spawned per agent session. |
| **Plugin / Hooks** (`agent-mem.ts` or `hooks.json`) | Fire-and-forget HTTP POST | Auto-captures tool calls and session lifecycle events. Runs inside the agent process. |

### Data Capture: How Observations Get Created

Observations are captured automatically — no manual action needed. The capture mechanism depends on your agent:

#### OpenCode (Plugin)

The OpenCode plugin (`plugin/opencode/agent-mem.ts`) hooks into two events:

1. **`session.created` / `session.idle`** — Sends `POST /api/sessions/init` and `POST /api/sessions/complete` to the Worker to track session lifecycle.
2. **`tool.execute.after`** — Fires after every tool call. The plugin:
   - Filters out trivial tools (`ls`, `pwd`, browser snapshots) and short-output read tools
   - Truncates large outputs to 2000 characters
   - Sends `POST /api/observations` with `tool_name`, `tool_input`, `tool_response`, and `project`

#### Claude Code (Hooks)

Claude Code uses shell hooks defined in `plugin/hooks/hooks.json`:

| Hook Event | Fires When | What It Does |
|------------|-----------|--------------|
| `SessionStart` | Agent session begins | Starts the Worker daemon, injects recent context |
| `UserPromptSubmit` | User sends a prompt | Initialises the session in the DB |
| `PostToolUse` | After any tool call | Stores the tool call as an observation |
| `Stop` | Session ends | Generates a session summary, marks session complete |

Each hook runs a Node.js script that reads JSON from stdin (provided by Claude Code) and POSTs to the Worker.

#### What Gets Stored Per Observation

When `POST /api/observations` is called, the Worker:

1. **Strips `<private>` tags** — Any content wrapped in `<private>...</private>` is removed before storage
2. **Computes a content hash** — SHA-256 of the observation text, used for deduplication
3. **Checks for duplicates** — If an observation with the same `content_hash` already exists for this user, the insert is skipped
4. **Generates an embedding** — The text (title + body) is sent to the configured embedding provider, producing a 768-dimensional vector
5. **Builds a tsvector** — PostgreSQL's built-in full-text search index is computed via `to_tsvector('english', ...)`
6. **Inserts the row** — All fields are written to `cpm_observations` inside a transaction with RLS context set

### Embedding Generation

Embeddings convert text into 768-dimensional vectors for semantic similarity search. Two providers are supported:

| Provider | Model | Dimensions | Latency | Cost |
|----------|-------|-----------|---------|------|
| **Nomic** (default) | `nomic-ai/nomic-embed-text-v1` | 768 | ~50ms (local CPU) | Free |
| **Azure OpenAI** | `text-embedding-3-small` | 768 (truncated from 1536) | ~100ms (API call) | ~$0.02/1M tokens |

**Nomic prefix convention:** Nomic models require task-specific prefixes for optimal results. The Worker automatically prepends `search_document: ` when storing observations and `search_query: ` when searching. Azure OpenAI does not use prefixes.

**Azure OpenAI authentication:** When no API key is configured, the system uses `DefaultAzureCredential` from `@azure/identity`, which automatically chains: Azure CLI login → managed identity → environment variables. Tokens are cached and refreshed 5 minutes before expiry.

### How Search Works (Hybrid Retrieval)

When you call the `search` MCP tool (or `GET /api/search`), the Worker runs a hybrid query combining two ranking signals:

```
Final Score = (semantic_score × 0.7) + (text_score × 0.3)
```

**Step by step:**

1. **Embed the query** — The search query is converted to a 768-dim vector (with `search_query:` prefix for Nomic)
2. **Cosine similarity** — pgvector computes `1 - (embedding <=> query_vector)` for every observation. The `<=>` operator uses the HNSW index for approximate nearest-neighbour search (sub-linear time)
3. **Full-text rank** — PostgreSQL's `ts_rank_cd()` scores each row's `search_vector` against `plainto_tsquery('english', query)`. The GIN index accelerates this
4. **Filter** — Results must either match the tsvector OR have a semantic score > 0.3
5. **Rank** — Results are sorted by the weighted combination (70% semantic, 30% text)
6. **Limit** — Default 20 results, configurable via `limit` parameter

This hybrid approach catches both semantically similar content (e.g., "authentication" matches "login flow") and exact keyword matches (e.g., error codes, file names).

### Progressive Disclosure: The 3-Tool Pattern

The MCP server exposes three tools designed to minimize token usage:

```
search (50-100 tokens/result)     →  Scan many results cheaply
  │
  ▼
timeline (200-500 tokens/result)  →  See chronological context
  │
  ▼
get_observations (500-1000 tokens/result)  →  Full details for specific IDs
```

**Why this matters:** A naive design that returns full observation text for every search result would consume 10-20x more tokens. With progressive disclosure, the agent can scan 20 search results (~1500 tokens), pick 3 interesting ones, and fetch full details (~2500 tokens) — total ~4000 tokens instead of ~30000.

| Tool | Worker Endpoint | Returns | Use Case |
|------|----------------|---------|----------|
| `search` | `GET /api/search` | `id, type, project, title, content_preview (200 chars)` | Broad exploration, finding relevant observations |
| `timeline` | `GET /api/timeline` | `id, type, project, title, text_preview (300 chars)` | Chronological context around an anchor point |
| `get_observations` | `POST /api/observations/batch` | Full `text, narrative, memory_session_id, created_at` | Deep-dive into specific observations |

### Row Level Security (RLS) in Detail

RLS ensures that users sharing the same database cannot see each other's data. Here's exactly how it works:

**1. User ID derivation:**
```
user_id = SHA-256("username@hostname").slice(0, 16)
```
For example, `alice@macbook-pro` → `f9b7c930b9856e3c`. This is deterministic — the same user on the same machine always gets the same ID.

**2. Every table has a `user_id` column** and an RLS policy:
```sql
ALTER TABLE cpm_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpm_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON cpm_observations
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
```

**3. Every Worker transaction sets the user context:**
```typescript
await client.query('BEGIN');
await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
// ... all queries here only see rows where user_id matches ...
await client.query('COMMIT');
```

The `true` parameter in `set_config()` makes it transaction-local — safe with connection pooling because the setting vanishes when the transaction ends.

**4. `FORCE ROW LEVEL SECURITY`** means even the table owner (the connection role) is subject to RLS. Without `FORCE`, the DB admin would bypass all policies.

**5. Admin access:** The schema creates a `cpm_admin` role with `BYPASSRLS`. To query all users' data (e.g., from DBeaver), run `SET ROLE cpm_admin;` before your SELECT — in the same execution block (Alt+X in DBeaver, not Ctrl+Enter).

### Session Lifecycle

A session represents one continuous interaction with the coding agent:

```
Session Start                    Session End
    │                                │
    ▼                                ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ init     │→ │ observe  │→ │ observe  │→ │ complete │
│ session  │  │ tool #1  │  │ tool #N  │  │ + summary│
└──────────┘  └──────────┘  └──────────┘  └──────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
cpm_sdk_sessions  cpm_observations (×N)    cpm_session_summaries
cpm_sessions                               status → 'completed'
```

**Two session tables exist for different purposes:**

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `cpm_sessions` | Lightweight tracking (simple insert, ON CONFLICT DO NOTHING) | `session_id`, `project`, `source` |
| `cpm_sdk_sessions` | Full lifecycle management | `status` (active/completed/failed), `completed_at`, `prompt_counter`, `user_prompt` |

The `memory_session_id` is derived as `mem_${session_id}` and links observations and summaries back to their session.

### Worker HTTP API Reference

All endpoints require `user_id` (query param or body field) for RLS context.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/health` | Health check — returns version, uptime, embedding provider |
| `GET` | `/api/search` | Hybrid search with filters (project, type, date range) |
| `GET` | `/api/timeline` | Chronological observations around an anchor ID |
| `POST` | `/api/observations` | Store a new observation (generates embedding + tsvector) |
| `POST` | `/api/observations/batch` | Fetch full details for an array of observation IDs |
| `POST` | `/api/sessions/init` | Create or resume a session |
| `POST` | `/api/sessions/complete` | Mark a session as completed |
| `POST` | `/api/summaries` | Store a structured session summary |
| `POST` | `/api/context` | Get recent observations for context injection |
| `POST` | `/shutdown` | Graceful daemon shutdown |

### Index Strategy

The database uses 25+ indexes optimized for the system's access patterns:

| Index Type | Columns | Purpose |
|------------|---------|---------|
| **HNSW** (pgvector) | `embedding vector_cosine_ops` | Approximate nearest-neighbour for semantic search. Sub-linear scan time. |
| **GIN** (PostgreSQL) | `search_vector` | Full-text search acceleration for tsvector queries |
| **B-tree** (composite) | `(user_id, project, created_at_epoch)` | Fast filtered time-range queries scoped to a user+project |
| **B-tree** (unique) | `session_id`, `content_session_id` | Session lookup and deduplication |
| **B-tree** | `content_hash` | Observation deduplication |

### Deduplication

The system prevents duplicate observations at two levels:

1. **Content hash** — Before inserting, the Worker computes `SHA-256(observation_text)` and checks if a row with the same hash exists for this user. If found, the insert is silently skipped.
2. **Session ON CONFLICT** — `cpm_sessions` uses `ON CONFLICT (session_id) DO NOTHING` to safely handle repeated session-init calls.

### File and Directory Layout

```
~/.agent-mem/
├── settings.json       # All configuration (DATABASE_URL, embedding provider, etc.)
└── worker.pid          # PID of the running worker daemon

src/
├── index.ts            # CLI entry point — dispatches commands
├── servers/
│   └── mcp-server.ts   # MCP stdio server (3 tools → Worker HTTP)
├── services/
│   ├── worker-service.ts     # Express daemon — all business logic
│   ├── embeddings.ts         # Nomic / Azure OpenAI / noop providers
│   └── postgres/
│       ├── schema.ts         # Drizzle ORM table definitions
│       ├── schema-push.ts    # DDL + indexes + RLS setup
│       └── client.ts         # Shared DB client utilities
├── cli/
│   ├── client.ts             # HTTP client for CLI → Worker communication
│   ├── commands/             # CLI command implementations
│   └── handlers/             # Hook handlers (observation, session-complete, etc.)
├── shared/
│   ├── settings.ts           # Settings manager (~/.agent-mem/settings.json)
│   └── logger.ts             # Structured logger
└── scripts/
    └── build-plugin.js       # Bundles worker + MCP server into CJS for plugin distribution

plugin/
├── opencode/
│   └── agent-mem.ts          # OpenCode plugin (auto-capture)
├── hooks/
│   └── hooks.json            # Claude Code hook definitions
├── .mcp.json                 # MCP server registration for Claude Code
└── scripts/                  # Built CJS bundles (gitignored, built via npm run build:plugin)
```

## CLI Reference

```
agent-mem setup                        Interactive one-command setup (config → schema → worker → plugin)
agent-mem config set <key> <value>     Set a config value
agent-mem config get <key>             Get a config value
agent-mem config list                  List all settings
agent-mem db provision [flags]         Provision Azure PostgreSQL server
agent-mem db push                      Push schema to database
agent-mem db status                    Check DB connection and table counts
agent-mem db embedding-test            Test configured embedding provider
agent-mem install                      Register as Claude Code plugin
agent-mem uninstall                    Remove plugin registration
agent-mem start                        Start worker daemon
agent-mem stop                         Stop worker daemon
agent-mem status                       Show worker status
```

## Development

```bash
# TypeScript compilation (ESM output to dist/)
npm run build

# Self-contained CJS bundles for plugin distribution
npm run build:plugin

# Development mode with hot reload
npm run dev

# Type checking
npm run lint
```

## Cost Estimates

### Solo Developer (Local Nomic Embeddings)

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| Azure PostgreSQL Flexible Server (B1ms) | ~$16 | Burstable, 1 vCore, 2 GiB RAM |
| Storage (32 GiB Premium SSD) | included | Included in base price |
| Embedding generation | $0.00 | Runs locally via `@huggingface/transformers` |
| **Total** | **~$16/month** | |

B1ms is eligible for the [Azure free account](https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-deploy-on-azure-free-account) (750 hours/month + 32 GB storage free for 12 months).

### Team of 10 Engineers

| Component | B1ms | B2s |
|-----------|------|-----|
| Compute | ~$16/mo | ~$32/mo |
| Azure OpenAI embeddings (optional) | ~$0.50/mo | ~$0.50/mo |
| **Total** | **~$16-17/mo** | **~$32-33/mo** |
| **Per engineer** | **~$1.60/mo** | **~$3.20/mo** |

Storage growth is approximately 250-370 MB/month for 10 active engineers (~53K observations/month). A 32 GB database lasts 3-7 years at this rate.

<details>
<summary>Scaling reference</summary>

| SKU | vCores | RAM | Max Connections | Monthly Cost | Team Size |
|-----|--------|-----|-----------------|-------------|-----------|
| B1ms | 1 | 2 GiB | 35 | ~$16 | 1-10 |
| B2s | 2 | 4 GiB | 414 | ~$32 | 10-50 |
| B2ms | 2 | 8 GiB | 844 | ~$50 | 50-100 |
| D2ds_v5 | 2 | 8 GiB | 844 | ~$125 | Production |

Reserved instances (1-year: ~40% savings, 3-year: ~60% savings).

</details>

## Resources

- [Azure PostgreSQL Flexible Server documentation](https://learn.microsoft.com/azure/postgresql/flexible-server/)
- [pgvector extension on Azure](https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-use-pgvector)
- [Azure OpenAI Embeddings](https://learn.microsoft.com/azure/ai-services/openai/concepts/models#embeddings)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
- [OpenCode plugin documentation](https://opencode.ai/docs/plugins)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.

## License

This project is licensed under the [MIT License](LICENSE).
