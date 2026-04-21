// Agents are persistent identities at $TIM_DIR/agents/*.md. Each agent owns
// a memory file (one per agent, bootstrapped at creation). Agents orchestrate
// workflows via spawn_workflow. Workflows — the task specs agents run — live
// separately in $TIM_DIR/workflows/ (see workflows.js).

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter } from "./paths.js";
import { bootstrapMemory } from "./memory.js";

export const getAgentsDir = () => timPath("agents");

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

export function writeAgentProfile(name, { description = "", tools = null, systemPrompt = "" }) {
  ensureAgentsDir();
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (tools && tools !== "all") lines.push(`tools: [${tools}]`);
  lines.push("---", "", systemPrompt);
  const filepath = path.join(getAgentsDir(), `${name}.md`);
  fs.writeFileSync(filepath, lines.join("\n") + "\n");
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
  const dirs = [getAgentsDir(), path.join(process.cwd(), ".tim", "agents")];
  for (const dir of dirs) {
    for (const file of readDir(dir)) {
      const full = path.join(dir, file);
      const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
      const name = meta.name || path.basename(file, ".md");
      agents[name] = {
        name,
        description: meta.description || "",
        model: meta.model || null,
        tools: Array.isArray(meta.tools) ? meta.tools : null, // null = all
        systemPrompt: body,
        source: full,
      };
    }
  }
  return agents;
}
