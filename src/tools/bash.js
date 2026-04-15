import { spawn } from "node:child_process";
import { confirm } from "../permissions.js";

const MAX_OUTPUT = 30_000;

const truncate = (s) =>
  s.length <= MAX_OUTPUT
    ? s
    : s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]`;

export const bash = {
  schema: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a bash command in the current working directory. Use for git, tests, grep, ls, anything. Default timeout 120s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number", description: "Default 120000" },
        },
        required: ["command"],
      },
    },
  },
  run: async ({ command, timeout_ms = 120_000 }, ctx = {}) => {
    const ok = await confirm("bash", { command }, command);
    if (!ok) return "User denied the command.";

    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { cwd: process.cwd() });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout_ms);

      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
        // Hard-kill if it hangs around after 2s.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 2000);
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      const MAX_BUFFER = 100_000;
      child.stdout.on("data", (d) => {
        stdout += d.toString();
        if (stdout.length > MAX_BUFFER) {
          stdout = stdout.slice(0, MAX_BUFFER) + "\n[stdout buffer full]";
          child.stdout.destroy();
        }
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
        if (stderr.length > MAX_BUFFER) {
          stderr = stderr.slice(0, MAX_BUFFER) + "\n[stderr buffer full]";
          child.stderr.destroy();
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const status = aborted
          ? "aborted by user"
          : timedOut
            ? " (timed out)"
            : "";
        const parts = [
          `exit=${code}${status ? ` ${status}` : ""}`,
          stdout && `--- stdout ---\n${truncate(stdout)}`,
          stderr && `--- stderr ---\n${truncate(stderr)}`,
        ].filter(Boolean);
        resolve(parts.join("\n"));
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(`ERROR: ${err.message}`);
      });
    });
  },
};
