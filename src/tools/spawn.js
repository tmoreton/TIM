// spawn_agent tool: delegates a task to a sub-agent defined in .tim/agents/.
// Runs the sub-agent's loop to completion. If the profile sets `produces`,
// the final text is auto-written to knowledge by react.js's turn() loop —
// this tool just reads back the ref and packages it into a structured return.

import { createAgent } from "../react.js";
import { loadAgents } from "../agents.js";
import * as ui from "../ui.js";

export const schema = {
  type: "function",
  function: {
    name: "spawn_agent",
    description:
      "Delegate a task to a specialized sub-agent (worker) defined in .tim/agents/. Returns a JSON string with {summary, knowledgeRef, fullText}. When knowledgeRef is non-null, the worker's full output has been written to that knowledge file — prefer read_knowledge on the ref over relying on summary/fullText. Use for research, focused investigation, or any task with a self-contained scope.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Name of the agent profile (see /agents)" },
        task: { type: "string", description: "The task or question for the sub-agent" },
      },
      required: ["agent", "task"],
    },
  },
};

export async function run({ agent, task }, { signal }) {
  const profiles = loadAgents();
  const profile = profiles[agent];
  if (!profile) {
    const known = Object.keys(profiles).join(", ") || "(none)";
    return `ERROR: unknown agent "${agent}". Available: ${known}`;
  }

  ui.info(`→ spawning ${agent}`);
  const sub = await createAgent(profile);
  await sub.turn(task, signal);

  const last = sub.state.messages
    .filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content)
    .pop();
  const fullText = last?.content || "";
  const knowledgeRef = sub.state.lastKnowledgeRef || null;

  ui.info(`← ${agent} done${knowledgeRef ? ` (→ ${knowledgeRef})` : ""}`);

  return JSON.stringify({
    summary: fullText.slice(0, 500),
    knowledgeRef,
    fullText: knowledgeRef ? null : fullText,
  }, null, 2);
}
