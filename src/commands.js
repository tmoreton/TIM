// CLI commands (/help, /model, /clear, /sessions, etc).
// Each command mutates state via agent.js or prints status info.

import { getTools } from "./tools/index.js";
import {
  resetMessages,
  getModel,
  setModel,
  hasProjectContext,
  getUsage,
  compact,
  getSessionId,
} from "./agent.js";
import { list as listSessions } from "./session.js";
import { loadAgents } from "./agents.js";
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

const HELP_ROWS = [
  ["/help", "show this help"],
  ["/tools", "list tools (core + custom)"],
  ["/tool list", "list custom tools"],
  ["/tool create <name>", "create new custom tool in ~/.tim/tools/"],
  ["/tool edit <name>", "edit custom tool in $EDITOR"],
  ["/tool delete <name>", "delete custom tool"],
  ["/model [id]", "show or switch model"],
  ["/clear", "reset conversation (starts a new session)"],
  ["/context", "show whether TIM.md was loaded"],
  ["/tokens", "show token usage"],
  ["/compact", "summarize older messages to free context"],
  ["/sessions", "list saved sessions"],
  ["/agents", "list available sub-agent profiles"],
  ["/env", "manage $TIM_DIR/.env (list | set KEY=VAL | unset KEY)"],
  ["/yolo", "toggle auto-accept for edits and bash (USE WITH CARE)"],
  ["/plan", "toggle plan mode — model drafts a plan, no edits/bash run"],
  ["/exit", "quit"],
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
      console.log();
      console.log("  " + c.bold(c.teal("core tools")));
      for (const name of Object.keys(tools).filter(n => !customNames.includes(n)))
        console.log(`  ${c.teal("•")} ${c.white(name)}`);
      if (customNames.length) {
        console.log();
        console.log("  " + c.bold(c.teal("custom tools")));
        for (const name of customNames)
          console.log(`  ${c.teal("•")} ${c.white(name)} ${c.dim("(custom)")}`);
      }
      console.log();
      return;
    }
    case "model":
      if (!arg) info(`model: ${await getModel()}`);
      else {
        await setModel(arg);
        success(`model → ${arg}`);
      }
      return;
    case "clear":
      await resetMessages();
      success("conversation cleared — new session");
      return;
    case "context":
      info(hasProjectContext() ? "TIM.md loaded" : "no TIM.md found");
      return;
    case "tokens": {
      const u = await getUsage();
      const pctColor = u.pctUsed >= 80 ? "yellow" : u.pctUsed >= 50 ? "white" : "gray";
      console.log();
      console.log(
        `  ${c.dim("last prompt")}  ${c[pctColor](
          `${u.lastPrompt} / ${u.limit}`,
        )} ${c.dim(`(${u.pctUsed}%)`)}`,
      );
      console.log(`  ${c.dim("total in   ")}  ${c.white(u.prompt)}`);
      console.log(`  ${c.dim("total out  ")}  ${c.white(u.completion)}`);
      console.log();
      return;
    }
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
      return error("usage: /env [list | set KEY=VAL | unset KEY]");
    }
    case "agents": {
      const profiles = Object.values(loadAgents());
      if (!profiles.length) {
        info("no agents found — add markdown files to $TIM_DIR/agents/ or ./.tim/agents/");
        return;
      }
      console.log();
      const pad = Math.max(...profiles.map((p) => p.name.length)) + 2;
      for (const p of profiles) {
        const tools = p.tools ? p.tools.join(",") : "all";
        console.log(`  ${c.teal(p.name.padEnd(pad))} ${c.dim(p.description)} ${c.dim(`[${tools}]`)}`);
      }
      console.log();
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
      const args = arg.split(/\s+/);
      const sub = args[0];
      
      if (!sub || sub === "list") {
        const custom = await listCustomToolNames();
        console.log();
        console.log("  " + c.bold(c.teal("custom tools")));
        if (custom.length) {
          for (const name of custom) console.log(`  ${c.teal("•")} ${c.white(name)}`);
        } else {
          console.log(`  ${c.dim("(none — create one with /tool create <name>)")}`);
        }
        console.log();
        return;
      }
      
      if (sub === "create") {
        const name = args[1];
        if (!name) { error("usage: /tool create <name>"); return; }
        ensureToolsDir();
        const template = generateToolTemplate(name);
        const p = writeToolSource(name, template);
        await reloadCustomTools();
        success(`created ${p}`);
        info("edit the file to implement your tool logic");
        return;
      }
      
      if (sub === "edit") {
        const name = args[1];
        if (!name) { error("usage: /tool edit <name>"); return; }
        const dir = getCustomToolsDir();
        const p = `${dir}/${name}.js`;
        const source = readToolSource(name);
        if (!source) { error(`tool "${name}" not found at ${p}`); return; }
        const editor = process.env.EDITOR || "vi";
        const { spawnSync } = await import("node:child_process");
        spawnSync(editor, [p], { stdio: "inherit" });
        await reloadCustomTools();
        success(`reloaded ${name}`);
        return;
      }
      
      if (sub === "delete") {
        const name = args[1];
        if (!name) { error("usage: /tool delete <name>"); return; }
        const deleted = deleteTool(name);
        if (!deleted) { error(`tool "${name}" not found`); return; }
        success(`deleted ${name}`);
        return;
      }
      
      error("usage: /tool [list|create|edit|delete] <name>");
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
