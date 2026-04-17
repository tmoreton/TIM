// User confirmation prompts for destructive actions (bash, edit_file, write_file).
// Supports auto-accept mode, per-session "always allow", and individual y/n prompts.

import { warn, confirmPrompt, info } from "./ui.js";

const sessionAllow = new Set();
let sharedRl = null;
let sessionAutoAccept = null;
let planMode = false;

export const setReadline = (rl) => {
  sharedRl = rl;
};

const envAutoAccept = () =>
  process.env.TIM_AUTO_ACCEPT === "1" || process.env.TIM_AUTO_ACCEPT === "true";

export const setAutoAccept = (v) => {
  sessionAutoAccept = !!v;
};
export const isAutoAccept = () =>
  sessionAutoAccept !== null ? sessionAutoAccept : envAutoAccept();

export const setPlanMode = (v) => {
  planMode = !!v;
};
export const isPlanMode = () => planMode;

const keyFor = (tool, args) => {
  if (tool === "bash") {
    const cmd = (args.command || "").trim().split(/\s+/)[0] || "";
    return `bash:${cmd}`;
  }
  return tool;
};

const ask = (question) =>
  new Promise((resolve) => {
    if (!sharedRl) {
      resolve("n");
      return;
    }
    sharedRl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });

export async function confirm(tool, args, preview) {
  if (planMode) {
    info(`⊘ ${tool} blocked — plan mode is on (/plan to exit)`);
    return false;
  }
  if (autoAccept) return true;
  const key = keyFor(tool, args);
  if (sessionAllow.has(key)) return true;

  warn(tool, preview);
  const answer = await ask(confirmPrompt());

  if (answer === "a" || answer === "always") {
    sessionAllow.add(key);
    return true;
  }
  return answer === "y" || answer === "yes" || answer === "";
}
