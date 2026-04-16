// Loads sub-agent profiles (definitions) from $TIM_DIR/agents/*.md
// and .tim/agents/*.md in the current project. Each profile is a markdown
// file with YAML-style frontmatter. Used by spawn_agent and /agents.

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter } from "./paths.js";

export const getAgentsDir = () => timPath("agents");

export function ensureAgentsDir() {
  fs.mkdirSync(getAgentsDir(), { recursive: true });
}

export function agentExists(name) {
  return fs.existsSync(path.join(getAgentsDir(), `${name}.md`));
}

export function writeAgentProfile(name, { role, description, domain, produces, tools, systemPrompt }) {
  ensureAgentsDir();
  const lines = ["---", `name: ${name}`, `description: ${description}`, `role: ${role}`];
  if (domain) lines.push(`knowledgeDomain: ${domain}`);
  if (produces) lines.push(`produces: ${produces}`);
  if (tools && tools !== "all") lines.push(`tools: [${tools}]`);
  lines.push("---", "", systemPrompt);
  const filepath = path.join(getAgentsDir(), `${name}.md`);
  fs.writeFileSync(filepath, lines.join("\n") + "\n");
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
  const dirs = [timPath("agents"), path.join(process.cwd(), ".tim", "agents")];
  for (const dir of dirs) {
    for (const file of readDir(dir)) {
      const full = path.join(dir, file);
      const { meta, body } = parseFrontmatter(fs.readFileSync(full, "utf8"));
      const name = meta.name || path.basename(file, ".md");
      const produces = typeof meta.produces === "string" && meta.produces.includes("/")
        ? (() => {
            const [domain, ...rest] = meta.produces.split("/");
            return { domain, name: rest.join("/") };
          })()
        : null;
      agents[name] = {
        name,
        description: meta.description || "",
        model: meta.model || null,
        tools: Array.isArray(meta.tools) ? meta.tools : null, // null = all
        knowledgeDomain: meta.knowledgeDomain || null,
        knowledgeRefs: Array.isArray(meta.knowledgeRefs) ? meta.knowledgeRefs : null,
        role: meta.role === "director" ? "director" : "worker",
        produces,
        systemPrompt: body,
        source: full,
      };
    }
  }
  return agents;
}
