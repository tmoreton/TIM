// Tool registry. Core tools are built-in and filtered by required env vars.
// MCP tools are loaded from external MCP servers configured in $TIM_DIR/mcp.json.

import { rehydrateReadsFromMessages, markRead } from "./fs.js";
import * as fs from "./fs.js";
import * as bash from "./bash.js";
import * as search from "./search.js";
import * as spawn from "./spawn.js";
import { connectMcpServers, getMcpTools } from "../mcp.js";

import * as webFetch from "./web_fetch.js";
import * as webSearch from "./web_search.js";
import * as memory from "./memory.js";
import * as screenshot from "./screenshot.js";

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
  spawn_workflow: { schema: spawn.schema, run: spawn.run },
  web_fetch: { schema: webFetch.schema, run: webFetch.run },
  web_search: { schema: webSearch.schema, run: webSearch.run, requiredEnv: webSearch.requiredEnv },
  update_memory: { schema: memory.updateMemorySchema, run: memory.updateMemoryRun },
  append_memory: { schema: memory.appendMemorySchema, run: memory.appendMemoryRun },
  capture_webpage: { schema: screenshot.captureWebpageSchema, run: screenshot.captureWebpageRun },
  capture_desktop: { schema: screenshot.captureDesktopSchema, run: screenshot.captureDesktopRun },
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

// Merged tools (filtered core + custom + MCP). Built lazily so env vars from
// $TIM_DIR/.env are loaded by the time we decide what's registered.
let mergedTools = null;
let mcpConnected = false;

async function getMergedTools() {
  if (mergedTools) return mergedTools;
  const core = filterCoreTools();

  // Connect to MCP servers and add their tools
  if (!mcpConnected) {
    await connectMcpServers();
    mcpConnected = true;
  }
  const mcpTools = getMcpTools();
  const mcpToolDefs = {};
  for (const tool of mcpTools) {
    const fullName = `mcp_${tool.server}_${tool.name}`;
    mcpToolDefs[fullName] = {
      schema: {
        type: "function",
        function: {
          name: fullName,
          description: `[${tool.server}] ${tool.description}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      },
      run: async (args) => {
        return await tool._call(args);
      },
      isMcp: true,
      server: tool.server,
      originalName: tool.name,
    };
  }

  mergedTools = { ...core, ...mcpToolDefs };
  return mergedTools;
}

export async function getTools() {
  return getMergedTools();
}

export async function getToolSchemas() {
  const all = await getMergedTools();
  return Object.values(all).map((t) => t.schema);
}

// Re-exports for fs tracking
export { rehydrateReadsFromMessages, markRead };
