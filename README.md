<p align="center">
  <img src="assets/azure-logo.svg" alt="Microsoft Azure" height="80" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/postgresql-logo.svg" alt="PostgreSQL" height="80" />
</p>

# claude-azure-pg-mem

Multi-tenant persistent memory for coding agents (OpenCode, Claude Code, GitHub Copilot CLI) backed by **Azure PostgreSQL Flexible Server** with **pgvector**.

Captures tool usage observations during sessions, generates semantic summaries, and makes them searchable across sessions and machines. Multiple users share the same Postgres instance, isolated by **Row Level Security (RLS)**.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Coding Agent (OpenCode / Claude Code / Copilot CLI)    │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  MCP Server  │───▶│    Worker    │                   │
│  │  (stdio)     │    │  (HTTP :37778)│                  │
│  │  3 tools     │    │  Express API │                   │
│  └──────────────┘    └──────┬───────┘                   │
│                             │ withUserContext()          │
│                             │ SET LOCAL app.user_id      │
│                      ┌──────▼───────┐                   │
│                      │ Azure Postgres│                  │
│                      │ + pgvector   │                   │
│                      │ + RLS        │                   │
│                      └──────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

**MCP Tools** (progressive disclosure):
1. `search` — lightweight results (~50-100 tokens each)
2. `timeline` — medium context (~200-500 tokens)
3. `get_observations` — full details (~500-1000 tokens each)

## Prerequisites

- **Node.js 22+**
- **Azure CLI** (`az`) — required for `db provision` command
  - Install: https://learn.microsoft.com/cli/azure/install-azure-cli
  - Login: `az login`

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/msftse/azure-pg-agent-mem.git
cd azure-pg-agent-mem
npm install
```

### 2. Provision the database (automated)

One command creates the Azure PostgreSQL server, enables pgvector, creates the database, adds firewall rules, saves `DATABASE_URL`, and pushes the schema:

```bash
npx tsx src/index.ts db provision
```

This uses sensible defaults (B1ms SKU, eastus, PostgreSQL 16). Customize with flags:

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
<summary>Manual setup (without <code>db provision</code>)</summary>

If you already have an Azure PostgreSQL server, configure the connection manually:

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

<details open>
<summary><strong>OpenCode</strong></summary>

**a) MCP server** (memory search tools — already configured if you followed step 4):

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

**b) Plugin** (auto-captures observations from every tool call):

```bash
# Create the global plugins directory
mkdir -p ~/.config/opencode/plugins

# Copy the plugin file
cp plugin/opencode/agent-mem.ts ~/.config/opencode/plugins/agent-mem.ts
```

Restart OpenCode for the plugin to take effect. Every non-trivial tool call will be automatically persisted to your memory database.

**Environment overrides** (optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MEM_WORKER_HOST` | `127.0.0.1` | Worker hostname |
| `AGENT_MEM_WORKER_PORT` | `37778` | Worker port |
| `AGENT_MEM_USER_ID` | auto | Override auto-derived user ID |

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
npx tsx src/index.ts install
```

This copies the `plugin/` directory to `~/.claude/plugins/agent-mem/`, registering:
- **Hooks** for session lifecycle (auto-capture observations)
- **MCP server** for memory search tools
- **Skill** (`mem-search`) for agents to discover and use

</details>

## Configuration

All settings can be set via environment variables (prefixed with `AGENT_MEM_`) or through the CLI:

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `DATABASE_URL` | `DATABASE_URL` | — | Azure Postgres connection string |
| `WORKER_PORT` | `AGENT_MEM_WORKER_PORT` | `37778` | Worker HTTP port |
| `LOG_LEVEL` | `AGENT_MEM_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARN, ERROR) |
| `USER_ID` | `AGENT_MEM_USER_ID` | auto | User ID for RLS (auto = SHA-256 of `user@hostname`) |

### Embedding Providers

By default, embeddings are generated locally using **Nomic Embed Text v1** (768 dimensions, no API key needed). You can switch to **Azure OpenAI** embeddings for potentially higher quality at the cost of an API call.

| Setting | Env Var | Default | Description |
|---------|---------|---------|-------------|
| `EMBEDDING_PROVIDER` | `AGENT_MEM_EMBEDDING_PROVIDER` | `nomic` | `nomic`, `azure_openai`, or `noop` |
| `EMBEDDING_DIMENSIONS` | `AGENT_MEM_EMBEDDING_DIMENSIONS` | `768` | Must match DB vector(N) column |
| `AZURE_OPENAI_ENDPOINT` | `AGENT_MEM_AZURE_OPENAI_ENDPOINT` | — | e.g. `https://<resource>.cognitiveservices.azure.com` |
| `AZURE_OPENAI_API_KEY` | `AGENT_MEM_AZURE_OPENAI_API_KEY` | — | API key (optional — omit for Entra ID auth) |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | `AGENT_MEM_AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | — | Deployment name |
| `AZURE_OPENAI_API_VERSION` | `AGENT_MEM_AZURE_OPENAI_API_VERSION` | `2024-06-01` | API version |

**Authentication for Azure OpenAI:**

Two auth modes are supported:

- **Entra ID / AAD (recommended):** Omit `AZURE_OPENAI_API_KEY`. The system uses `DefaultAzureCredential` from `@azure/identity`, which auto-chains: Azure CLI login → managed identity → environment variables. Tokens are cached and refreshed automatically. Works with Azure OpenAI resources that have `disableLocalAuth = true`.

- **API key:** Set `AZURE_OPENAI_API_KEY` to your key. Simpler but less secure.

**Switching to Azure OpenAI (Entra ID auth):**

```bash
npx tsx src/index.ts config set EMBEDDING_PROVIDER azure_openai
npx tsx src/index.ts config set AZURE_OPENAI_ENDPOINT "https://your-resource.cognitiveservices.azure.com"
npx tsx src/index.ts config set AZURE_OPENAI_EMBEDDING_DEPLOYMENT "text-embedding-3-small"
# No API key needed — uses 'az login' or managed identity

# Verify it works
npx tsx src/index.ts db embedding-test
```

**Switching to Azure OpenAI (API key auth):**

```bash
npx tsx src/index.ts config set EMBEDDING_PROVIDER azure_openai
npx tsx src/index.ts config set AZURE_OPENAI_ENDPOINT "https://your-resource.openai.azure.com"
npx tsx src/index.ts config set AZURE_OPENAI_API_KEY "your-key"
npx tsx src/index.ts config set AZURE_OPENAI_EMBEDDING_DEPLOYMENT "text-embedding-3-small"

# Verify it works
npx tsx src/index.ts db embedding-test
```

The Azure OpenAI API supports a `dimensions` parameter, so models like `text-embedding-3-small` (natively 1536-dim) will truncate their output to 768-dim to match the DB schema. No column migration needed.

**Switching back to local Nomic:**

```bash
npx tsx src/index.ts config set EMBEDDING_PROVIDER nomic
npx tsx src/index.ts db embedding-test
```

```bash
# Set a value
npx tsx src/index.ts config set WORKER_PORT 37779

# Get a value
npx tsx src/index.ts config get WORKER_PORT

# List all settings
npx tsx src/index.ts config list
```

Settings are stored in `~/.agent-mem/settings.json`.

## CLI Reference

```
claude-azure-pg-mem config set <key> <value>   Set a config value
claude-azure-pg-mem config get <key>            Get a config value
claude-azure-pg-mem config list                 List all settings
claude-azure-pg-mem db provision [flags]        Provision Azure PostgreSQL server
claude-azure-pg-mem db push                     Push schema to database
claude-azure-pg-mem db status                   Check DB connection & table counts
claude-azure-pg-mem db embedding-test           Test configured embedding provider
claude-azure-pg-mem install                     Register as Claude Code plugin
claude-azure-pg-mem uninstall                   Remove plugin registration
claude-azure-pg-mem start                       Start worker daemon
claude-azure-pg-mem stop                        Stop worker daemon
claude-azure-pg-mem status                      Show worker status
claude-azure-pg-mem hook <adapter> <handler>    Called by Claude Code hooks
```

## Building

```bash
# TypeScript compilation (ESM output to dist/)
npm run build

# Self-contained CJS bundles for plugin distribution
npm run build:plugin
# → dist/plugin/worker-service.cjs
# → dist/plugin/mcp-server.cjs
```

## Multi-Tenant Security

Every table has a `user_id` column. PostgreSQL Row Level Security policies enforce that each query only sees rows matching the current user:

```sql
-- Applied automatically by `db push`
ALTER TABLE cpm_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpm_sessions_tenant ON cpm_sessions
  USING (user_id = current_setting('app.user_id', true));
```

The worker sets `app.user_id` via `SELECT set_config('app.user_id', '<hash>', true)` inside every transaction via `withUserContext()`. This is transaction-scoped, so it's safe with connection pooling.

User IDs are auto-derived from `SHA-256(os.username@os.hostname)` or set explicitly via `AGENT_MEM_USER_ID`.

## Database Schema

Seven tables with `cpm_` prefix:

| Table | Purpose |
|-------|---------|
| `cpm_sessions` | Session lifecycle (start/end, project, cost) |
| `cpm_sdk_sessions` | SDK session correlation |
| `cpm_observations` | Tool call observations (pgvector embeddings) |
| `cpm_session_summaries` | AI-generated session summaries |
| `cpm_pending_messages` | Queue for async processing |
| `cpm_user_prompts` | User prompt history |
| `cpm_schema_versions` | Schema migration tracking |

All tables use HNSW indexes on vector columns (768 dims, Nomic Embed Text v1) and GIN indexes on tsvector columns for hybrid search.

## For OpenCode / Agent Skill

The `plugin/skills/mem-search/SKILL.md` teaches agents when and how to search memory using a 3-layer progressive disclosure workflow:

1. **Search** — get an index of matching results with IDs
2. **Timeline** — view session timelines for context
3. **Get Observations** — fetch full details for specific IDs

Agents are instructed to never fetch full details without filtering first (10x token savings).

## Development

```bash
# Run in development mode (hot reload)
npm run dev

# Worker with hot reload
npm run worker:dev

# Type checking
npm run lint
```

## Cost Breakdown

### Scenario A: Solo Developer (Local Nomic Embeddings)

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| Azure PostgreSQL Flexible Server (B1ms) | ~$16 | Burstable, 1 vCore, 2 GiB RAM |
| Storage (32 GiB Premium SSD) | included | Included in base price |
| Backup (7 days, LRS) | included | LRS backup at no extra cost |
| Embedding generation | $0.00 | Runs locally via `@huggingface/transformers` |
| **Total** | **~$16/month** | |

The B1ms is eligible for the [Azure free account](https://learn.microsoft.com/azure/postgresql/configure-maintain/how-to-deploy-on-azure-free-account) (750 hours/month + 32 GB storage free for 12 months).

### Scenario B: 10 Engineers, Active Claude Code Usage

This is the realistic team scenario — 10 developers each running multiple Claude Code sessions daily, all writing to the shared database.

**Usage assumptions per engineer per day:**
- ~8 Claude Code sessions
- ~30 observations per session (tool calls, file reads, edits)
- ~15 memory searches per day

**Monthly totals (10 engineers, ~22 working days):**

| Metric | Per Engineer/Day | 10 Engineers/Month |
|--------|-----------------|-------------------|
| Sessions | ~8 | ~1,760 |
| Observations | ~240 | ~52,800 |
| Session summaries | ~8 | ~1,760 |
| Embedding calls (writes) | ~248 | ~54,560 |
| Search queries | ~15 | ~3,300 |

**Storage growth estimate:**

Each observation row uses ~4-7 KB (768-dim vector = 3 KB + text + tsvector + indexes):

| Timeframe | New Observations | Storage Growth | Cumulative |
|-----------|-----------------|----------------|------------|
| 1 month | ~53K | ~250-370 MB | ~370 MB |
| 6 months | ~317K | ~1.5-2.2 GB | ~2.2 GB |
| 12 months | ~634K | ~3-4.4 GB | ~4.4 GB |
| 24 months | ~1.27M | ~6-8.9 GB | ~8.9 GB |

With 32 GB storage, a 10-person team has **3-7 years** before hitting the storage limit — and storage can be scaled up online without downtime.

**Connection capacity:**

B1ms has 50 max connections (35 usable after PostgreSQL reserves 15). The worker daemon uses a connection pool:

| Setup | Connections Used | B1ms (35 avail) | B2s (414 avail) |
|-------|-----------------|-----------------|-----------------|
| 1 worker, pool=5 | 5 | OK | OK |
| 2 workers (HA), pool=5 each | 10 | OK | OK |
| 10 workers (1 per engineer), pool=3 each | 30 | Tight | OK |

For a shared worker (recommended architecture), B1ms is sufficient for 10 engineers. Each engineer's agent connects to the same worker over HTTP — the worker manages the DB pool. Only scale up if running per-engineer worker instances.

**Monthly cost — 10 engineers:**

| Component | B1ms | B2s (if needed) |
|-----------|------|-----------------|
| Compute | ~$16 | ~$32 |
| Azure OpenAI embeddings (optional) | ~$0.50 | ~$0.50 |
| **Total (local Nomic)** | **~$16** | **~$32** |
| **Total (Azure OpenAI)** | **~$17** | **~$33** |
| **Per engineer/month** | **~$1.60** | **~$3.20** |

Embedding costs are negligible even at scale — text-embedding-3-small costs $0.02/1M tokens, and 55K observations/month is only ~27M tokens (~$0.54).

### Scaling Reference

| SKU | vCores | RAM | Max User Connections | Monthly Cost | Good For |
|-----|--------|-----|---------------------|-------------|----------|
| B1ms | 1 | 2 GiB | 35 | ~$16 | 1-10 engineers (shared worker) |
| B2s | 2 | 4 GiB | 414 | ~$32 | 10-50 engineers |
| B2ms | 2 | 8 GiB | 844 | ~$50 | 50-100 engineers |
| D2ds_v5 (Gen Purpose) | 2 | 8 GiB | 844 | ~$125 | Production, sustained load |

For reserved instances: 1-year commitment saves ~40%, 3-year saves ~60%.

### Cost Optimization Tips

1. **Use Azure Free Account** — B1ms + 32 GB storage is free for 12 months
2. **Use local Nomic embeddings** (default) — eliminates embedding API costs entirely
3. **Shared worker architecture** — one worker daemon per team, not per engineer
4. **Stop the server when not in use** — Burstable instances can be stopped to pause compute charges
5. **Reserved pricing** — commit for 1-3 years for significant savings on production deployments
6. **Data retention** — implement observation pruning for old sessions to manage storage growth

## License

MIT
