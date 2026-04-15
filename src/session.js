// Session persistence to ~/.tim/sessions/ as JSON files.
// createSession(), save(), load(), list() — load() supports prefix matching for truncated IDs.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".tim", "sessions");

const ensureDir = () => fs.mkdirSync(DIR, { recursive: true });

const newId = () =>
  new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");

export function createSession(model) {
  ensureDir();
  return {
    id: newId(),
    cwd: process.cwd(),
    model,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function save(session, messages, usage) {
  ensureDir();
  session.updatedAt = Date.now();
  const data = { ...session, messages, usage };
  fs.writeFileSync(path.join(DIR, `${session.id}.json`), JSON.stringify(data, null, 2));
}

export function load(id) {
  ensureDir();
  if (!id || typeof id !== "string") {
    throw new Error("Session ID required");
  }
  
  // Sanitize ID to prevent directory traversal
  const safeId = id.replace(/[\/\\]/g, "");
  if (!safeId) {
    throw new Error("Invalid session ID");
  }
  
  const exact = path.join(DIR, `${safeId}.json`);
  if (fs.existsSync(exact)) {
    try {
      const data = JSON.parse(fs.readFileSync(exact, "utf8"));
      // Validate required fields
      if (!data.id || !Array.isArray(data.messages)) {
        throw new Error("Corrupted session file");
      }
      return data;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`Corrupted session file: ${safeId}`);
      }
      throw e;
    }
  }

  // Prefix match (e.g. user pasted a truncated ID from the status footer).
  const matches = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json") && f.startsWith(safeId));
  if (matches.length === 1)
    return JSON.parse(fs.readFileSync(path.join(DIR, matches[0]), "utf8"));
  if (matches.length > 1)
    throw new Error(
      `Ambiguous session id "${safeId}" — matches ${matches.length} sessions. Use /sessions to see full IDs.`,
    );
  const recent = fs.readdirSync(DIR)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => fs.statSync(path.join(DIR, b)).mtimeMs - fs.statSync(path.join(DIR, a)).mtimeMs)
    .slice(0, 3)
    .map(f => `  ${f.replace('.json', '')}`)
    .join('\n');
  throw new Error(`Session not found: ${safeId}\nRecent sessions:\n${recent}`);
}

export function list() {
  ensureDir();
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const data = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
      return {
        id: data.id,
        cwd: data.cwd,
        updatedAt: data.updatedAt,
        turns: (data.messages || []).filter((m) => m.role === "user").length,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export const latest = () => list()[0];
