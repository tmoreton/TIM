// Snapshots of user customizations inside $TIM_DIR (agents/, tools/, etc.)
// before the model edits them, so broken changes can be reverted. Tim's
// own source code is git-tracked and not snapshotted here.
// Written to $TIM_DIR/history/<ISO-ts>/<relpath-under-TIM_DIR>.

import fs from "node:fs";
import path from "node:path";
import { timDir } from "./paths.js";

// One timestamp per REPL session keeps related edits grouped together.
const SESSION_STAMP = new Date().toISOString().replace(/[:.]/g, "-");

export function snapshotFile(absPath) {
  if (!absPath) return null;
  const root = path.resolve(timDir());
  const histRoot = path.join(root, "history");
  // Only snapshot files inside $TIM_DIR, and skip the history dir itself
  // so we don't recursively snapshot prior snapshots.
  const inTimDir = absPath === root || absPath.startsWith(root + path.sep);
  const inHistory = absPath === histRoot || absPath.startsWith(histRoot + path.sep);
  if (!inTimDir || inHistory) return null;
  if (!fs.existsSync(absPath)) return null; // new file, nothing to snapshot
  const rel = path.relative(root, absPath);
  const dest = path.join(histRoot, SESSION_STAMP, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Don't overwrite an existing snapshot in the same session — we want the
  // earliest pre-edit state, not the most recent intermediate one.
  if (!fs.existsSync(dest)) fs.copyFileSync(absPath, dest);
  return dest;
}

export const historyDir = () => path.join(timDir(), "history");
