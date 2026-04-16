// Tool registry - exports all tools and their OpenAI-compatible schemas.
// Core tools are built-in. Custom tools loaded from $TIM_DIR/tools/*.js

import { rehydrateReadsFromMessages, markRead } from "./fs.js";
import * as fs from "./fs.js";
import * as bash from "./bash.js";
import * as search from "./search.js";
import * as spawn from "./spawn.js";
import { loadCustomTools, reloadCustomTools } from "./custom.js";

import * as webFetch from "./web_fetch.js";

// Core built-in tools (universal, no external API keys)
const coreTools = {
  list_files: { schema: fs.schema, run: fs.run },
  read_file: { schema: fs.readSchema, run: fs.readRun },
  edit_file: { schema: fs.editSchema, run: fs.editRun },
  write_file: { schema: fs.writeSchema, run: fs.writeRun },
  bash: { schema: bash.schema, run: bash.run },
  grep: { schema: search.grepSchema, run: search.grepRun },
  glob: { schema: search.globSchema, run: search.globRun },
  spawn_agent: { schema: spawn.schema, run: spawn.run },
  web_fetch: { schema: webFetch.schema, run: webFetch.run },
};

// Merged tools (core + custom)
let mergedTools = null;

async function getMergedTools() {
  if (mergedTools) return mergedTools;
  const custom = await loadCustomTools();
  mergedTools = { ...coreTools, ...custom };
  return mergedTools;
}

export async function getTools() {
  return getMergedTools();
}

export async function getToolSchemas() {
  const all = await getMergedTools();
  return Object.values(all).map((t) => t.schema);
}

export async function getTool(name) {
  const all = await getMergedTools();
  return all[name];
}

export async function hasTool(name) {
  const all = await getMergedTools();
  return name in all;
}

// Force reload (after creating/editing custom tools)
export async function refreshTools() {
  mergedTools = null;
  return reloadCustomTools();
}

// Legacy sync exports (core tools only - for startup/system use)
export const tools = coreTools;
export const toolSchemas = Object.values(coreTools).map((t) => t.schema);

// Re-exports for fs tracking
export { rehydrateReadsFromMessages, markRead };
