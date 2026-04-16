// Tool registry. Core tools are built-in and filtered by required env vars
// (e.g. generate_image needs OPENROUTER_API_KEY). Custom tools are loaded
// from $TIM_DIR/tools/*.js and follow the same requiredEnv convention.

import { rehydrateReadsFromMessages, markRead } from "./fs.js";
import * as fs from "./fs.js";
import * as bash from "./bash.js";
import * as search from "./search.js";
import * as spawn from "./spawn.js";
import { loadCustomTools, reloadCustomTools } from "./custom.js";

import * as webFetch from "./web_fetch.js";
import * as webSearch from "./web_search.js";
import * as knowledge from "./knowledge.js";
import * as email from "./email.js";
import * as image from "./image.js";

// Core tools. `requiredEnv` (string | string[]) gates registration — tools
// with missing env vars are silently dropped so the model doesn't see them.
const coreToolDefs = {
  list_files: { schema: fs.schema, run: fs.run },
  read_file: { schema: fs.readSchema, run: fs.readRun },
  edit_file: { schema: fs.editSchema, run: fs.editRun },
  write_file: { schema: fs.writeSchema, run: fs.writeRun },
  bash: { schema: bash.schema, run: bash.run },
  grep: { schema: search.grepSchema, run: search.grepRun },
  glob: { schema: search.globSchema, run: search.globRun },
  spawn_agent: { schema: spawn.schema, run: spawn.run },
  web_fetch: { schema: webFetch.schema, run: webFetch.run },
  web_search: { schema: webSearch.schema, run: webSearch.run, requiredEnv: webSearch.requiredEnv },
  generate_image: { schema: image.schema, run: image.run, requiredEnv: image.requiredEnv },
  list_knowledge: { schema: knowledge.listKnowledgeSchema, run: knowledge.listKnowledgeRun },
  read_knowledge: { schema: knowledge.readKnowledgeSchema, run: knowledge.readKnowledgeRun },
  write_knowledge: { schema: knowledge.writeKnowledgeSchema, run: knowledge.writeKnowledgeRun },
  append_knowledge: { schema: knowledge.appendKnowledgeSchema, run: knowledge.appendKnowledgeRun },
  notify_email: { schema: email.notifyEmailSchema, run: email.notifyEmailRun },
  receive_email: { schema: email.receiveEmailSchema, run: email.receiveEmailRun },
  create_email_inbox: { schema: email.createInboxSchema, run: email.createInboxRun },
};

const hasRequiredEnv = (required) => {
  if (!required) return true;
  const vars = Array.isArray(required) ? required : [required];
  return vars.every((v) => process.env[v]);
};

const filterCoreTools = () =>
  Object.fromEntries(
    Object.entries(coreToolDefs).filter(([, t]) => hasRequiredEnv(t.requiredEnv)),
  );

// Merged tools (filtered core + custom). Built lazily so env vars from
// $TIM_DIR/.env are loaded by the time we decide what's registered.
let mergedTools = null;

async function getMergedTools() {
  if (mergedTools) return mergedTools;
  const core = filterCoreTools();
  const custom = await loadCustomTools();
  mergedTools = { ...core, ...custom };
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

// Force reload (after creating/editing custom tools, or after env changes).
export async function refreshTools() {
  mergedTools = null;
  return reloadCustomTools();
}

// Re-exports for fs tracking
export { rehydrateReadsFromMessages, markRead };
