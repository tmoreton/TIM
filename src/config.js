// Loads TIM.md context files: global from ~/.tim/TIM.md + local from ./TIM.md.
// Used to build the system prompt in agent.js.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tryRead = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};

export function loadProjectContext() {
  const parts = [];
  const global = tryRead(path.join(os.homedir(), ".tim", "TIM.md"));
  if (global) parts.push(`# Global TIM.md\n${global}`);
  const local = tryRead(path.join(process.cwd(), "TIM.md"));
  if (local) parts.push(`# Project TIM.md\n${local}`);
  return parts.join("\n\n");
}
