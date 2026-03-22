/**
 * Drizzle ORM schema for claude-azure-pg-mem.
 *
 * All tables carry a `user_id` column so that PostgreSQL Row Level Security
 * (RLS) can enforce strict multi-tenant isolation.  The companion
 * `schema-push.ts` module creates the RLS policies that reference
 * `current_setting('app.user_id', true)`.
 *
 * Vector columns use pgvector (768-dimensional, matching common embedding
 * models like all-MiniLM-L6-v2 upscaled or gte-base).
 * Full-text search columns use PostgreSQL tsvector.
 *
 * Table naming convention: `cpm_` prefix (Claude Postgres Memory).
 */

import {
  pgTable,
  serial,
  text,
  bigint,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Custom column types (pgvector + tsvector)
// ---------------------------------------------------------------------------

import { customType } from 'drizzle-orm/pg-core';

/**
 * pgvector `vector(dimensions)` column type.
 * Stores and retrieves float arrays.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config!.dimensions})`;
  },
  fromDriver(value: string): number[] {
    // pgvector returns '[1,2,3]' text format
    return value
      .slice(1, -1)
      .split(',')
      .map(Number);
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

/**
 * PostgreSQL `tsvector` column type for full-text search.
 */
export const tsvector = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'tsvector';
  },
});

// ---------------------------------------------------------------------------
// Enum-like text constraints (stored as plain text, validated in app layer)
// ---------------------------------------------------------------------------

// SDK session status values: 'active' | 'completed' | 'failed'
// Pending message type values: 'observation' | 'summarize'
// Pending message status values: 'pending' | 'processing' | 'processed' | 'failed'

// ---------------------------------------------------------------------------
// Table: cpm_sessions – lightweight session tracking
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'cpm_sessions',
  {
    id: serial('id').primaryKey(),
    /** Application-generated unique session identifier. */
    sessionId: text('session_id').notNull(),
    /** Project / repository name for scoping. */
    project: text('project').notNull(),
    /** Tenant user identifier – used by RLS policies. */
    userId: text('user_id').notNull(),
    createdAt: text('created_at').notNull(),
    createdAtEpoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    /** Origin of the session (e.g. "mcp", "cli", "vscode"). */
    source: text('source'),
    /** Arbitrary JSON metadata blob. */
    metadataJson: text('metadata_json'),
  },
  (table) => [
    uniqueIndex('cpm_sessions_session_id_idx').on(table.sessionId),
    index('cpm_sessions_user_id_idx').on(table.userId),
    index('cpm_sessions_user_project_idx').on(table.userId, table.project),
    index('cpm_sessions_user_project_epoch_idx').on(
      table.userId,
      table.project,
      table.createdAtEpoch,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Table: cpm_sdk_sessions – agent SDK session metadata
// ---------------------------------------------------------------------------

export const sdkSessions = pgTable(
  'cpm_sdk_sessions',
  {
    id: serial('id').primaryKey(),
    /** Content-layer session id (unique). */
    contentSessionId: text('content_session_id').notNull(),
    /** Memory-layer session id (unique). */
    memorySessionId: text('memory_session_id').notNull(),
    project: text('project').notNull(),
    userId: text('user_id').notNull(),
    /** The original user prompt that initiated the session. */
    userPrompt: text('user_prompt'),
    startedAt: text('started_at').notNull(),
    startedAtEpoch: bigint('started_at_epoch', { mode: 'number' }).notNull(),
    completedAt: text('completed_at'),
    completedAtEpoch: bigint('completed_at_epoch', { mode: 'number' }),
    /** Session lifecycle status: 'active' | 'completed' | 'failed'. */
    status: text('status').notNull().default('active'),
    /** Port the worker process is listening on. */
    workerPort: integer('worker_port'),
    /** Running count of prompts within this session. */
    promptCounter: integer('prompt_counter').default(0),
    /** User-supplied title override for display. */
    customTitle: text('custom_title'),
  },
  (table) => [
    uniqueIndex('cpm_sdk_sessions_content_sid_idx').on(table.contentSessionId),
    uniqueIndex('cpm_sdk_sessions_memory_sid_idx').on(table.memorySessionId),
    index('cpm_sdk_sessions_user_id_idx').on(table.userId),
    index('cpm_sdk_sessions_user_project_idx').on(table.userId, table.project),
    index('cpm_sdk_sessions_user_project_epoch_idx').on(
      table.userId,
      table.project,
      table.startedAtEpoch,
    ),
    index('cpm_sdk_sessions_status_idx').on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// Table: cpm_observations – structured observations with embeddings
// ---------------------------------------------------------------------------

export const observations = pgTable(
  'cpm_observations',
  {
    id: serial('id').primaryKey(),
    /** FK → cpm_sdk_sessions.memory_session_id (logical, not DB-enforced). */
    memorySessionId: text('memory_session_id').notNull(),
    project: text('project').notNull(),
    userId: text('user_id').notNull(),
    /** Raw observation text. */
    text: text('text').notNull(),
    /** Observation category (e.g. "code_change", "decision", "issue"). */
    type: text('type'),
    title: text('title'),
    subtitle: text('subtitle'),
    /** Extracted factual statements (JSON array string). */
    facts: text('facts'),
    /** Narrative summary of the observation. */
    narrative: text('narrative'),
    /** Key concepts / tags (JSON array string). */
    concepts: text('concepts'),
    /** Files that were read during this observation (JSON array string). */
    filesRead: text('files_read'),
    /** Files that were modified (JSON array string). */
    filesModified: text('files_modified'),
    /** Prompt number within the session that produced this observation. */
    promptNumber: integer('prompt_number'),
    /** SHA-256 of the text for deduplication. */
    contentHash: text('content_hash'),
    createdAt: text('created_at').notNull(),
    createdAtEpoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    /** 768-dimensional embedding vector for semantic search. */
    embedding: vector('embedding', { dimensions: 768 }),
    /** Full-text search index column. */
    searchVector: tsvector('search_vector'),
  },
  (table) => [
    index('cpm_obs_memory_sid_idx').on(table.memorySessionId),
    index('cpm_obs_user_id_idx').on(table.userId),
    index('cpm_obs_user_project_idx').on(table.userId, table.project),
    index('cpm_obs_user_project_epoch_idx').on(
      table.userId,
      table.project,
      table.createdAtEpoch,
    ),
    index('cpm_obs_content_hash_idx').on(table.contentHash),
    // HNSW index for fast approximate nearest-neighbour search (cosine distance).
    // NOTE: Drizzle does not natively support HNSW index syntax; this index
    // is created via raw SQL in schema-push.ts.  We declare a placeholder
    // b-tree index here so Drizzle still tracks the column.
    // The actual HNSW index:
    //   CREATE INDEX cpm_obs_embedding_idx ON cpm_observations
    //     USING hnsw (embedding vector_cosine_ops);
    //
    // GIN index on tsvector:
    //   CREATE INDEX cpm_obs_search_idx ON cpm_observations
    //     USING gin (search_vector);
  ],
);

// ---------------------------------------------------------------------------
// Table: cpm_session_summaries – end-of-session summaries with embeddings
// ---------------------------------------------------------------------------

export const sessionSummaries = pgTable(
  'cpm_session_summaries',
  {
    id: serial('id').primaryKey(),
    /** FK → cpm_sdk_sessions.memory_session_id. */
    memorySessionId: text('memory_session_id').notNull(),
    project: text('project').notNull(),
    userId: text('user_id').notNull(),
    /** What the user asked for. */
    request: text('request'),
    /** What was investigated / explored. */
    investigated: text('investigated'),
    /** Key learnings / discoveries. */
    learned: text('learned'),
    /** Work that was completed. */
    completed: text('completed'),
    /** Suggested follow-up actions. */
    nextSteps: text('next_steps'),
    /** Files read during the session (JSON array string). */
    filesRead: text('files_read'),
    /** Files edited during the session (JSON array string). */
    filesEdited: text('files_edited'),
    /** Free-form notes. */
    notes: text('notes'),
    promptNumber: integer('prompt_number'),
    createdAt: text('created_at').notNull(),
    createdAtEpoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
    /** 768-dimensional embedding vector for semantic search. */
    embedding: vector('embedding', { dimensions: 768 }),
    /** Full-text search index column. */
    searchVector: tsvector('search_vector'),
  },
  (table) => [
    index('cpm_summaries_memory_sid_idx').on(table.memorySessionId),
    index('cpm_summaries_user_id_idx').on(table.userId),
    index('cpm_summaries_user_project_idx').on(table.userId, table.project),
    index('cpm_summaries_user_project_epoch_idx').on(
      table.userId,
      table.project,
      table.createdAtEpoch,
    ),
    // HNSW + GIN indexes are created via raw SQL in schema-push.ts
    // (same pattern as cpm_observations).
  ],
);

// ---------------------------------------------------------------------------
// Table: cpm_pending_messages – work queue for async processing
// ---------------------------------------------------------------------------

export const pendingMessages = pgTable(
  'cpm_pending_messages',
  {
    id: serial('id').primaryKey(),
    /** FK → cpm_sessions.id (the lightweight session). */
    sessionDbId: integer('session_db_id'),
    /** Content-layer session id for correlation. */
    contentSessionId: text('content_session_id'),
    userId: text('user_id').notNull(),
    /** Type of deferred work: 'observation' | 'summarize'. */
    messageType: text('message_type').notNull(),
    /** MCP tool name that originated the message. */
    toolName: text('tool_name'),
    /** Serialised tool input (JSON string). */
    toolInput: text('tool_input'),
    /** Serialised tool response (JSON string). */
    toolResponse: text('tool_response'),
    /** Working directory at the time of the call. */
    cwd: text('cwd'),
    /** Last user message for context. */
    lastUserMessage: text('last_user_message'),
    /** Last assistant message for context. */
    lastAssistantMessage: text('last_assistant_message'),
    /** Prompt number within the session. */
    promptNumber: integer('prompt_number'),
    /** Processing lifecycle: 'pending' | 'processing' | 'processed' | 'failed'. */
    status: text('status').notNull().default('pending'),
    /** Number of times processing has been attempted. */
    retryCount: integer('retry_count').default(0),
    createdAtEpoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('cpm_pending_user_id_idx').on(table.userId),
    index('cpm_pending_status_idx').on(table.status),
    index('cpm_pending_content_sid_idx').on(table.contentSessionId),
    index('cpm_pending_session_db_id_idx').on(table.sessionDbId),
  ],
);

// ---------------------------------------------------------------------------
// Table: cpm_user_prompts – individual prompts within SDK sessions
// ---------------------------------------------------------------------------

export const userPrompts = pgTable(
  'cpm_user_prompts',
  {
    id: serial('id').primaryKey(),
    /** FK → cpm_sdk_sessions.content_session_id. */
    contentSessionId: text('content_session_id').notNull(),
    userId: text('user_id').notNull(),
    promptNumber: integer('prompt_number').notNull(),
    promptText: text('prompt_text').notNull(),
    createdAt: text('created_at').notNull(),
    createdAtEpoch: bigint('created_at_epoch', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('cpm_prompts_content_sid_idx').on(table.contentSessionId),
    index('cpm_prompts_user_id_idx').on(table.userId),
    index('cpm_prompts_user_epoch_idx').on(table.userId, table.createdAtEpoch),
  ],
);

// ---------------------------------------------------------------------------
// Table: cpm_schema_versions – migration version tracking
// ---------------------------------------------------------------------------

export const schemaVersions = pgTable(
  'cpm_schema_versions',
  {
    id: serial('id').primaryKey(),
    /** Monotonically increasing schema version number. */
    version: integer('version').notNull(),
    appliedAt: text('applied_at').notNull(),
  },
  (table) => [uniqueIndex('cpm_schema_versions_version_idx').on(table.version)],
);
