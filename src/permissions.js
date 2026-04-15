import { warn, confirmPrompt } from "./ui.js";

const sessionAllow = new Set();
let sharedRl = null;
let autoAccept = false;

export const setReadline = (rl) => {
  sharedRl = rl;
};

export const setAutoAccept = (v) => {
  autoAccept = !!v;
};
export const isAutoAccept = () => autoAccept;

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
