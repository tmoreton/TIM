// Search tools: grep (content search) and glob (file finding).
// grep prefers `ripgrep` (rg) for speed, falls back to Node.js regex scan.
// Both tools ignore common dependency directories and .git.
// Results capped at 500 lines.

import { spawn, spawnSync } from "node:child_process";
import { glob as nodeGlob } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

const hasRg = spawnSync("which", ["rg"]).status === 0;

const MAX_LINES = 500;

const IGNORE = [
  "**/node_modules/**",
  "**/__pycache__/**",
  "**/*.pyc",
  "**/.venv/**",
  "**/venv/**",
  "**/.pytest_cache/**",
  "**/target/**",
  "**/vendor/**",
  "**/.idea/**",
  "**/*.class",
  "**/.git/**",
  "**/.DS_Store",
  "**/*.log",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.vercel/**",
  "**/coverage/**",
  "**/.cache/**",
];

const listFiles = async (pattern, cwd) => {
  const out = [];
  const dir = path.resolve(cwd);
  for await (const f of nodeGlob(pattern, { cwd: dir, exclude: IGNORE })) {
    out.push(f);
    if (out.length >= 10_000) break;
  }
  return out;
};

const runRg = (args) =>
  new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: process.cwd() });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        const lines = out.split("\n");
        const truncated =
          lines.length > MAX_LINES
            ? lines.slice(0, MAX_LINES).join("\n") +
              `\n...[truncated ${lines.length - MAX_LINES} more lines]`
            : out;
        resolve(truncated.trim() || "(no matches)");
      } else {
        resolve(`ERROR: ${err.trim() || `rg exited ${code}`}`);
      }
    });
  });

// grep
export const grepSchema = {
  type: "function",
  function: {
    name: "grep",
    description:
      "Search file contents with a regex. output_mode controls shape: 'content' (default, file:line:text), 'files_with_matches' (just paths), 'count' (path:N). Supports -A/-B/-C context (content mode), multiline, type filter, head_limit.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Defaults to '.'" },
        glob: { type: "string", description: "e.g. '*.ts'" },
        type: { type: "string", description: "ripgrep file type (js, py, rust, ...)" },
        case_insensitive: { type: "boolean" },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Default 'content'.",
        },
        "-A": { type: "number", description: "Lines after each match (content mode)" },
        "-B": { type: "number", description: "Lines before each match (content mode)" },
        "-C": { type: "number", description: "Lines before and after each match (content mode)" },
        multiline: { type: "boolean", description: "Pattern can span lines; '.' matches newline" },
        head_limit: { type: "number", description: "Cap output to first N lines/entries" },
      },
      required: ["pattern"],
    },
  },
};

const applyHead = (out, limit) => {
  if (!limit || limit <= 0) return out;
  const lines = out.split("\n");
  if (lines.length <= limit) return out;
  return lines.slice(0, limit).join("\n") + `\n...[truncated, head_limit=${limit}]`;
};

export async function grepRun(params) {
  const {
    pattern,
    path: p = ".",
    glob,
    type,
    case_insensitive,
    output_mode = "content",
    multiline,
    head_limit,
  } = params;
  const A = params["-A"], B = params["-B"], C = params["-C"];

  if (hasRg) {
    const args = [];
    if (output_mode === "files_with_matches") args.push("-l");
    else if (output_mode === "count") args.push("-c");
    else args.push("-n", "--no-heading");

    if (case_insensitive) args.push("-i");
    if (glob) args.push("-g", glob);
    if (type) args.push("-t", type);
    if (multiline) args.push("-U", "--multiline-dotall");
    if (output_mode === "content") {
      if (C != null) args.push("-C", String(C));
      if (A != null) args.push("-A", String(A));
      if (B != null) args.push("-B", String(B));
    }
    args.push(pattern, p);
    const out = await runRg(args);
    return { content: applyHead(out, head_limit), cacheDeps: [path.resolve(p)] };
  }

  // Node fallback
  let re;
  try {
    const flags = (case_insensitive ? "i" : "") + (multiline ? "s" : "");
    re = new RegExp(pattern, flags);
  } catch (e) {
    return `ERROR: invalid regex: ${e.message}`;
  }
  const absPath = path.resolve(p);
  const files = await listFiles(glob || "**/*", absPath);
  const contentResults = [];
  const fileMatches = new Map();

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(absPath, f), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // skip binary
    const lines = text.split("\n");
    let fileHits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        fileHits++;
        if (output_mode === "content") contentResults.push(`${f}:${i + 1}:${lines[i]}`);
        if (contentResults.length >= MAX_LINES) break;
      }
    }
    if (fileHits) fileMatches.set(f, fileHits);
    if (contentResults.length >= MAX_LINES) break;
  }

  let out;
  if (output_mode === "files_with_matches") {
    out = [...fileMatches.keys()].join("\n") || "(no matches)";
  } else if (output_mode === "count") {
    out = [...fileMatches.entries()].map(([f, n]) => `${f}:${n}`).join("\n") || "(no matches)";
  } else {
    out = contentResults.length ? contentResults.join("\n") : "(no matches)";
  }
  return { content: applyHead(out, head_limit), cacheDeps: [absPath] };
}

// glob
export const globSchema = {
  type: "function",
  function: {
    name: "glob",
    description: "Find files by glob pattern (e.g. 'src/**/*.ts').",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Defaults to '.'" },
      },
      required: ["pattern"],
    },
  },
};

export async function globRun({ pattern, path: p = "." }) {
  const files = await listFiles(pattern, p);
  const abs = path.resolve(p);
  if (!files.length) return { content: "(no matches)", cacheDeps: [abs] };
  return { content: files.slice(0, MAX_LINES).join("\n"), cacheDeps: [abs] };
}
