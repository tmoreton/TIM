// CLI commands (/help, /model, /clear, /sessions, etc).
// Each command mutates state via react.js or prints status info.

import { getTools } from "./tools/index.js";
import {
  resetMessages,
  getModel,
  setModel,
  hasProjectContext,
  compact,
  getSessionId,
  createAgent,
} from "./react.js";
import { loadAgents } from "./agents.js";
import { loadWorkflows } from "./workflows.js";
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  connectMcpServers,
  disconnectMcpServers,
} from "./mcp.js";
import { readMemory, memoryPath, listMemories } from "./memory.js";
import { list as listSessions } from "./session.js";
import { setEnv, unsetEnv, listEnv, mask } from "./env.js";
import { setAutoAccept, isAutoAccept, setPlanMode, isPlanMode } from "./permissions.js";
import { c, info, success, error, exitHint } from "./ui.js";
import {
  getCustomToolsDir,
  ensureToolsDir,
  listCustomToolNames,
  readToolSource,
  writeToolSource,
  deleteTool,
  generateToolTemplate,
  reloadCustomTools,
} from "./tools/custom.js";
import { getModelCatalog } from "./llm.js";

const HELP_ROWS = [
  ["/help", "show this help"],
  ["/tools", "list tools (core + custom + MCP)"],
  ["/tool list", "list custom tools"],
  ["/tool create <name>", "create new custom tool in ~/.tim/tools/"],
  ["/tool edit <name>", "edit custom tool in $EDITOR"],
  ["/tool delete <name>", "delete custom tool"],
  ["/mcp", "manage MCP servers (list | add | remove | enable | disable | reconnect)"],
  ["/model [id|#]", "list or switch model (alias: /models)"],
  ["/clear", "reset conversation (starts a new session)"],
  ["/context", "show whether TIM.md was loaded"],
  ["/compact", "summarize older messages to free context"],
  ["/sessions", "list saved sessions"],
  ["/agents", "list agents"],
  ["/agent <name> [task/file]", "run an agent directly"],
  ["/workflows", "list workflows (task specs for agents)"],
  ["/workflow <name> [task]", "run a workflow"],
  ["/memory [agent]", "show memory file path (or contents) for an agent"],
  ["/env", "manage $TIM_DIR/.env (list | set KEY=VAL | unset KEY | email)"],
  ["/yolo", "toggle auto-accept for edits and bash (USE WITH CARE)"],
  ["/plan", "toggle plan mode — model drafts a plan, no edits/bash run"],
  ["/exit", "quit"],
];

const EMAIL_ENV_HELP = [
  ["AGENTMAIL_API_KEY", "AgentMail API key for send + receive (recommended)"],
  ["AGENTMAIL_INBOX_ID", "Default AgentMail inbox (send from + receive to)"],
  ["AGENTMAIL_WHITELIST", "Allowed sender emails/domains for incoming (required)"],
  ["SMTP_HOST", "SMTP server hostname (fallback)"],
  ["SMTP_USER", "SMTP username"],
  ["SMTP_PASS", "SMTP password"],
  ["SMTP_PORT", "SMTP port (default: 587)"],
  ["SMTP_SECURE", "Force TLS (default: true for port 465)"],
  ["SMTP_FROM", "Default sender for SMTP emails"],
];

const INPUT_ROWS = [
  ["\\ at EOL", "continue on next line"],
  [`""" line`, "toggle a multi-line block"],
];

const FLAG_ROWS = [
  ["tim", "start fresh"],
  ["tim --resume [id]", "resume latest or by id"],
  ["tim --list", "list sessions and exit"],
  ["tim --yolo", "start with auto-accept on (use with care)"],
  ["tim agent new [name]", "create a new agent (guided)"],
  ["tim agent list", "list all agents"],
  ["tim agent edit <name>", "open agent profile in $EDITOR"],
  ["tim agent delete <name>", "delete an agent profile"],
  ["tim workflow new [name]", "create a new workflow (task spec)"],
  ["tim workflow list", "list all workflows"],
  ["tim workflow edit <name>", "open workflow in $EDITOR"],
  ["tim workflow delete <name>", "delete a workflow"],
  ["tim run <workflow|agent> \"task\"", "run a workflow or agent headlessly"],
];

const ATTACHMENT_ROWS = [
  ["/path/to/image.png", "attach image by path (drag & drop works!)"],
  ["/path/to/doc.pdf", "attach PDF by path"],
  ["multiple files", "just include multiple paths in your prompt"],
];

const printRows = (title, rows) => {
  console.log();
  console.log("  " + c.bold(c.teal(title)));
  const pad = Math.max(...rows.map((r) => r[0].length)) + 2;
  for (const [k, v] of rows)
    console.log(`    ${c.white(k.padEnd(pad))} ${c.dim(v)}`);
};

const printHelp = () => {
  printRows("commands", HELP_ROWS);
  printRows("input", INPUT_ROWS);
  printRows("attachments (drag & drop!)", ATTACHMENT_ROWS);
  printRows("launch flags", FLAG_ROWS);
  console.log();
};

// A command is `/word` (optionally followed by args) — not a file path like `/Users/...`.
export const isCommand = (input) => /^\/[a-zA-Z][a-zA-Z0-9_-]*(\s|$)/.test(input);

const runAndPrintLast = async (sub, task, label) => {
  await sub.turn(task);
  const last = sub.state.messages
    .filter((m) => m.role === "assistant" && !m.tool_calls?.length && m.content).pop();
  success(`${label} done`);
  if (last?.content) { console.log(); console.log(last.content); }
};

export async function runCommand(input) {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      printHelp();
      return;
    case "tools": {
      const tools = await getTools();
      const customNames = await listCustomToolNames();
      const mcpTools = Object.entries(tools).filter(([, t]) => t.isMcp);
      const coreNames = Object.keys(tools).filter(n => !customNames.includes(n) && !tools[n].isMcp);
      console.log();
      console.log("  " + c.bold(c.teal("core tools")));
      for (const name of coreNames) console.log(`  ${c.teal("•")} ${c.white(name)}`);
      if (customNames.length) {
        console.log();
        console.log("  " + c.bold(c.teal("custom tools")));
        for (const name of customNames) console.log(`  ${c.teal("•")} ${c.white(name)} ${c.dim("(custom)")}`);
      }
      if (mcpTools.length) {
        console.log();
        console.log("  " + c.bold(c.teal("MCP tools")));
        const servers = [...new Set(mcpTools.map(([, t]) => t.server))];
        for (const server of servers) {
          console.log(`  ${c.teal("▸")} ${c.white(server)}`);
          for (const [name, t] of mcpTools.filter(([, t2]) => t2.server === server)) {
            console.log(`    ${c.dim("•")} ${c.white(t.originalName)}`);
          }
        }
      }
      console.log();
      return;
    }
    case "model":
    case "models": {
      const catalog = getModelCatalog();
      const current = await getModel();
      if (!arg) {
        console.log();
        console.log(`  ${c.bold(c.teal("current"))}  ${c.white(current)}`);
        if (catalog.length) {
          console.log();
          console.log(`  ${c.bold(c.teal("quick-pick"))}`);
          const pad = Math.max(...catalog.map((m) => m.id.length)) + 2;
          for (const [i, m] of catalog.entries()) {
            const marker = m.id === current ? c.teal(" ← current") : "";
            console.log(
              `  ${c.teal(String(i + 1).padStart(2))}. ${c.white(m.id.padEnd(pad))} ${c.dim(m.label)}${marker}`,
            );
          }
        }
        if (!process.env.OPENROUTER_API_KEY) {
          console.log();
          console.log(`  ${c.dim("set OPENROUTER_API_KEY to unlock more models")}`);
        }
        console.log();
        info("switch by number (e.g. /model 2) or by ID (e.g. /model openrouter/anthropic/claude-sonnet-4.5)");
        return;
      }
      const n = Number(arg);
      const target = Number.isInteger(n) && n >= 1 && n <= catalog.length ? catalog[n - 1].id : arg;
      await setModel(target);
      success(`model → ${target}`);
      return;
    }
    case "clear":
      await resetMessages();
      success("conversation cleared — new session");
      return;
    case "context":
      info(hasProjectContext() ? "TIM.md loaded" : "no TIM.md found");
      return;
    case "compact": {
      info("compacting...");
      const msg = await compact();
      success(msg);
      return;
    }
    case "sessions": {
      const all = listSessions();
      if (!all.length) return info("(no sessions)");
      console.log();
      for (const s of all.slice(0, 20)) {
        const when = new Date(s.updatedAt).toISOString().replace("T", " ").slice(0, 19);
        console.log(
          `  ${c.teal(s.id.slice(0, 19))}  ${c.dim(`[${s.turns} turns]`)}  ${c.dim(when)}  ${c.white(s.cwd)}`,
        );
      }
      console.log();
      return;
    }
    case "env": {
      const [sub, ...kvParts] = arg.split(/\s+/);
      const kv = kvParts.join(" ");
      if (!sub || sub === "list") {
        const entries = listEnv();
        if (!entries.length) return info("(no env vars in $TIM_DIR/.env)");
        console.log();
        const pad = Math.max(...entries.map((e) => e.key.length)) + 2;
        for (const e of entries)
          console.log(`  ${c.teal(e.key.padEnd(pad))} ${c.dim(mask(e.value))}`);
        console.log();
        return;
      }
      if (sub === "set") {
        const m = kv.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
        if (!m) return error("usage: /env set KEY=value");
        const val = m[2].replace(/^["'](.*)["']$/, "$1");
        setEnv(m[1], val);
        success(`set ${m[1]} (${mask(val)})`);
        return;
      }
      if (sub === "unset") {
        if (!kv) return error("usage: /env unset KEY");
        unsetEnv(kv.trim());
        success(`unset ${kv.trim()}`);
        return;
      }
      if (sub === "email") {
        console.log();
        console.log("  " + c.bold(c.teal("email configuration")));
        console.log("  " + c.dim("Sending: AGENTMAIL_API_KEY (recommended) or SMTP_* vars"));
        console.log("  " + c.dim("Receiving: AGENTMAIL_API_KEY + AGENTMAIL_WHITELIST (required)"));
        console.log();
        const pad = Math.max(...EMAIL_ENV_HELP.map((r) => r[0].length)) + 2;
        for (const [k, v] of EMAIL_ENV_HELP) {
          console.log(`  ${c.teal(k.padEnd(pad))} ${c.dim(v)}`);
        }
        console.log();
        return;
      }
      return error("usage: /env [list | set KEY=VAL | unset KEY | email]");
    }
    case "agents": {
      const profiles = Object.values(loadAgents());
      if (!profiles.length) {
        info("no agents found — run: tim agent new");
        return;
      }
      const pad = Math.max(...profiles.map((p) => p.name.length)) + 2;
      console.log();
      console.log(`  ${c.bold(c.teal("agents"))}`);
      for (const p of profiles) {
        console.log(`    ${c.white(p.name.padEnd(pad))} ${c.dim(p.description)}`);
      }
      console.log();
      info("create: tim agent new  •  edit: tim agent edit <name>  •  run: tim run <name> \"task\"");
      return;
    }
    case "workflows": {
      const workflows = Object.values(loadWorkflows());
      if (!workflows.length) {
        info("no workflows found — run: tim workflow new");
        return;
      }
      const pad = Math.max(...workflows.map((w) => w.name.length)) + 2;
      console.log();
      console.log(`  ${c.bold(c.teal("workflows"))}`);
      for (const w of workflows) {
        const agent = c.dim(` [${w.agent}]`);
        console.log(`    ${c.white(w.name.padEnd(pad))}${agent} ${c.dim(w.description)}`);
      }
      console.log();
      info("create: tim workflow new  •  run: tim run <workflow> \"override task\"");
      return;
    }
    case "workflow": {
      const [workflowName, ...taskParts] = arg.split(/\s+/);
      if (!workflowName) return error("usage: /workflow <name> [task]");
      const workflow = loadWorkflows()[workflowName];
      if (!workflow) {
        const known = Object.keys(loadWorkflows()).join(", ") || "(none)";
        return error(`unknown workflow "${workflowName}". Available: ${known}`);
      }
      const agent = loadAgents()[workflow.agent];
      if (!agent) return error(`workflow "${workflowName}" references agent "${workflow.agent}" which is missing`);
      const task = taskParts.join(" ").trim() || workflow.task || `Run the ${workflow.name} workflow.`;
      const subProfile = {
        ...agent,
        tools: workflow.tools || agent.tools,
        systemPrompt: workflow.systemPrompt
          ? `${agent.systemPrompt}\n\n## Current task — ${workflow.name}\n\n${workflow.systemPrompt}`
          : agent.systemPrompt,
      };
      info(`→ running workflow ${workflowName} (agent: ${agent.name})`);
      await runAndPrintLast(await createAgent(subProfile), task, workflowName);
      return;
    }
    case "agent": {
      const [agentName, ...taskParts] = arg.split(/\s+/);
      let task = taskParts.join(" ").trim();
      if (!agentName) return error("usage: /agent <name> [task or file path]");
      const profiles = loadAgents();
      const profile = profiles[agentName];
      if (!profile) {
        const known = Object.keys(profiles).join(", ") || "(none)";
        return error(`unknown agent "${agentName}". Available: ${known}`);
      }
      if (task && /^[/~]|^\.\//.test(task)) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const os = await import("node:os");
        const resolved = task.startsWith("~") ? path.join(os.homedir(), task.slice(1)) : task;
        try {
          task = fs.readFileSync(resolved, "utf8");
          info(`loaded script from ${resolved}`);
        } catch (e) {
          return error(`could not read file: ${e.message}`);
        }
      }
      if (!task) return error("please provide a task or file path for the agent");
      info(`→ running ${agentName} agent...`);
      await runAndPrintLast(await createAgent(profile), task, agentName);
      return;
    }
    case "yolo":
    case "auto": {
      const next = !isAutoAccept();
      setAutoAccept(next);
      if (next)
        console.log(
          `  ${c.yellow("⚠")}  ${c.bold("auto-accept ON")} ${c.dim("— edits and bash commands will run without prompting")}`,
        );
      else success("auto-accept OFF");
      return;
    }
    case "plan": {
      const next = !isPlanMode();
      setPlanMode(next);
      if (next)
        console.log(
          `  ${c.teal("◐")}  ${c.bold("plan mode ON")} ${c.dim("— model will draft a plan; edit_file/write_file/bash are blocked")}`,
        );
      else success("plan mode OFF — ask the model to proceed with the plan");
      return;
    }
    case "tool": {
      const [sub, name] = arg.split(/\s+/);
      if (!sub || sub === "list") {
        const custom = await listCustomToolNames();
        console.log();
        console.log("  " + c.bold(c.teal("custom tools")));
        if (custom.length) {
          for (const n of custom) console.log(`  ${c.teal("•")} ${c.white(n)}`);
        } else {
          console.log(`  ${c.dim("(none — create one with /tool create <name>)")}`);
        }
        console.log();
        return;
      }
      if (sub === "create") {
        if (!name) return error("usage: /tool create <name>");
        ensureToolsDir();
        const p = writeToolSource(name, generateToolTemplate(name));
        await reloadCustomTools();
        success(`created ${p}`);
        info("edit the file to implement your tool logic");
        return;
      }
      if (sub === "edit") {
        if (!name) return error("usage: /tool edit <name>");
        const p = `${getCustomToolsDir()}/${name}.js`;
        if (!readToolSource(name)) return error(`tool "${name}" not found at ${p}`);
        const { spawnSync } = await import("node:child_process");
        spawnSync(process.env.EDITOR || "vi", [p], { stdio: "inherit" });
        await reloadCustomTools();
        success(`reloaded ${name}`);
        return;
      }
      if (sub === "delete") {
        if (!name) return error("usage: /tool delete <name>");
        if (!deleteTool(name)) return error(`tool "${name}" not found`);
        success(`deleted ${name}`);
        return;
      }
      return error("usage: /tool [list|create|edit|delete] <name>");
    }
    case "memory": {
      if (!arg) {
        const mems = listMemories();
        console.log();
        console.log("  " + c.bold(c.teal("agent memory files")));
        if (mems.length) {
          for (const m of mems) console.log(`  ${c.teal("•")} ${c.white(m)}  ${c.dim(memoryPath(m))}`);
        } else {
          console.log(`  ${c.dim("(no memory files — create an agent with 'tim agent new')")}`);
        }
        console.log();
        info("use /memory <agent> to print that agent's memory contents");
        return;
      }
      const mem = readMemory(arg);
      if (!mem) return error(`no memory file for agent "${arg}" — create it with 'tim agent new'`);
      console.log();
      console.log("  " + c.bold(c.teal(`memory: ${arg}`)) + "  " + c.dim(mem.path));
      console.log();
      console.log(mem.body);
      console.log();
      return;
    }
    case "mcp": {
      const [sub, name, ...restArgs] = arg.split(/\s+/);
      if (!sub || sub === "list") {
        const servers = listMcpServers();
        console.log();
        console.log("  " + c.bold(c.teal("MCP servers")));
        if (servers.length) {
          const pad = Math.max(...servers.map((s) => s.name.length)) + 2;
          for (const s of servers) {
            const status = s.enabled ? c.teal("●") : c.dim("○");
            const cmd = s.url ? s.url : `${s.command} ${s.args?.join(" ") || ""}`.trim();
            console.log(`  ${status} ${c.white(s.name.padEnd(pad))} ${c.dim(cmd)}`);
          }
        } else {
          console.log(`  ${c.dim("(none — add one with /mcp add <name> <command> [args...])")}`);
        }
        console.log();
        info("add, remove, enable, disable, or reconnect MCP servers");
        return;
      }
      if (sub === "add") {
        if (!name) return error("usage: /mcp add <name> <command> [args...]");
        const cmdArgs = restArgs;
        if (!cmdArgs.length) return error("usage: /mcp add <name> <command> [args...]");
        const [cmd, ...args] = cmdArgs;
        addMcpServer(name, { command: cmd, args, enabled: true });
        success(`added MCP server "${name}"`);
        info(`restart or run /mcp reconnect to connect`);
        return;
      }
      if (sub === "remove") {
        if (!name) return error("usage: /mcp remove <name>");
        if (!removeMcpServer(name)) return error(`MCP server "${name}" not found`);
        success(`removed MCP server "${name}"`);
        return;
      }
      if (sub === "enable") {
        if (!name) return error("usage: /mcp enable <name>");
        if (!setMcpServerEnabled(name, true)) return error(`MCP server "${name}" not found`);
        success(`enabled MCP server "${name}"`);
        return;
      }
      if (sub === "disable") {
        if (!name) return error("usage: /mcp disable <name>");
        if (!setMcpServerEnabled(name, false)) return error(`MCP server "${name}" not found`);
        success(`disabled MCP server "${name}"`);
        return;
      }
      if (sub === "reconnect") {
        disconnectMcpServers();
        await connectMcpServers();
        success("reconnected to MCP servers");
        return;
      }
      return error("usage: /mcp [list|add|remove|enable|disable|reconnect] [args...]");
    }
    case "exit":
    case "quit":
      exitHint(await getSessionId());
      process.exit(0);
    default:
      error(`unknown command: /${cmd} — try /help`);
  }
}
