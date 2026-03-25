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

async function workerPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    const url = `${WORKER_BASE}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[agent-mem] POST ${path} failed: ${res.status} ${text}`);
      return null;
    }
    return res.json().catch(() => null);
  } catch (err) {
    // Worker might not be running — fail silently so we never block the session.
    console.error(
      `[agent-mem] POST ${path} error:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget HTTP GET to worker
// ---------------------------------------------------------------------------

async function workerGet(path: string): Promise<unknown> {
  try {
    const url = `${WORKER_BASE}${path}`;
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[agent-mem] GET ${path} failed: ${res.status} ${text}`);
      return null;
    }
    return res.json().catch(() => null);
  } catch (err) {
    console.error(
      `[agent-mem] GET ${path} error:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

const AgentMemPlugin: Plugin = async ({ project, directory, worktree }) => {
  const userId = resolveUserId();
  const projectName = project?.name || basename(worktree || directory);

  console.error(`[agent-mem] Plugin loaded — project=${projectName} userId=${userId}`);

  // Track which sessions we've already initialised, to avoid duplicate inits.
  const initialisedSessions = new Set<string>();

  // Track observations per session so we can build summaries.
  const sessionObservations = new Map<string, { tools: string[]; project: string }>();

  return {
    // ── Event handler ────────────────────────────────────────────────
    // Captures session lifecycle events.
    async event({ event }) {
      switch (event.type) {
        case "session.created": {
          const t0 = Date.now();
          const sessionId = event.properties.info.id;
          console.error(`[agent-mem] ▶ session.created — sessionId=${sessionId}`);

          if (initialisedSessions.has(sessionId)) {
            console.error(`[agent-mem] ⊘ Session already initialised, skipping`);
            break;
          }
          initialisedSessions.add(sessionId);

          const userPrompt = event.properties.info.title || "";

          // Initialise the session in the worker.
          await workerPost("/api/sessions/init", {
            session_id: sessionId,
            project: projectName,
            user_id: userId,
            source: "opencode",
            user_prompt: userPrompt,
          });

          console.error(`[agent-mem] ✔ Session registered (${Date.now() - t0}ms)`);

          // Initialise observation tracking for summaries.
          sessionObservations.set(sessionId, { tools: [], project: projectName });

          // Inject prior memory context — fetch recent observations from the
          // worker and log them so the agent has prior session awareness.
          try {
            const ctxT0 = Date.now();
            const context = await workerPost("/api/context", {
              user_id: userId,
              project: projectName,
              limit: 30,
            });
            if (Array.isArray(context) && context.length > 0) {
              console.error(
                `[agent-mem] ✔ Injected ${context.length} prior observations as context (${Date.now() - ctxT0}ms)`,
              );
            } else {
              console.error(`[agent-mem] No prior observations found (${Date.now() - ctxT0}ms)`);
            }
          } catch {
            // Context injection is best-effort.
            console.error(`[agent-mem] ✘ Context fetch failed (best-effort, continuing)`);
          }

          break;
        }

        case "session.idle": {
          const t0 = Date.now();
          const sessionId = event.properties.sessionID;
          console.error(`[agent-mem] ▶ session.idle — sessionId=${sessionId}`);

          // Mark session as completed.
          await workerPost("/api/sessions/complete", {
            session_id: sessionId,
            user_id: userId,
          });

          console.error(`[agent-mem] ✔ Session marked complete (${Date.now() - t0}ms)`);

          // Generate and store a session summary from tracked observations.
          const tracked = sessionObservations.get(sessionId);
          if (tracked && tracked.tools.length > 0) {
            const summaryT0 = Date.now();
            const uniqueTools = [...new Set(tracked.tools)];
            const summaryText = `Session used ${tracked.tools.length} tool calls (${uniqueTools.join(", ")}).`;

            await workerPost("/api/summaries", {
              session_id: sessionId,
              user_id: userId,
              project: tracked.project,
              completed: summaryText,
              notes: `Tools used: ${uniqueTools.join(", ")}. Total calls: ${tracked.tools.length}.`,
            });

            console.error(
              `[agent-mem] ✔ Summary posted — ${tracked.tools.length} tool calls, ${uniqueTools.length} unique tools (${Date.now() - summaryT0}ms)`,
            );

            // Clean up tracking data.
            sessionObservations.delete(sessionId);
          } else {
            console.error(`[agent-mem] No tool observations to summarise`);
          }

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
      if (isTrivialTool(toolName, toolOutput || "")) {
        console.error(`[agent-mem] ⊘ Skipping trivial tool: ${toolName}`);
        return;
      }

      const t0 = Date.now();
      console.error(`[agent-mem] ▶ tool.execute.after — ${toolName} (session=${sessionID.slice(0, 8)}…)`);

      // Track tool usage for session summaries.
      const tracked = sessionObservations.get(sessionID);
      if (tracked) {
        tracked.tools.push(toolName);
      }

      // Ensure the session is initialised (in case we missed session.created).
      if (!initialisedSessions.has(sessionID)) {
        initialisedSessions.add(sessionID);
        console.error(`[agent-mem] Late session init for ${sessionID.slice(0, 8)}…`);
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

      const elapsed = Date.now() - t0;
      const outputLen = (toolOutput || "").length;
      console.error(
        `[agent-mem] ✔ Observation recorded — ${toolName} (output=${outputLen} chars, ${elapsed}ms)`,
      );
    },
  };
};

export default AgentMemPlugin;
