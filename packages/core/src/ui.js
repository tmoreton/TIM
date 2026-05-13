// Terminal UI utilities: colors, banner, markdown rendering, spinners, diff display.
// All output functions handle non-TTY gracefully (no escape codes).

const SUPPORTS = process.stdout.isTTY && process.env.TERM !== "dumb";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const codes = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

const wrap = (code, s) => (SUPPORTS ? `${ESC}${code}m${s}${RESET}` : s);

export const c = {};
for (const [name, n] of Object.entries(codes)) c[name] = (s) => wrap(n, s);
c.rgb = (r, g, b, s) =>
  SUPPORTS ? `${ESC}38;2;${r};${g};${b}m${s}${RESET}` : s;

// Teal accent (truecolor). Falls back to cyan on non-truecolor terminals.
c.teal = (s) => c.rgb(20, 184, 166, s);

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
export const gradient = (text, [r1, g1, b1], [r2, g2, b2]) => {
  if (!SUPPORTS) return text;
  const chars = [...text];
  return chars
    .map((ch, i) => {
      if (ch === " ") return ch;
      const t = chars.length === 1 ? 0 : i / (chars.length - 1);
      return c.rgb(lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t), ch);
    })
    .join("");
};


const BANNER = [
  " ████████╗ ██╗ ███╗   ███╗",
  " ╚══██╔══╝ ██║ ████╗ ████║",
  "    ██║    ██║ ██║╚██╔╝██║",
  "    ██║    ██║ ██║ ╚═╝ ██║",
  "    ╚═╝    ╚═╝ ╚═╝     ╚═╝",
];

const START = [13, 148, 136]; // deep teal (teal-600)
const END = [94, 234, 212]; // bright aqua (teal-300)

export function banner(model, cwd) {
  console.log();
  for (const line of BANNER) console.log("  " + gradient(line, START, END));
  console.log();
  console.log(
    "  " +
      gradient("the minimalist coding companion", START, END),
  );
  console.log();
  console.log("  " + c.dim(`model   `) + c.white(model));
  console.log("  " + c.dim(`cwd     `) + c.white(cwd));
  console.log(
    "  " +
      c.dim(`hint    /help for commands · Ctrl+C to interrupt`),
  );
  console.log();
}

export function agentBanner(agentName, model, cwd) {
  console.log();
  for (const line of BANNER) console.log("  " + gradient(line, START, END));
  console.log();
  console.log(
    "  " + gradient(`agent: ${agentName}`, START, END),
  );
  console.log();
  console.log("  " + c.dim(`model   `) + c.white(model));
  console.log("  " + c.dim(`cwd     `) + c.white(cwd));
  console.log(
    "  " +
      c.dim(`hint    /help for commands · Ctrl+C to interrupt · /clear to switch to base tim`),
  );
  console.log();
}


let mdCodeBlock = false;

export const resetMarkdown = () => {
  mdCodeBlock = false;
};

const inlineReplace = (line) => {
  // fenced: skip inline rules inside code blocks (but handle language marker)
  if (mdCodeBlock) {
    // Still dim the fence line itself if it has a language specifier
    if (/^\s*```\w*/.test(line)) return c.dim(line);
    return c.teal(line);
  }
  // inline code `x` - but not inside code blocks (handled above)
  line = line.replace(/`([^`]+)`/g, (_, t) => c.teal(t));
  // bold **x**
  line = line.replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t));
  // bold __x__
  line = line.replace(/__([^_]+)__/g, (_, t) => c.bold(t));
  // links [text](url) → text (dim url)
  line = line.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, t, u) => `${c.bold(t)} ${c.dim(`(${u})`)}`,
  );
  return line;
};

export function renderMarkdownLine(line) {
  // Toggle fenced code block
  const fence = line.match(/^(\s*)```/);
  if (fence) {
    mdCodeBlock = !mdCodeBlock;
    return c.dim(line);
  }

  if (mdCodeBlock) return c.teal(line);

  // Headings
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const text = inlineReplace(h[2]);
    if (h[1].length <= 2) return c.bold(gradient(h[2], START, END));
    return c.bold(c.white(text));
  }

  // Blockquote
  if (/^\s*>\s/.test(line)) {
    return c.dim(c.italic(line));
  }

  // List markers
  const list = line.match(/^(\s*)([-*+]|\d+\.)\s(.*)$/);
  if (list) {
    return `${list[1]}${c.teal("•")} ${inlineReplace(list[3])}`;
  }

  return inlineReplace(line);
}


export const prompt = () => c.bold(c.teal("❯ "));
export const agentPrompt = (agentName) => c.bold(c.teal(`[${agentName}] ❯ `));
export const header = () => c.bold(gradient("tim", START, END));


const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(label = "thinking") {
  if (!SUPPORTS) return { stop() {} };
  let i = 0;
  const render = () => {
    process.stdout.write(
      `\r${c.teal(FRAMES[i++ % FRAMES.length])} ${c.dim(label)}${ESC}K`,
    );
  };
  process.stdout.write(`${ESC}?25l`);
  render();
  const id = setInterval(render, 80);
  return {
    stop() {
      clearInterval(id);
      process.stdout.write(`\r${ESC}K${ESC}?25h`);
    },
  };
}


const ARROW = c.teal("⏵");
const RETURN = c.gray("  ↳");

const summarizeArgs = (name, args) => {
  if (!args || typeof args !== "object") return "";
  if (name === "bash") {
    const cmd = args.command || "";
    return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
  }
  if (args.path && args.old_string !== undefined)
    return `${args.path} ${c.dim("(edit)")}`;
  if (args.path && args.content !== undefined)
    return `${args.path} ${c.dim(`(${args.content.length}b)`)}`;
  if (args.pattern) return `"${args.pattern}"${args.path ? ` in ${args.path}` : ""}`;
  if (args.path) return args.path;
  const j = JSON.stringify(args);
  return j.length > 80 ? j.slice(0, 77) + "..." : j;
};

export function toolCall(name, args) {
  console.log(`${ARROW} ${c.bold(name)} ${c.dim(summarizeArgs(name, args))}`);
}

export function toolResult(result) {
  const s = String(result);
  if (s.startsWith("ERROR:")) {
    console.log(`${RETURN} ${c.red(s.split("\n")[0])}`);
    return;
  }
  const lines = s.split("\n");
  const first = (lines[0] || "").slice(0, 100);
  const suffix =
    lines.length > 1 ? c.dim(` (+${lines.length - 1} lines)`) : "";
  console.log(`${RETURN} ${c.dim(first)}${suffix}`);
}

const MAX_DIFF_LINES = 20;
const DIFF_CONTEXT = 2;

const printDiffBlock = (lines, sign, color) => {
  const shown = lines.slice(0, MAX_DIFF_LINES);
  for (const l of shown) console.log(`     ${c[color](sign)} ${c[color](l)}`);
  if (lines.length > MAX_DIFF_LINES)
    console.log(c.dim(`     ... (+${lines.length - MAX_DIFF_LINES} more)`));
};

const printContext = (lines) => {
  for (const l of lines) console.log(c.dim(`       ${l}`));
};

export function editDiff(oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // Trim common prefix and suffix so we only show the actual change.
  let prefix = 0;
  const maxPrefix = Math.min(oldLines.length, newLines.length);
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldLines.length - prefix, newLines.length - prefix);
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  )
    suffix++;

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);

  if (oldChanged.length === 0 && newChanged.length === 0) {
    console.log(c.dim("     (no effective change)"));
    return;
  }

  const ctxBefore = oldLines.slice(Math.max(0, prefix - DIFF_CONTEXT), prefix);
  const ctxAfter = oldLines.slice(
    oldLines.length - suffix,
    oldLines.length - suffix + DIFF_CONTEXT,
  );

  printContext(ctxBefore);
  printDiffBlock(oldChanged, "-", "red");
  printDiffBlock(newChanged, "+", "green");
  printContext(ctxAfter);
}

export function writeDiff(content) {
  const lines = content.split("\n");
  printDiffBlock(lines, "+", "green");
}


export function statusFooter({ lastPromptTokens, limit, sessionId, model, lastCost, totalCost }) {
  const parts = [];
  if (lastPromptTokens) {
    const pct = Math.round((lastPromptTokens / limit) * 100);
    const color = pct >= 80 ? "yellow" : pct >= 50 ? "white" : "gray";
    parts.push(c[color](`${(lastPromptTokens / 1000).toFixed(1)}k/${(limit / 1000).toFixed(0)}k (${pct}%)`));
  }
  if (totalCost > 0) {
    parts.push(c.dim(`$${lastCost.toFixed(4)} ($${totalCost.toFixed(4)} total)`));
  }
  if (sessionId) parts.push(c.dim(`tim --resume ${sessionId}`));
  if (model) parts.push(c.dim(model));
  if (!parts.length) return;
  console.log(c.dim("  ─ ") + parts.join(c.dim(" · ")));
}

export const info = (msg) => console.log(c.dim(`  ${msg}`));
export const error = (msg) => console.log(c.red(`  ✗ ${msg}`));
export const success = (msg) => console.log(c.teal(`  ✓ ${msg}`));

export function exitHint(sessionId) {
  if (!sessionId) return;
  console.log();
  console.log(c.dim("  resume with:"));
  console.log(`    ${c.teal(`tim --resume ${sessionId}`)}`);
  console.log();
}
