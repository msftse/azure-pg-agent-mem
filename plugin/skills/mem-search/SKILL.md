---
name: mem-search
description: Search persistent cross-session memory database. Use when user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.
---

# Memory Search

Search past work across all sessions. Simple workflow: search -> filter -> fetch.

## When to Use

Use when users ask about PREVIOUS sessions (not current conversation):
- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"
- "Show me what we worked on in project X"

## 3-Layer Workflow (ALWAYS Follow)

**NEVER fetch full details without filtering first. 10x token savings.**

### Step 1: Search - Get Index with IDs
Use the `search` MCP tool:
search(query="authentication", limit=20, project="my-project")

Returns table with IDs, timestamps, types, titles.

Parameters:
- query (string) - Search term
- limit (number) - Max results, default 20
- project (string) - Project name filter
- type (string) - "observations", "sessions", or "prompts"
- obs_type (string) - Comma-separated: bugfix, feature, decision, discovery, change
- dateStart/dateEnd (string) - Date range
- orderBy (string) - "date_desc", "date_asc", "relevance"

### Step 2: Timeline - Get Context
Use the `timeline` MCP tool:
timeline(anchor=11131, depth_before=3, depth_after=3)

### Step 3: Fetch - Get Full Details ONLY for Filtered IDs
Use the `get_observations` MCP tool:
get_observations(ids=[11131, 10942])

ALWAYS batch for 2+ items.

## Why This Workflow?
- Search index: ~50-100 tokens per result
- Full observation: ~500-1000 tokens each
- 10x token savings by filtering before fetching
