/**
 * OpenCode plugin: agent-mem
 *
 * Automatically captures tool-use observations from OpenCode sessions
 * and persists them to the agent-mem worker (Azure PostgreSQL + pgvector).
 *
 * Install:
 *   cp plugin/opencode/agent-mem.ts ~/.config/opencode/plugins/agent-mem.ts
 *
 * Requires the agent-mem worker to be running on http://127.0.0.1:37778
 * (start with: npx tsx src/index.ts worker start)
 */

import type { Plugin } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import { userInfo, hostname } from "node:os";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKER_PORT = process.env.AGENT_MEM_WORKER_PORT || "37778";
const WORKER_HOST = process.env.AGENT_MEM_WORKER_HOST || "127.0.0.1";
const WORKER_BASE = `http://${WORKER_HOST}:${WORKER_PORT}`;

// ---------------------------------------------------------------------------
// User ID — must match resolveUserId() in src/cli/client.ts
// ---------------------------------------------------------------------------

function resolveUserId(): string {
  const configured = process.env.AGENT_MEM_USER_ID;
  if (configured) return configured;

  const raw = `${userInfo().username}@${hostname()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Trivial-tool filter — mirrors src/cli/handlers/observation.ts
// ---------------------------------------------------------------------------

const TRIVIAL_TOOLS = new Set([
  // Shell commands that produce noisy / low-value output
  "ls",
  "pwd",
  // OpenCode built-in navigation tools
  "playwright_browser_snapshot",
  "playwright_browser_take_screenshot",
]);

/** Response length threshold — short outputs from read-like tools aren't worth storing. */
const TRIVIAL_RESPONSE_THRESHOLD = 200;

/** Tools that are trivial when their output is very short. */
const SHORT_OUTPUT_TOOLS = new Set(["cat", "Read", "read"]);

function isTrivialTool(toolName: string, output: string): boolean {
  if (TRIVIAL_TOOLS.has(toolName)) return true;

  if (SHORT_OUTPUT_TOOLS.has(toolName)) {
    if (typeof output === "string" && output.length < TRIVIAL_RESPONSE_THRESHOLD) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Fire-and-forget HTTP POST to worker
// ---------------------------------------------------------------------------

async function workerPost(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const url = `${WORKER_BASE}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[agent-mem] POST ${path} failed: ${res.status} ${text}`);
    }
  } catch (err) {
    // Worker might not be running — fail silently so we never block the session.
    console.error(
      `[agent-mem] POST ${path} error:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const AgentMemPlugin: Plugin = async ({ project, directory, worktree }) => {
  const userId = resolveUserId();
  const projectName = project?.name || basename(worktree || directory);

  // Track which sessions we've already initialised, to avoid duplicate inits.
  const initialisedSessions = new Set<string>();

  return {
    // ── Event handler ────────────────────────────────────────────────
    // Captures session lifecycle events.
    async event({ event }) {
      switch (event.type) {
        case "session.created": {
          const sessionId = event.properties.info.id;
          if (initialisedSessions.has(sessionId)) break;
          initialisedSessions.add(sessionId);

          await workerPost("/api/sessions/init", {
            session_id: sessionId,
            project: projectName,
            user_id: userId,
            source: "opencode",
            user_prompt: event.properties.info.title || "",
          });
          break;
        }

        case "session.idle": {
          const sessionId = event.properties.sessionID;
          await workerPost("/api/sessions/complete", {
            session_id: sessionId,
            user_id: userId,
          });
          break;
        }

        // Ignore all other events.
        default:
          break;
      }
    },

    // ── Tool execution hook ──────────────────────────────────────────
    // Captures every non-trivial tool call as an observation.
    "tool.execute.after": async (input, output) => {
      const { tool: toolName, sessionID, args } = input;
      const { title, output: toolOutput } = output;

      // Filter trivial tools.
      if (isTrivialTool(toolName, toolOutput || "")) return;

      // Ensure the session is initialised (in case we missed session.created).
      if (!initialisedSessions.has(sessionID)) {
        initialisedSessions.add(sessionID);
        await workerPost("/api/sessions/init", {
          session_id: sessionID,
          project: projectName,
          user_id: userId,
          source: "opencode",
        });
      }

      // Truncate large outputs to avoid bloating the observation store.
      const maxOutput = 2000;
      const truncatedOutput =
        typeof toolOutput === "string" && toolOutput.length > maxOutput
          ? toolOutput.slice(0, maxOutput) + "…"
          : toolOutput || "";

      // Build a compact input summary — args can be large (e.g. file contents).
      let inputSummary: string;
      try {
        const argsStr = JSON.stringify(args, null, 2);
        inputSummary = argsStr.length > 500 ? argsStr.slice(0, 500) + "…" : argsStr;
      } catch {
        inputSummary = String(args);
      }

      await workerPost("/api/observations", {
        session_id: sessionID,
        tool_name: toolName,
        tool_input: typeof args === "object" && args !== null ? args : {},
        tool_response: truncatedOutput,
        project: projectName,
        user_id: userId,
        title: title || `${toolName} call`,
        type: "tool_use",
      });
    },
  };
};

export default AgentMemPlugin;
