// Install-path helpers. TIM_SOURCE_ROOT is where tim itself lives on disk —
// used to guard against accidental self-edits when the user is running `tim`
// from another project directory. Also houses small shared filesystem helpers
// (timDir, timPath, parseFrontmatter) that were previously duplicated.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// Walk up from this file looking for the workspace root (a package.json with
// a "workspaces" field). Falls back to two levels up from src/ if no marker
// is found — preserves pre-monorepo behavior for unbundled installs.
const findWorkspaceRoot = () => {
  let dir = path.dirname(__filename);
  while (dir !== path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.workspaces) return dir;
    } catch {}
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(__filename), "..");
};

export const TIM_SOURCE_ROOT = findWorkspaceRoot();

export const isInsideTimSource = (absPath) => {
  if (!absPath) return false;
  return absPath === TIM_SOURCE_ROOT || absPath.startsWith(TIM_SOURCE_ROOT + path.sep);
};

export const isCwdTimSource = () => process.cwd() === TIM_SOURCE_ROOT;

export const timDir = () => process.env.TIM_DIR || path.join(os.homedir(), ".tim");
export const timPath = (...parts) => path.join(timDir(), ...parts);

// All agent-generated artifacts live under $TIM_DIR/output/<agent>/. When no
// agent is in scope (bare REPL, `tim chat`), files go under output/general/.
export const agentOutputDir = (agentName) =>
  timPath("output", agentName || "general");

// Parse YAML-ish frontmatter. Supports inline arrays `[a, b, c]` and
// multi-line `key:\n  - item` lists. Lines starting with `#` are treated
// as comments and ignored. Anything fancier (nested objects, quoted strings
// with commas) is out of scope.
export const parseFrontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  let currentArray = null;
  for (const line of m[1].split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (currentArray && /^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, "").trim();
      if (item) currentArray.push(item);
      continue;
    }
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      meta[kv[1]] = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      currentArray = null;
    } else if (v === "") {
      currentArray = [];
      meta[kv[1]] = currentArray;
    } else {
      meta[kv[1]] = v;
      currentArray = null;
    }
  }
  return { meta, body: m[2].trim() };
};

// Levenshtein for "did you mean" hints in validateMeta.
const editDistance = (a, b) => {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
};

const closestField = (input, candidates) => {
  let best = null, bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase());
    if (d < bestScore && d <= 2) { best = c; bestScore = d; }
  }
  return best;
};

// Validate parsed frontmatter against a schema. Returns { errors, fatal }.
// `fatal` is true when a required field is missing — the caller should drop
// the entry entirely so downstream code doesn't see undefined.
//
// Schema shape: { fieldName: { type: "string"|"array", required: bool, doc: string } }
export const validateMeta = (meta, schema) => {
  const errors = [];
  let fatal = false;
  const known = new Set(Object.keys(schema));

  for (const key of Object.keys(meta)) {
    if (!known.has(key)) {
      const suggestion = closestField(key, known);
      errors.push(`unknown field "${key}"${suggestion ? ` — did you mean "${suggestion}"?` : ""}`);
    }
  }

  for (const [field, spec] of Object.entries(schema)) {
    const v = meta[field];
    const empty = v === undefined || v === null || v === "" ||
                  (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (spec.required) {
        errors.push(`missing required field "${field}"`);
        fatal = true;
      }
      continue;
    }
    if (spec.type === "array" && !Array.isArray(v)) {
      errors.push(`field "${field}" should be an array — got: ${JSON.stringify(v)}. Use [a, b, c] syntax.`);
    } else if (spec.type === "string" && typeof v !== "string") {
      errors.push(`field "${field}" should be a string — got: ${JSON.stringify(v)}`);
    }
  }

  return { errors, fatal };
};

// Render a canonical frontmatter block from `meta` against `schema`, leaving
// each field's `doc` comment above it so hand-editors see what the field is
// for. Optional fields with no value are emitted as commented-out templates.
export const renderFrontmatter = (meta, schema, body = "") => {
  const lines = ["---"];
  const fields = Object.entries(schema);
  fields.forEach(([field, spec], idx) => {
    const v = meta[field];
    const empty = v === undefined || v === null || v === "" ||
                  (Array.isArray(v) && v.length === 0);
    if (spec.doc) lines.push(`# ${spec.doc}`);
    if (empty) {
      if (spec.required) {
        lines.push(`${field}:`);
      } else {
        const example = spec.type === "array" ? "[]" : "";
        lines.push(`# ${field}:${example ? ` ${example}` : ""}`);
      }
    } else if (Array.isArray(v)) {
      lines.push(`${field}: [${v.join(", ")}]`);
    } else {
      lines.push(`${field}: ${v}`);
    }
    if (idx < fields.length - 1) lines.push("");
  });
  lines.push("---", "", body.trim());
  return lines.join("\n") + "\n";
};
