// Loads agent profiles from ~/.tim/agents/*.md and ./.tim/agents/*.md.
// Project overrides global. Format: YAML-ish frontmatter + markdown body.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const parseFrontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]"))
      v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2].trim() };
};

const readDir = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
};

export function loadAgents() {
  const agents = {};
  const dirs = [
    path.join(os.homedir(), ".tim", "agents"),
    path.join(process.cwd(), ".tim", "agents"),
  ];
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
