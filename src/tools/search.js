import { spawn, spawnSync } from "node:child_process";
import fg from "fast-glob";

const hasRg = spawnSync("which", ["rg"]).status === 0;

const MAX_LINES = 500;

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

export const grep = {
  schema: {
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
  },
  run: async ({ pattern, path: p = ".", glob, case_insensitive }) => {
    if (hasRg) {
      const args = ["-n", "--no-heading"];
      if (case_insensitive) args.push("-i");
      if (glob) args.push("-g", glob);
      args.push(pattern, p);
      return runRg(args);
    }
    // Node fallback via fast-glob + regex scan
    const files = await fg(glob ? [glob] : ["**/*"], {
      cwd: p,
      ignore: ["node_modules/**", ".git/**"],
      absolute: false,
    });
    const re = new RegExp(pattern, case_insensitive ? "i" : "");
    const fs = await import("node:fs");
    const results = [];
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(`${p}/${f}`, "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) results.push(`${f}:${i + 1}:${line}`);
        if (results.length >= MAX_LINES) return;
      });
      if (results.length >= MAX_LINES) break;
    }
    return results.length ? results.join("\n") : "(no matches)";
  },
};

export const glob = {
  schema: {
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
  },
  run: async ({ pattern, path: p = "." }) => {
    const files = await fg([pattern], {
      cwd: p,
      ignore: ["node_modules/**", ".git/**"],
    });
    if (!files.length) return "(no matches)";
    return files.slice(0, MAX_LINES).join("\n");
  },
};
