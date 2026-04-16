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
      "Search file contents with a regex. Returns matching lines with file:line prefixes.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Defaults to '.'" },
        glob: { type: "string", description: "e.g. '*.ts'" },
        case_insensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
};

export async function grepRun({ pattern, path: p = ".", glob, case_insensitive }) {
  if (hasRg) {
    const args = ["-n", "--no-heading"];
    if (case_insensitive) args.push("-i");
    if (glob) args.push("-g", glob);
    args.push(pattern, p);
    return runRg(args);
  }
  // Node fallback via fs.glob + regex scan
  let re;
  try {
    re = new RegExp(pattern, case_insensitive ? "i" : "");
  } catch (e) {
    return `ERROR: invalid regex: ${e.message}`;
  }
  const absPath = path.resolve(p);
  const files = await listFiles(glob || "**/*", absPath);
  const results = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(absPath, f), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) results.push(`${f}:${i + 1}:${lines[i]}`);
      if (results.length >= MAX_LINES) break;
    }
    if (results.length >= MAX_LINES) break;
  }
  return results.length ? results.join("\n") : "(no matches)";
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
  if (!files.length) return "(no matches)";
  return files.slice(0, MAX_LINES).join("\n");
}
