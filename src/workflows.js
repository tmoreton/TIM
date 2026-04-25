// Workflows are task specs scheduled or invoked on demand. Each workflow
// references an agent (the identity that runs it) and carries the task
// prompt plus optional knobs (precheck tool, tool-allowlist override).
// Memory belongs to the agent, not the workflow — which is what lets us
// have multiple workflows per agent without fragmenting memory.

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter, validateMeta, renderFrontmatter } from "./paths.js";

export const getWorkflowsDir = () => timPath("workflows");

// Schema for workflow frontmatter. `task` is the default user message sent
// when the workflow fires without an override (used by triggers especially);
// the body is the system-prompt extension defining HOW to do the task.
export const WORKFLOW_SCHEMA = {
  name:        { type: "string", required: true,  doc: "Workflow identifier (kebab-case)" },
  description: { type: "string", required: false, doc: "One-line description shown in `tim workflow list`" },
  agent:       { type: "string", required: true,  doc: "Owning agent (must exist in $TIM_DIR/agents/)" },
  task:        { type: "string", required: false, doc: "Default user message sent when fired without an override (one line)" },
  precheck:    { type: "string", required: false, doc: "Optional shell command — workflow skips its run if this returns no output" },
  tools:       { type: "array",  required: false, doc: "Override the agent's tool allowlist for this workflow — e.g. [read_file, web_fetch]" },
  skills:      { type: "array",  required: false, doc: "Override the agent's skill allowlist for this workflow — e.g. [deploy-nextjs-vercel]" },
};

export function ensureWorkflowsDir() {
  fs.mkdirSync(getWorkflowsDir(), { recursive: true });
}

export function workflowExists(name) {
  return fs.existsSync(path.join(getWorkflowsDir(), `${name}.md`));
}

export function writeWorkflow(name, { description = "", agent, task = "", precheck = null, tools = null, skills = null, systemPrompt = "" }) {
  ensureWorkflowsDir();
  const meta = {
    name, description, agent,
    task: task ? task.replace(/\n/g, " ") : "",
    precheck: precheck || null,
    tools: Array.isArray(tools) && tools.length ? tools : null,
    skills: Array.isArray(skills) && skills.length ? skills : null,
  };
  const filepath = path.join(getWorkflowsDir(), `${name}.md`);
  fs.writeFileSync(filepath, renderFrontmatter(meta, WORKFLOW_SCHEMA, systemPrompt));
  return filepath;
}

export function deleteWorkflow(name) {
  const p = path.join(getWorkflowsDir(), `${name}.md`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

const readDir = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
};

export function loadWorkflows() {
  const workflows = {};
  for (const file of readDir(getWorkflowsDir())) {
    const full = path.join(getWorkflowsDir(), file);
    const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
    const name = meta.name || path.basename(file, ".md");
    const { errors, fatal } = validateMeta({ ...meta, name }, WORKFLOW_SCHEMA);
    for (const e of errors) console.warn(`[workflows] ${file}: ${e}`);
    if (fatal) continue;
    workflows[name] = {
      name,
      description: meta.description || "",
      agent: meta.agent,
      // `task` is the default user message sent when the workflow fires
      // without an override. The body is the system-prompt extension that
      // defines HOW the agent should approach this kind of task.
      task: typeof meta.task === "string" ? meta.task : "",
      systemPrompt: body,
      precheck: meta.precheck || null,
      tools: Array.isArray(meta.tools) ? meta.tools : null,
      skills: Array.isArray(meta.skills) ? meta.skills : null,
      source: full,
    };
  }
  return workflows;
}

// Merge a workflow's task-specific overrides onto its agent's base profile.
// Returns a new profile with combined tools, skills, and systemPrompt for
// a workflow run. Workflow allowlists override the agent's when set, so
// triggers can narrow (or expand, if the agent itself is narrower) the
// capability surface per task without editing the agent profile.
export function mergeProfile(agent, workflow) {
  return {
    ...agent,
    tools: workflow.tools || agent.tools,
    skills: workflow.skills || agent.skills,
    systemPrompt: workflow.systemPrompt
      ? `${agent.systemPrompt}\n\n## Current task — ${workflow.name}\n\n${workflow.systemPrompt}`
      : agent.systemPrompt,
  };
}
