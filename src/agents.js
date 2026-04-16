// Loads sub-agent profiles (definitions) from $TIM_DIR/agents/*.md
// and .tim/agents/*.md in the current project. Each profile is a markdown
// file with YAML-style frontmatter. Used by spawn_agent and /agents.

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter } from "./paths.js";

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
      agents[name] = {
        name,
        description: meta.description || "",
        model: meta.model || null,
        tools: Array.isArray(meta.tools) ? meta.tools : null, // null = all
        knowledgeDomain: meta.knowledgeDomain || null,
        knowledgeRefs: Array.isArray(meta.knowledgeRefs) ? meta.knowledgeRefs : null,
        systemPrompt: body,
        source: full,
      };
    }
  }
  return agents;
}
