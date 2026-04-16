// Install-path helpers. TIM_SOURCE_ROOT is where tim itself lives on disk —
// used to guard against accidental self-edits when the user is running `tim`
// from another project directory. Also houses small shared filesystem helpers
// (timDir, timPath, parseFrontmatter) that were previously duplicated.

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
export const TIM_SOURCE_ROOT = path.resolve(path.dirname(__filename), "..");

export const isInsideTimSource = (absPath) => {
  if (!absPath) return false;
  return absPath === TIM_SOURCE_ROOT || absPath.startsWith(TIM_SOURCE_ROOT + path.sep);
};

export const isCwdTimSource = () => process.cwd() === TIM_SOURCE_ROOT;

export const timDir = () => process.env.TIM_DIR || path.join(os.homedir(), ".tim");
export const timPath = (...parts) => path.join(timDir(), ...parts);

// Parse YAML-ish frontmatter. Supports inline arrays `[a, b, c]` and
// multi-line `key:\n  - item` lists. Anything fancier (nested objects,
// quoted strings with commas) is out of scope.
export const parseFrontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  let currentArray = null;
  for (const line of m[1].split("\n")) {
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
