// spawn_agent tool: delegates a task to a sub-agent defined in .tim/agents/.
// Runs the sub-agent's loop to completion and returns its final text response.

import { createAgent } from "../agent.js";
import { loadAgents } from "../agents.js";
import * as ui from "../ui.js";

export const spawnAgent = {
  schema: {
    type: "function",
    function: {
      name: "spawn_agent",
      description:
        "Delegate a task to a specialized sub-agent defined in .tim/agents/. The sub-agent runs its own tool loop and returns a final text response. Use for research, focused investigation, or any task with a self-contained scope.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Name of the agent profile (see /agents)" },
          task: { type: "string", description: "The task or question for the sub-agent" },
        },
        required: ["agent", "task"],
      },
    },
  },
  run: async ({ agent, task }, { signal }) => {
    const profiles = loadAgents();
    const profile = profiles[agent];
    if (!profile) {
      const known = Object.keys(profiles).join(", ") || "(none)";
      return `ERROR: unknown agent "${agent}". Available: ${known}`;
    }

    ui.info(`→ spawning ${agent}`);
    const sub = createAgent(profile);
    await sub.turn(task, signal);
    const last = sub.state.messages
      .filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content)
      .pop();
    ui.info(`← ${agent} done`);
    return last?.content || "(no response)";
  },
};
