// Custom tool loader - loads user-defined tools from $TIM_DIR/tools/*.js
// Tools are ES modules that export: schema (OpenAI function spec) and run(args, ctx)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const timDir = () => process.env.TIM_DIR || path.join(os.homedir(), ".tim");
const toolsDir = () => path.join(timDir(), "tools");

// Cache loaded tools
let customToolsCache = null;

export function getCustomToolsDir() {
  return toolsDir();
}

export function ensureToolsDir() {
  const dir = toolsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function loadCustomTools() {
  if (customToolsCache) return customToolsCache;
  
  const dir = toolsDir();
  const tools = {};
  
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const name = path.basename(file, ".js");
      
      try {
        // Use file URL for ES modules (Windows compatibility)
        const fileUrl = pathToFileURL(fullPath).href;
        // Add cache buster for hot reload in dev
        const module = await import(`${fileUrl}?t=${Date.now()}`);
        
        if (!module.schema || !module.run) {
          console.error(`[tim] Tool "${name}" missing schema or run export`);
          continue;
        }
        
        // Ensure schema has proper name
        const toolSchema = {
          ...module.schema,
          function: {
            ...module.schema.function,
            name: name, // Enforce filename as tool name
          },
        };
        
        tools[name] = {
          schema: toolSchema,
          run: module.run,
          source: fullPath,
          name,
        };
      } catch (e) {
        console.error(`[tim] Failed to load tool "${name}": ${e.message}`);
      }
    }
  } catch {
    // Dir doesn't exist, return empty
  }
  
  customToolsCache = tools;
  return tools;
}

export function clearCustomToolsCache() {
  customToolsCache = null;
}

// Reload tools (called after create/edit/delete)
export async function reloadCustomTools() {
  clearCustomToolsCache();
  return loadCustomTools();
}

// Get list of custom tool names for display
export async function listCustomToolNames() {
  const tools = await loadCustomTools();
  return Object.keys(tools);
}

// Read a tool's source code
export function readToolSource(name) {
  const dir = toolsDir();
  const filePath = path.join(dir, `${name}.js`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

// Ensure tools dir has package.json for ES modules
function ensurePackageJson() {
  const dir = toolsDir();
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ type: "module" }, null, 2));
  }
}

// Write/update a tool
export function writeToolSource(name, content) {
  const dir = ensureToolsDir();
  ensurePackageJson();
  const filePath = path.join(dir, `${name}.js`);
  fs.writeFileSync(filePath, content);
  clearCustomToolsCache();
  return filePath;
}

// Delete a tool
export function deleteTool(name) {
  const dir = toolsDir();
  const filePath = path.join(dir, `${name}.js`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  clearCustomToolsCache();
  return true;
}

// Template for new tools
export const toolTemplate = `// Custom tool: {{name}}
// Edit this file to implement your tool logic

export const schema = {
  type: "function",
  function: {
    name: "{{name}}",
    description: "Describe what this tool does...",
    parameters: {
      type: "object",
      properties: {
        example_param: {
          type: "string",
          description: "An example parameter",
        },
      },
      required: ["example_param"],
    },
  },
};

export async function run(args, ctx = {}) {
  const { example_param } = args;
  
  // ctx.signal is an AbortSignal for cancellation support
  // Return a string or { content: string, attachImages?: string[] }
  
  return \`You passed: \${example_param}\`;
}
`;

// Generate tool from template
export function generateToolTemplate(name) {
  return toolTemplate.replace(/\{\{name\}\}/g, name);
}
