// Bash command execution tool.
// Runs commands via `bash -c` with configurable timeout (default 120s).
// Handles stdout/stderr buffering with limits and supports abort signals.
//
// Buffering: we roll the last MAX_BUFFER bytes per stream in memory (the tail
// is what usually matters — errors tend to print last) and spill overflow
// to a temp log file. When we truncate, the model is told where the full log
// is so it can `tail -n 200 /tmp/tim-bash-*.log` to dig in rather than just
// accepting the loss.

import { spawn } from "node:child_process";
import { mkdtempSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


const MAX_OUTPUT = 30_000;

const truncateTail = (s) =>
  s.length <= MAX_OUTPUT
    ? s
    : `...[${s.length - MAX_OUTPUT} earlier bytes omitted]\n` + s.slice(-MAX_OUTPUT);

export const schema = {
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
};

export async function run({ command, timeout_ms = 120_000 }, ctx = {}) {

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: process.cwd() });
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout_ms);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    // Rolling tail buffer per stream; overflow spills to a shared log file
    // (created lazily, one per run) so the model can go read it if it needs
    // earlier output. MAX_BUFFER is generous because the tail is what we
    // keep in-memory; the full log is on disk.
    const MAX_BUFFER = 200_000;
    let logPath = null;
    let logStream = null;

    const makeSink = () => {
      let buf = "";
      let spilledBytes = 0;
      return {
        append(chunk) {
          const s = chunk.toString();
          if (!logStream && buf.length + s.length > MAX_BUFFER) {
            const dir = mkdtempSync(path.join(tmpdir(), "tim-bash-"));
            logPath = path.join(dir, "output.log");
            logStream = createWriteStream(logPath);
          }
          if (logStream) logStream.write(s);
          buf += s;
          if (buf.length > MAX_BUFFER) {
            const drop = buf.length - MAX_BUFFER;
            buf = buf.slice(drop);
            spilledBytes += drop;
          }
        },
        get() { return buf; },
        get spilled() { return spilledBytes; },
      };
    };

    const stdoutSink = makeSink();
    const stderrSink = makeSink();
    child.stdout.on("data", (d) => stdoutSink.append(d));
    child.stderr.on("data", (d) => stderrSink.append(d));

    const finish = (summary) => {
      if (logStream) logStream.end();
      resolve(summary);
    };

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      // Can't know what bash touched — blow away the whole tool cache so
      // subsequent read_file/grep/glob see fresh disk state.
      ctx.toolCache?.clear();
      const status = aborted ? " [aborted]" : timedOut ? " [timeout]" : "";
      const spilled = stdoutSink.spilled + stderrSink.spilled;
      const tail = (label, sink) => {
        const text = sink.get();
        if (!text) return "";
        const head = sink.spilled > 0
          ? `${label} (tail — earlier ${sink.spilled} bytes at ${logPath}):\n`
          : label ? `${label}: ` : "";
        return head + truncateTail(text);
      };
      const parts = [
        code === 0 ? `✓${status}` : `exit ${code}${status}`,
        tail("", stdoutSink),
        tail("stderr", stderrSink),
      ].filter(Boolean);
      if (spilled > 0 && logPath) {
        parts.push(`[Full output: ${logPath}. Use \`tail -n 200 ${logPath}\` or \`grep PATTERN ${logPath}\` to dig in.]`);
      }
      finish(parts.join("\n"));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      finish(`ERROR: ${err.message}`);
    });
  });
}

export const tools = {
  bash: {
    schema, run,
    promptSnippet: "bash: run a shell command in cwd (git, tests, package managers, etc.)",
  },
};
