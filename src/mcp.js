// MCP (Model Context Protocol) client for connecting to external MCP servers.
// Supports stdio and HTTP SSE transports.
// See: https://modelcontextprotocol.io

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { timPath } from "./paths.js";

const MCP_CONFIG_PATH = () => timPath("mcp.json");

// Active MCP connections
const connections = new Map();

// Load MCP server configuration
export function loadMcpConfig() {
  try {
    const data = fs.readFileSync(MCP_CONFIG_PATH(), "utf8");
    return JSON.parse(data);
  } catch {
    return { servers: {} };
  }
}

// Save MCP server configuration
export function saveMcpConfig(config) {
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(MCP_CONFIG_PATH(), JSON.stringify(config, null, 2));
}

// List configured MCP servers
export function listMcpServers() {
  const config = loadMcpConfig();
  return Object.entries(config.servers || {}).map(([name, server]) => ({
    name,
    command: server.command,
    args: server.args,
    env: server.env ? Object.keys(server.env) : [],
    url: server.url,
    enabled: server.enabled !== false,
  }));
}

// Add a new MCP server
export function addMcpServer(name, serverConfig) {
  const config = loadMcpConfig();
  config.servers = config.servers || {};
  config.servers[name] = serverConfig;
  saveMcpConfig(config);
}

// Remove an MCP server
export function removeMcpServer(name) {
  const config = loadMcpConfig();
  if (config.servers?.[name]) {
    delete config.servers[name];
    saveMcpConfig(config);
    return true;
  }
  return false;
}

// Enable/disable an MCP server
export function setMcpServerEnabled(name, enabled) {
  const config = loadMcpConfig();
  if (config.servers?.[name]) {
    config.servers[name].enabled = enabled;
    saveMcpConfig(config);
    return true;
  }
  return false;
}

// Stdio transport connection
class StdioConnection {
  constructor(name, command, args, env) {
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.env = { ...process.env, ...env };
    this.process = null;
    this.messageId = 0;
    this.pending = new Map();
    this.tools = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let buffer = "";
      this.process.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim()) this.handleMessage(line);
        }
      });

      this.process.stderr.on("data", (data) => {
        // Log stderr for debugging
        console.error(`[mcp:${this.name}]`, data.toString().trim());
      });

      this.process.on("error", reject);
      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[mcp:${this.name}] exited with code ${code}`);
        }
        connections.delete(this.name);
      });

      // Initialize and list tools
      this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tim", version: "0.6.0" },
      }).then(() => this.request("tools/list", {})).then((result) => {
        this.tools = result?.tools || [];
        resolve(this);
      }).catch(reject);
    });
  }

  handleMessage(line) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
      }
    } catch (e) {
      console.error(`[mcp:${this.name}] Failed to parse message:`, e.message);
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        reject(new Error("MCP connection closed"));
        return;
      }
      const id = ++this.messageId;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process.stdin.write(msg);
    });
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    // Format result for display
    if (result?.content) {
      return result.content.map(c => {
        if (c.type === "text") return c.text;
        if (c.type === "image") return `[Image: ${c.mimeType}]`;
        return JSON.stringify(c);
      }).join("\n");
    }
    return JSON.stringify(result);
  }

  disconnect() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.pending.forEach(({ reject }) => reject(new Error("Connection closed")));
    this.pending.clear();
  }
}

// HTTP SSE transport (placeholder for future implementation)
class HttpConnection {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.tools = [];
  }

  async connect() {
    // TODO: Implement SSE transport
    throw new Error("HTTP SSE transport not yet implemented");
  }

  async callTool(name, args) {
    throw new Error("HTTP SSE transport not yet implemented");
  }

  disconnect() {}
}

// Connect to all enabled MCP servers
export async function connectMcpServers() {
  const config = loadMcpConfig();
  const servers = Object.entries(config.servers || {});

  for (const [name, server] of servers) {
    if (server.enabled === false) continue;
    if (connections.has(name)) continue; // Already connected

    try {
      let conn;
      if (server.url) {
        conn = new HttpConnection(name, server.url);
      } else if (server.command) {
        conn = new StdioConnection(name, server.command, server.args, server.env);
      } else {
        console.error(`[mcp:${name}] Missing command or url`);
        continue;
      }

      await conn.connect();
      connections.set(name, conn);
      console.error(`[mcp:${name}] Connected (${conn.tools.length} tools)`);
    } catch (e) {
      console.error(`[mcp:${name}] Failed to connect:`, e.message);
    }
  }

  return connections;
}

// Disconnect all MCP servers
export function disconnectMcpServers() {
  for (const [name, conn] of connections) {
    conn.disconnect();
    console.error(`[mcp:${name}] Disconnected`);
  }
  connections.clear();
}

// Get all available MCP tools
export function getMcpTools() {
  const tools = [];
  for (const [serverName, conn] of connections) {
    for (const tool of conn.tools) {
      tools.push({
        server: serverName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        _call: (args) => conn.callTool(tool.name, args),
      });
    }
  }
  return tools;
}

// Get a specific MCP tool
export function getMcpTool(serverName, toolName) {
  const conn = connections.get(serverName);
  if (!conn) return null;
  const tool = conn.tools.find(t => t.name === toolName);
  if (!tool) return null;
  return {
    server: serverName,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    _call: (args) => conn.callTool(tool.name, args),
  };
}
