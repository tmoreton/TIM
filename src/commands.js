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
import { loadTriggers, runTrigger, triggerExists } from "./triggers.js";
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
import { getModelCatalog } from "./llm.js";

const HELP_ROWS = [
  ["/help", "this help"],
  ["/tools", "core, custom, and MCP tools"],
  ["/mcp", "manage MCP servers"],
  ["/model [#|id]", "show or switch model"],
  ["/agents", "list agents"],
  ["/agent <name>", "run agent (optionally: task or @file)"],
  ["/workflows", "list workflows"],
  ["/workflow <name>", "run workflow"],
  ["/triggers", "scheduled cron triggers"],
  ["/memory [agent]", "agent memory path/contents"],
  ["/env [cmd]", "env vars: list, set KEY=VAL, unset KEY"],
  ["/loc", "source lines of code"],
  ["/clear", "new session"],
  ["/compact", "summarize old messages"],
  ["/sessions", "saved conversations"],
  ["/auto", "toggle auto-accept (set TIM_AUTO_ACCEPT=1 in $TIM_DIR/.env to persist)"],
  ["/plan", "draft without executing"],
  ["/exit", "quit"],
];

// Note: tim <agent> starts interactive chat with that agent (not listed in /help to avoid confusion)

const FLAG_ROWS = [
  ["tim", "start fresh interactive session"],
  ["tim <agent>", "chat interactively with a specific agent"],
  ["tim <agent> --yolo", "chat with agent + auto-accept mode"],
  ["tim --resume [id]", "resume latest session, or by id"],
  ["tim --list", "list saved sessions and exit"],
  ["tim --yolo", "start with auto-accept enabled (use with care)"],
  ["TIM_AUTO_ACCEPT=1 tim", "default to auto-accept on startup (save in $TIM_DIR/.env)"],
  ["tim agent new [name]", "create a new agent (interactive)"],
  ["tim agent list", "list all agents"],
  ["tim agent edit <name>", "open agent profile in $EDITOR"],
  ["tim agent delete <name>", "delete an agent profile"],
  ["tim workflow new [name]", "create a new workflow (interactive)"],
  ["tim workflow list", "list all workflows"],
  ["tim workflow edit <name>", "open workflow in $EDITOR"],
  ["tim workflow delete <name>", "delete a workflow"],
  ["tim trigger list", "list scheduled triggers"],
  ["tim trigger add <name>", "create a scheduled trigger (interactive)"],
  ["tim trigger remove <name>", "remove a scheduled trigger"],
  ["tim trigger run <name>", "run a trigger immediately"],
  ["tim start", "start the cron scheduler daemon (auto-restarts on crash)"],
  ["tim run <workflow|agent> \"task\"", "run a workflow or agent headlessly"],
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
      const mcpTools = Object.entries(tools).filter(([, t]) => t.isMcp);
      const coreNames = Object.keys(tools).filter(n => !tools[n].isMcp);
      console.log();
      console.log("  " + c.bold(c.teal("core tools")));
      for (const name of coreNames) console.log(`  ${c.teal("•")} ${c.white(name)}`);
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
          console.log();
          const pad = Math.max(...catalog.map((m) => m.id.length)) + 2;
          for (const [i, m] of catalog.entries()) {
            const marker = m.id === current ? c.teal(" ← current") : "";
            const num = c.teal(String(i + 1).padStart(2));
            const id = c.white(m.id.padEnd(pad));
            const label = c.dim(m.label);
            console.log(`  ${num}  ${id}  ${label}${marker}`);
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
    case "clear": {
      const { isAgentMode } = await import("./react.js");
      const wasAgentMode = isAgentMode();
      await resetMessages();
      if (wasAgentMode) {
        success("conversation cleared — new session (run /agent <name> to chat with another agent)");
      } else {
        success("conversation cleared — new session");
      }
      return;
    }
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
      
      // Group by folder
      const grouped = {};
      for (const s of all) {
        if (!grouped[s.folder]) grouped[s.folder] = [];
        grouped[s.folder].push(s);
      }
      
      console.log();
      for (const [folder, sessions] of Object.entries(grouped).slice(0, 5)) {
        console.log(`  ${c.bold(c.white(folder))}`);
        for (const s of sessions.slice(0, 5)) {
          const when = new Date(s.updatedAt).toISOString().replace("T", " ").slice(0, 19);
          console.log(
            `    ${c.teal(s.id.slice(0, 19))}  ${c.dim(`[${s.turns} turns]`)}  ${c.dim(when)}`,
          );
        }
        if (sessions.length > 5) {
          console.log(`    ${c.dim(`... and ${sessions.length - 5} more`)}`);
        }
        console.log();
      }
      if (Object.keys(grouped).length > 5) {
        info(`... and ${Object.keys(grouped).length - 5} more folders`);
      }
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
      return error("usage: /env [list | set KEY=VAL | unset KEY]");
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
      info("create: tim agent new  •  edit: tim agent edit <name>  •  chat: tim <agent>  •  run: tim run <name> \"task\"");
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
      info(`→ running workflow ${workflowName} (agent: ${agent.name})`);
      await runAndPrintLast(await createAgent(mergeProfile(agent, workflow)), task, workflowName);
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
    case "auto":
    case "yolo": {
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
      if (next) {
        console.log(
          `  ${c.teal("◐")}  ${c.bold("plan mode ON")} ${c.dim("— model will draft a plan; edit_file/write_file/bash are blocked")}`,
        );
        return;
      }
      success("plan mode OFF — ready to execute");
      return;
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
      if (sub === "enable" || sub === "disable") {
        if (!name) return error(`usage: /mcp ${sub} <name>`);
        const on = sub === "enable";
        if (!setMcpServerEnabled(name, on)) return error(`MCP server "${name}" not found`);
        success(`${sub}d MCP server "${name}"`);
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
    case "trigger":
    case "schedule": {
      const [sub, name] = arg.split(/\s+/);
      if (!sub || sub === "list") {
        const triggers = loadTriggers();
        console.log();
        console.log("  " + c.bold(c.teal("scheduled triggers")));
        if (triggers.length) {
          const pad = Math.max(...triggers.map((t) => t.name.length)) + 2;
          for (const t of triggers) {
            const status = t.enabled ? c.teal("●") : c.dim("○");
            console.log(`  ${status} ${c.white(t.name.padEnd(pad))} ${c.dim(t.schedule)}  → ${t.workflow}`);
          }
        } else {
          console.log(`  ${c.dim("(none — add one with /trigger add <name>)")}`);
        }
        console.log();
        info("add, remove, or run triggers; start scheduler with 'tim start'");
        return;
      }
      if (sub === "add") {
        if (!name) return error("usage: /trigger add <name>");
        const readline = await import("node:readline");
        
        if (triggerExists(name)) return error(`trigger "${name}" already exists`);
        
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q, def) => new Promise((res) => rl.question(`  ${q}${def ? ` (${def})` : ""}: `, (a) => res(a.trim() || def || "")));
        
        const workflows = Object.keys(loadWorkflows());
        if (!workflows.length) { rl.close(); return error("no workflows — run: tim workflow new"); }
        
        console.log(`  Available workflows: ${workflows.join(", ")}`);
        const workflow = await ask("Workflow to run", workflows[0]);
        if (!loadWorkflows()[workflow]) { rl.close(); return error(`unknown workflow: ${workflow}`); }
        
        console.log(`  Cron examples: "0 7 * * *" (daily 7am), "*/5 * * * *" (every 5min), "0 9 * * 1-5" (weekdays 9am)`);
        const schedule = await ask("Schedule (cron expression)", "0 7 * * *");
        const task = await ask("Task override (blank = use workflow default)", "");
        const description = await ask("Description (optional)", "");
        rl.close();
        
        const { writeTrigger } = await import("./triggers.js");
        const filepath = writeTrigger(name, { schedule, workflow, task, description });
        success(`created trigger "${name}"`);
        info(`filepath: ${filepath}`);
        info(`test: /trigger run ${name} | start scheduler: tim start`);
        return;
      }
      if (sub === "remove") {
        if (!name) return error("usage: /trigger remove <name>");
        if (!triggerExists(name)) return error(`trigger "${name}" not found`);
        const { deleteTrigger } = await import("./triggers.js");
        deleteTrigger(name);
        success(`removed scheduled trigger "${name}"`);
        return;
      }
      if (sub === "run") {
        if (!name) return error("usage: /trigger run <name>");
        const { getTriggerState } = await import("./triggers.js");
        info(`running trigger "${name}"...`);
        try {
          await runTrigger(name, { log: (msg) => info(msg.replace(/^→ /, "").replace(/^✓ /, "")) });
        } catch (e) {
          return error(e.message);
        }
        success(`trigger "${name}" done`);
        return;
      }
      return error("usage: /trigger [list|add|remove|run] [name]");
    }
    case "loc": {
      const { execSync } = await import("node:child_process");
      try {
        const dir = (await import("node:fs")).existsSync("src") ? "src" : ".";
        const exts = [
          "js", "ts", "jsx", "tsx", "mjs", "cjs",
          "swift", "m", "h", "mm",
          "java", "kt", "kts", "scala", "groovy",
          "py", "rb", "php", "pl", "lua", "r", "sh", "bash", "zsh",
          "go", "rs", "c", "cpp", "cc", "cxx", "hpp", "cs", "fs", "fsx", "vb",
          "hs", "erl", "ex", "exs", "clj", "cljs",
          "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
          "json", "yaml", "yml", "xml", "sql", "dart", "coffee",
        ];
        const skipDirs = [
          ".git", "node_modules", "dist", "build", ".next", ".venv", "venv",
          "__pycache__", "target", "vendor", "coverage", ".cache", "Pods",
          "DerivedData", ".build", "tmp", "temp", "logs",
        ];
        const prune = skipDirs.map((d) => `-not -path "*/${d}/*"`).join(" ");
        let total = 0;
        for (const ext of exts) {
          try {
            const out = execSync(
              `find ${dir} -type f ${prune} -name "*.${ext}" | xargs cat | grep -v '^[[:space:]]*$' | grep -v '^[[:space:]]*//' | grep -v '^[[:space:]]*/\\*' | grep -v '^[[:space:]]*\\*' | grep -v '^[[:space:]]*#' | wc -l`,
              { encoding: "utf8", shell: "/bin/sh" }
            );
            total += Number(out.trim());
          } catch {}
        }
        success(`${total.toLocaleString()} source lines (no blanks/comments)`);
      } catch {
        info("no source files found");
      }
      return;
    }
    case "exit":
    case "quit":
      exitHint(await getSessionId());
      process.exit(0);
    default:
      error(`unknown command: /${cmd} — try /help`);
  }
}
