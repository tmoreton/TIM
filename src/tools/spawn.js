// spawn_workflow: run a workflow as a short-lived sub-session. The workflow
// declares which agent owns it (identity, memory, default tools) and adds a
// task-specific system prompt + optional tool-allowlist override. Results
// are returned inline to the caller — no files written on the side.

import { createAgent } from "../react.js";
import { loadWorkflows } from "../workflows.js";
import { loadAgents } from "../agents.js";
import * as ui from "../ui.js";

export const schema = {
  type: "function",
  function: {
    name: "spawn_workflow",
    description:
      "Run a workflow as a sub-session. Workflows are task specs in $TIM_DIR/workflows/ that inherit identity + memory from their parent agent. Returns the workflow's final reply as a string — use it directly, don't expect a side-effect file. Use for research, focused investigation, or any task with a self-contained scope.",
    parameters: {
      type: "object",
      properties: {
        workflow: { type: "string", description: "Workflow name (see /workflows)" },
        task: { type: "string", description: "The task or question for the workflow" },
      },
      required: ["workflow", "task"],
    },
  },
};

export async function run({ workflow, task }, { signal }) {
  const workflows = loadWorkflows();
  const w = workflows[workflow];
  if (!w) {
    const known = Object.keys(workflows).join(", ") || "(none)";
    return `ERROR: unknown workflow "${workflow}". Available: ${known}`;
  }

  const agents = loadAgents();
  const agent = agents[w.agent];
  if (!agent) {
    return `ERROR: workflow "${workflow}" references agent "${w.agent}" which does not exist.`;
  }

  // Compose a sub-profile: agent identity (for memory auto-load) + workflow's
  // task-specific instructions appended to the agent's base prompt. Tool and
  // skill allowlists can both be narrowed by the workflow.
  const subProfile = {
    ...agent,
    tools: w.tools || agent.tools,
    skills: w.skills || agent.skills,
    systemPrompt: w.systemPrompt
      ? `${agent.systemPrompt}\n\n## Current task — ${workflow}\n\n${w.systemPrompt}`
      : agent.systemPrompt,
  };

  ui.info(`→ spawning workflow ${workflow} (agent: ${w.agent})`);
  const sub = await createAgent(subProfile);
  await sub.turn(task, signal);

  const last = sub.state.messages
    .filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content)
    .pop();
  const fullText = last?.content || "";

  ui.info(`← ${workflow} done`);
  return fullText;
}

export const tools = {
  spawn_workflow: {
    schema, run,
    promptSnippet: "spawn_workflow: run a workflow sub-session (returns final reply as a string)",
    promptGuidelines: [
      "Use spawn_workflow for task-shaped work with a self-contained scope (research, focused investigation). The result is returned to you — don't expect a side-effect file.",
    ],
  },
};
