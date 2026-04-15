// CLI commands (/help, /model, /clear, /sessions, etc).
// Each command mutates state via agent.js or prints status info.

import { tools } from "./tools/index.js";
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
import { setAutoAccept, isAutoAccept } from "./permissions.js";
import { c, info, success, error, exitHint } from "./ui.js";

const HELP_ROWS = [
  ["/help", "show this help"],
  ["/tools", "list registered tools"],
  ["/model [id]", "show or switch model"],
  ["/clear", "reset conversation (starts a new session)"],
  ["/context", "show whether TIM.md was loaded"],
  ["/tokens", "show token usage"],
  ["/compact", "summarize older messages to free context"],
  ["/sessions", "list saved sessions"],
  ["/yolo", "toggle auto-accept for edits and bash (USE WITH CARE)"],
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
    case "tools":
      console.log();
      for (const name of Object.keys(tools))
        console.log(`  ${c.teal("•")} ${c.white(name)}`);
      console.log();
      return;
    case "model":
      if (!arg) info(`model: ${getModel()}`);
      else {
        setModel(arg);
        success(`model → ${arg}`);
      }
      return;
    case "clear":
      resetMessages();
      success("conversation cleared — new session");
      return;
    case "context":
      info(hasProjectContext() ? "TIM.md loaded" : "no TIM.md found");
      return;
    case "tokens": {
      const u = getUsage();
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
    case "exit":
    case "quit":
      exitHint(getSessionId());
      process.exit(0);
    default:
      error(`unknown command: /${cmd} — try /help`);
  }
}
