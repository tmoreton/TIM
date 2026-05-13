// Per-agent memory files at $TIM_DIR/memory/<agent>.md.
// One file per agent, bootstrapped at agent-creation time. Agents read their
// own memory (auto-loaded into system prompt) and may update or append to it
// when they learn something durable. Agents cannot create new memory files
// for other agents — that prevents the dated-file proliferation we had when
// knowledge was a free-form write target.

import fs from "node:fs";
import path from "node:path";
import { timPath, parseFrontmatter } from "./paths.js";

export const getMemoryDir = () => timPath("memory");

const ensureDir = () => {
  fs.mkdirSync(getMemoryDir(), { recursive: true });
  return getMemoryDir();
};

export const memoryPath = (agent) => path.join(getMemoryDir(), `${agent}.md`);

export const memoryExists = (agent) => fs.existsSync(memoryPath(agent));

// Bootstrap a new memory file for an agent. No-op if one already exists —
// we never overwrite the agent's own notes.
export function bootstrapMemory(agent, { description = "" } = {}) {
  ensureDir();
  const p = memoryPath(agent);
  if (fs.existsSync(p)) return p;
  const today = new Date().toISOString().split("T")[0];
  const body =
    `---\n` +
    `agent: ${agent}\n` +
    `description: ${description || `Persistent memory for the ${agent} agent`}\n` +
    `updated: ${today}\n` +
    `---\n\n` +
    `# ${agent} memory\n\n` +
    `Durable facts, patterns, and preferences for the ${agent} agent.\n` +
    `Ephemeral run output (daily reports, one-off findings) does not live here —\n` +
    `only things worth remembering across runs.\n`;
  fs.writeFileSync(p, body);
  return p;
}

export function readMemory(agent) {
  const p = memoryPath(agent);
  try {
    const content = fs.readFileSync(p, "utf8");
    const { meta, body } = parseFrontmatter(content);
    return { meta, body, path: p, agent };
  } catch {
    return null;
  }
}

// Full rewrite of the memory body. Keeps frontmatter's `agent` + `description`
// but refreshes `updated`. Use sparingly — prefer appendMemory for additions.
export function updateMemory(agent, body) {
  ensureDir();
  const existing = readMemory(agent);
  const today = new Date().toISOString().split("T")[0];
  const description = existing?.meta.description || `Persistent memory for the ${agent} agent`;
  const content =
    `---\n` +
    `agent: ${agent}\n` +
    `description: ${description}\n` +
    `updated: ${today}\n` +
    `---\n\n` +
    body.trim() + "\n";
  fs.writeFileSync(memoryPath(agent), content);
  return memoryPath(agent);
}

// Append a dated section to the memory body. Creates the file from a stub
// if the agent has no memory yet (should be rare — agent creation bootstraps).
export function appendMemory(agent, section, content) {
  ensureDir();
  const p = memoryPath(agent);
  const today = new Date().toISOString().split("T")[0];
  const entry = `\n## ${section} (${today})\n\n${content.trim()}\n`;
  if (!fs.existsSync(p)) bootstrapMemory(agent);
  fs.appendFileSync(p, entry);
  return p;
}

export function listMemories() {
  try {
    return fs.readdirSync(getMemoryDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// Format an agent's memory for injection into the system prompt.
export function formatMemoryForContext(agent) {
  const mem = readMemory(agent);
  if (!mem || !mem.body.trim()) return "";
  return `\n\n---\n\n## Your Memory (${agent})\n\n${mem.body}`;
}
