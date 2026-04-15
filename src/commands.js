import { tools } from "./tools/index.js";
import {
  resetMessages,
  getModel,
  setModel,
  hasProjectContext,
  getUsage,
  compact,
} from "./agent.js";
import { list as listSessions } from "./session.js";

const HELP = `Slash commands:
  /help            show this help
  /tools           list registered tools
  /model [id]      show or switch model
  /clear           reset conversation (starts a new session)
  /context         show whether TIM.md was loaded
  /tokens          show token usage
  /compact         summarize older messages to free context
  /sessions        list saved sessions
  /exit            quit
Input:
  end a line with \\ to continue
  """ on its own line toggles a multi-line block
Flags (at launch):
  tim                    start fresh
  tim --resume           resume latest session
  tim --resume <id>      resume specific session
  tim --list             list sessions and exit`;

export const isCommand = (input) => input.startsWith("/");

export async function runCommand(input) {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
      console.log(HELP);
      return;
    case "tools":
      console.log(Object.keys(tools).join(", "));
      return;
    case "model":
      if (!arg) console.log(`model: ${getModel()}`);
      else {
        setModel(arg);
        console.log(`model → ${arg}`);
      }
      return;
    case "clear":
      resetMessages();
      console.log("(conversation cleared — new session)");
      return;
    case "context":
      console.log(hasProjectContext() ? "TIM.md loaded" : "no TIM.md found");
      return;
    case "tokens": {
      const u = getUsage();
      console.log(
        `last prompt: ${u.lastPrompt} / ${u.limit} (${u.pctUsed}%) | total prompt: ${u.prompt} | total completion: ${u.completion}`,
      );
      return;
    }
    case "compact": {
      console.log("compacting...");
      const msg = await compact();
      console.log(msg);
      return;
    }
    case "sessions": {
      const all = listSessions();
      if (!all.length) return console.log("(no sessions)");
      for (const s of all.slice(0, 20)) {
        const when = new Date(s.updatedAt).toISOString().replace("T", " ").slice(0, 19);
        console.log(`  ${s.id}  [${s.turns} turns]  ${when}  ${s.cwd}`);
      }
      return;
    }
    case "exit":
    case "quit":
      process.exit(0);
    default:
      console.log(`unknown command: /${cmd} — try /help`);
  }
}
