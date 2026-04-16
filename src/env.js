// Read/write $TIM_DIR/.env. Values set here are also pushed into process.env
// so they're available to subsequent tool calls in the same session.

import fs from "node:fs";
import path from "node:path";
import { timPath } from "./paths.js";

const ENV_PATH = () => timPath(".env");

const parse = (src) => {
  const lines = src.split("\n");
  const entries = []; // preserves order + comments
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith("#")) {
      entries.push({ raw: line });
    } else {
      const val = m[2].replace(/^["'](.*)["']$/, "$1");
      entries.push({ key: m[1], value: val });
    }
  }
  return entries;
};

const read = () => {
  try { return parse(fs.readFileSync(ENV_PATH(), "utf8")); }
  catch { return []; }
};

const write = (entries) => {
  fs.mkdirSync(path.dirname(ENV_PATH()), { recursive: true });
  const out = entries.map((e) => e.raw !== undefined ? e.raw : `${e.key}=${e.value}`).join("\n");
  fs.writeFileSync(ENV_PATH(), out.endsWith("\n") ? out : out + "\n", { mode: 0o600 });
};

export function setEnv(key, value) {
  const entries = read();
  const i = entries.findIndex((e) => e.key === key);
  if (i >= 0) entries[i] = { key, value };
  else entries.push({ key, value });
  write(entries);
  process.env[key] = value;
}

export function unsetEnv(key) {
  const entries = read().filter((e) => e.key !== key);
  write(entries);
  delete process.env[key];
}

export function listEnv() {
  return read().filter((e) => e.key).map((e) => ({ key: e.key, value: e.value }));
}

export const mask = (v) => {
  if (!v) return "";
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 2) + "*".repeat(Math.min(v.length - 4, 12)) + v.slice(-2);
};
