// create_agent + create_workflow — let the model scaffold persistent agents
// and workflows without knowing the on-disk file format. Both wrap the
// canonical writers in agents.js / workflows.js, which use the schema-driven
// renderer (so frontmatter is always emitted in the same shape). To list
// existing ones, the model uses list_files on $TIM_DIR/agents or
// $TIM_DIR/workflows (the resolved path is in the system prompt).

import { writeAgentProfile, agentExists, loadAgents } from "../agents.js";
import { writeWorkflow, workflowExists } from "../workflows.js";

export const createAgentSchema = {
  type: "function",
  function: {
    name: "create_agent",
    description:
      "Create a new persistent agent at $TIM_DIR/agents/<name>.md. Agents are long-lived domain identities (e.g. 'youtube', 'github', 'reddit') with their own memory file, tool allowlist, and system prompt. ONE agent per domain — many workflows under it. " +
      "Before calling this, list_files on $TIM_DIR/agents (absolute path from the system prompt) to see what exists. If the user's request is a TASK within an existing agent's domain (e.g. 'youtube research', 'youtube thumbnail generator', 'youtube daily report' when a 'youtube' agent already exists), do NOT create a new agent — call create_workflow under that agent instead. " +
      "Only create a new agent when the request introduces a genuinely new domain that none of the existing agents cover. Fails if the agent already exists — the user must delete it first.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Agent identifier (kebab-case, e.g. 'youtube' or 'github-reviewer').",
        },
        description: {
          type: "string",
          description: "One-line description shown in `tim agent list`.",
        },
        system_prompt: {
          type: "string",
          description: "The agent's system prompt — describes its role, behavior, and how it should approach work. Markdown body, no frontmatter.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Tool allowlist (e.g. ['read_file', 'bash', 'web_fetch']). Omit or pass an empty array to allow all tools.",
        },
        model: {
          type: "string",
          description: "Optional model override (e.g. 'claude-sonnet-4-6'). Omit to use the global default.",
        },
      },
      required: ["name", "description", "system_prompt"],
    },
  },
};

export async function createAgentRun({ name, description, system_prompt, tools, model }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return `ERROR: agent name must be kebab-case (lowercase, digits, hyphens), got "${name}".`;
  }
  if (agentExists(name)) {
    return `ERROR: agent "${name}" already exists. Delete it first with \`tim agent delete ${name}\` if you want to recreate it.`;
  }
  const filepath = writeAgentProfile(name, {
    description: description || "",
    tools: Array.isArray(tools) && tools.length ? tools : null,
    model: model || null,
    systemPrompt: system_prompt,
  });
  return `Created agent "${name}" at ${filepath}. Memory file bootstrapped at $TIM_DIR/memory/${name}.md. Run with: \`tim ${name} "task"\`.`;
}

export const createWorkflowSchema = {
  type: "function",
  function: {
    name: "create_workflow",
    description:
      "Create a new workflow at $TIM_DIR/workflows/<name>.md. Workflows are task specs bound to an owning agent — they inherit the agent's identity and memory and add task-specific instructions. " +
      "This is the right tool when the user is asking for a TASK within an existing agent's domain (researcher / generator / writer / report / pipeline for an existing agent like youtube, github, reddit). The workflow's owning agent provides the domain expertise; the workflow describes how to do this specific job. " +
      "Before calling this, list_files on $TIM_DIR/workflows to avoid duplicates and on $TIM_DIR/agents to pick the right owner. Fails if the workflow already exists or if the owning agent doesn't.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Workflow identifier (kebab-case, e.g. 'daily-report').",
        },
        agent: {
          type: "string",
          description: "Owning agent name (must already exist).",
        },
        description: {
          type: "string",
          description: "One-line description shown in `tim workflow list`.",
        },
        system_prompt: {
          type: "string",
          description: "Task-specific system-prompt extension. Appended to the agent's base prompt for this workflow's runs — describes HOW the agent should approach this kind of task.",
        },
        task: {
          type: "string",
          description: "Optional default user message sent when the workflow fires without an override (used by triggers especially). One line.",
        },
        precheck: {
          type: "string",
          description: "Optional shell command — workflow skips its run if this returns no output.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Optional override of the agent's tool allowlist for this workflow.",
        },
      },
      required: ["name", "agent", "description", "system_prompt"],
    },
  },
};

export async function createWorkflowRun({ name, agent, description, system_prompt, task, precheck, tools }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return `ERROR: workflow name must be kebab-case (lowercase, digits, hyphens), got "${name}".`;
  }
  if (workflowExists(name)) {
    return `ERROR: workflow "${name}" already exists. Delete it first with \`tim workflow delete ${name}\` if you want to recreate it.`;
  }
  const agents = loadAgents();
  if (!agents[agent]) {
    const known = Object.keys(agents).join(", ") || "(none)";
    return `ERROR: agent "${agent}" does not exist. Create it first with create_agent. Known agents: ${known}.`;
  }
  const filepath = writeWorkflow(name, {
    description: description || "",
    agent,
    task: task || "",
    precheck: precheck || null,
    tools: Array.isArray(tools) && tools.length ? tools : null,
    systemPrompt: system_prompt,
  });
  return `Created workflow "${name}" (agent: ${agent}) at ${filepath}. Run with: \`tim run ${name}\` or via spawn_workflow.`;
}

export const tools = {
  create_agent: {
    schema: createAgentSchema, run: createAgentRun,
    promptSnippet: "create_agent: scaffold a new agent profile in $TIM_DIR/agents/",
  },
  create_workflow: {
    schema: createWorkflowSchema, run: createWorkflowRun,
    promptSnippet: "create_workflow: scaffold a workflow (task spec bound to an agent) in $TIM_DIR/workflows/",
  },
};
