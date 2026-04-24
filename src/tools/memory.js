// Memory tools — scoped to the calling agent. An agent can rewrite or append
// to its own memory file (~/.tim/memory/<agent>.md). It cannot create or
// modify memory files for other agents. Agents don't need a `read_memory`
// tool because their memory is auto-loaded into the system prompt.

import { updateMemory, appendMemory, memoryExists } from "../memory.js";

export const updateMemorySchema = {
  type: "function",
  function: {
    name: "update_memory",
    description:
      "Rewrite your memory file from scratch. Use only when the existing memory is stale enough that a full replacement is cleaner than appending. Prefer append_memory for new findings.",
    parameters: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description: "Full new markdown body (no frontmatter — it's managed for you).",
        },
      },
      required: ["body"],
    },
  },
};

export const appendMemorySchema = {
  type: "function",
  function: {
    name: "append_memory",
    description:
      "Append a dated section to your memory file. Use for durable findings worth remembering across runs (a title pattern that's working, a stable user preference, a channel-voice observation). Do not use for run summaries or activity logs — those go in your reply to the user.",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "Section heading (short, semantic — e.g. 'Title pattern: how-to + year').",
        },
        content: {
          type: "string",
          description: "Markdown content for the section body.",
        },
      },
      required: ["section", "content"],
    },
  },
};

// Both tools read the current agent name from the run context that react.js
// passes in (ctx.agentName). If it's missing we refuse — memory is per-agent
// and we will not guess.
export async function updateMemoryRun({ body }, ctx) {
  const agent = ctx?.agentName;
  if (!agent) return "ERROR: update_memory requires an agent context (sub-agent or main agent with a profile).";
  if (!memoryExists(agent)) return `ERROR: no memory file for "${agent}" — create the agent first with 'tim agent new'.`;
  updateMemory(agent, body);
  return `Updated memory for ${agent}.`;
}

export async function appendMemoryRun({ section, content }, ctx) {
  const agent = ctx?.agentName;
  if (!agent) return "ERROR: append_memory requires an agent context.";
  if (!memoryExists(agent)) return `ERROR: no memory file for "${agent}".`;
  appendMemory(agent, section, content);
  return `Appended "${section}" to ${agent} memory.`;
}

export const tools = {
  update_memory: {
    schema: updateMemorySchema, run: updateMemoryRun,
    promptSnippet: "update_memory: rewrite your agent memory from scratch",
  },
  append_memory: {
    schema: appendMemorySchema, run: appendMemoryRun,
    promptSnippet: "append_memory: append a dated section to your agent memory",
    promptGuidelines: [
      "Call append_memory for durable findings (stable preferences, patterns, facts worth keeping across runs). Do not log run summaries — those go in your reply.",
    ],
  },
};
