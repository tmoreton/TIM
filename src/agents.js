// Agents are persistent identities at $TIM_DIR/agents/*.md. Each agent owns
// a memory file (one per agent, bootstrapped at creation). Agents orchestrate
// workflows via spawn_workflow. Workflows — the task specs agents run — live
// separately in $TIM_DIR/workflows/ (see workflows.js).

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter, validateMeta, renderFrontmatter } from "./paths.js";
import { bootstrapMemory } from "./memory.js";

export const getAgentsDir = () => timPath("agents");

// Schema for agent frontmatter. Drives validation on load and the
// canonical template emitted by writeAgentProfile.
export const AGENT_SCHEMA = {
  name:        { type: "string", required: true,  doc: "Agent identifier (kebab-case)" },
  description: { type: "string", required: false, doc: "One-line description shown in `tim agent list`" },
  model:       { type: "string", required: false, doc: "Optional model override (e.g. claude-sonnet-4-6)" },
  tools:       { type: "array",  required: false, doc: "Tool allowlist — e.g. [read_file, bash, append_memory]. Omit for all tools." },
  skills:      { type: "array",  required: false, doc: "Skill allowlist — e.g. [deploy-nextjs-vercel, conventional-commit]. Omit for all skills." },
};

export function ensureAgentsDir() {
  fs.mkdirSync(getAgentsDir(), { recursive: true });
}

// Bootstrap default agent on first install (minimal tools for coding)
export function bootstrapDefaultAgent() {
  ensureAgentsDir();
  if (agentExists("default")) return false;
  writeAgentProfile("default", {
    description: "Minimal coding assistant",
    tools: [
      "read_file", "edit_file", "write_file", "bash",
      "grep", "glob", "list_files",
      "spawn_workflow", "update_memory", "append_memory",
      "web_search", "web_fetch"
    ],
    systemPrompt: `You are tim, a minimal coding assistant running in the current directory.

You have a focused set of tools for code editing and orchestration. For specialized tasks (images, research, etc.), use spawn_workflow to dispatch to the appropriate agent.

## Core principles
- Prefer grep/glob over reading whole directories
- You MUST read_file a file before edit_file
- Use edit_file for surgical changes; write_file only for new files or full rewrites
- Keep replies concise — when the task is done, stop and summarize`
  });
  return true;
}

export function agentExists(name) {
  return fs.existsSync(path.join(getAgentsDir(), `${name}.md`));
}

export function writeAgentProfile(name, { description = "", tools = null, skills = null, model = null, systemPrompt = "" }) {
  ensureAgentsDir();
  const normalizeList = (v) =>
    v === "all" || !v ? null
    : Array.isArray(v) ? v
    : String(v).split(",").map(s => s.trim()).filter(Boolean);
  const normalizedTools = normalizeList(tools);
  const normalizedSkills = normalizeList(skills);
  const meta = { name, description, model, tools: normalizedTools, skills: normalizedSkills };
  const filepath = path.join(getAgentsDir(), `${name}.md`);
  fs.writeFileSync(filepath, renderFrontmatter(meta, AGENT_SCHEMA, systemPrompt));
  bootstrapMemory(name, { description });
  return filepath;
}

export function deleteAgentProfile(name) {
  const p = path.join(getAgentsDir(), `${name}.md`);
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

export function loadAgents() {
  const agents = {};
  const dir = getAgentsDir();
  for (const file of readDir(dir)) {
    const full = path.join(dir, file);
    const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
    const name = meta.name || path.basename(file, ".md");
    const { errors, fatal } = validateMeta({ ...meta, name }, AGENT_SCHEMA);
    for (const e of errors) console.warn(`[agents] ${file}: ${e}`);
    if (fatal) continue;
    agents[name] = {
      name,
      description: meta.description || "",
      model: meta.model || null,
      tools: Array.isArray(meta.tools) ? meta.tools : null,   // null = all
      skills: Array.isArray(meta.skills) ? meta.skills : null, // null = all
      systemPrompt: body,
      source: full,
    };
  }
  return agents;
}
