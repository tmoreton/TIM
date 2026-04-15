const sessionAllow = new Set();
let sharedRl = null;

export const setReadline = (rl) => {
  sharedRl = rl;
};

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
      // Fallback: no shared rl (e.g. non-interactive mode) — auto-deny.
      resolve("n");
      return;
    }
    sharedRl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });

export async function confirm(tool, args, preview) {
  const key = keyFor(tool, args);
  if (sessionAllow.has(key)) return true;

  console.log(`\n  ⚠ ${tool} wants to run:`);
  console.log(`    ${preview}`);
  const answer = await ask("  [y]es / [a]lways this session / [n]o > ");

  if (answer === "a" || answer === "always") {
    sessionAllow.add(key);
    return true;
  }
  return answer === "y" || answer === "yes" || answer === "";
}
