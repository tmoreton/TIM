// Unified TIM server: scheduler + HTTP/WebSocket API
// Handles cron triggers, agent chat, and remote client connections.

import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { loadTriggers, getTriggerState, recordRun } from "./triggers.js";
import { matches, sameMinute } from "./cron.js";
import { loadWorkflows, mergeProfile } from "./workflows.js";
import { loadAgents } from "./agents.js";
import { createAgent, resumeSession } from "./react.js";
import { getModelCatalog } from "./llm.js";
import { qrToANSI } from "./qrcode.js";
import { getTools } from "./tools/index.js";

import { load as loadSession, save as saveSession, list as listSessions, listByFolder, remove as removeSession } from "./session.js";

const TICK_MS = 30_000;
const DEFAULT_PORT = Number(process.env.TIM_PORT) || 8080;

function findAvailablePort(startPort, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const testServer = createServer();
      testServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      testServer.once('listening', () => {
        testServer.close(() => resolve(port));
      });
      testServer.listen(port, host);
    };
    tryPort(startPort);
  });
}

const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);

// Safely change the daemon's CWD. Validates the target exists and is a
// directory before calling `process.chdir`. Never throws: if the target is
// invalid we return false and the caller keeps serving in whatever CWD the
// daemon is already in, which is far better than 500-ing a live conversation.
const safeChdir = (target) => {
  if (!target || typeof target !== "string") return false;
  try {
    if (!fs.statSync(target).isDirectory()) return false;
    process.chdir(target);
    return true;
  } catch {
    return false;
  }
};

// Mobile clients often send just the session's short folder handle (e.g.
// "heytim-ai"), not an absolute path — they don't know the daemon's
// filesystem. Look back through recent sessions for one tagged with that
// folder whose recorded absolute cwd still exists on disk.
const resolveFolderName = (name) => {
  if (!name || typeof name !== "string" || nodePath.isAbsolute(name)) return null;
  try {
    for (const s of listSessions()) {
      if (s.folder !== name || !s.cwd) continue;
      try {
        if (fs.statSync(s.cwd).isDirectory()) return s.cwd;
      } catch {}
    }
  } catch {}
  return null;
};

const chdirForRequest = (folder, sessionCwd) =>
  safeChdir(folder) || safeChdir(resolveFolderName(folder)) || safeChdir(sessionCwd);

// ============================================================================
// TAILSCALE DETECTION
// ============================================================================

const TAILSCALE_PATHS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

let cachedTailscalePath = null;

function findTailscale() {
  if (cachedTailscalePath) return cachedTailscalePath;
  for (const path of TAILSCALE_PATHS) {
    try {
      if (path === "tailscale") {
        execSync("which tailscale", { timeout: 1000, stdio: "ignore" });
        cachedTailscalePath = path;
        return path;
      }
      execSync(`test -x "${path}"`, { timeout: 1000, stdio: "ignore" });
      cachedTailscalePath = path;
      return path;
    } catch {}
  }
  return null;
}

function getTailscaleIP() {
  const bin = findTailscale();
  if (!bin) return null;
  try {
    const output = execSync(`"${bin}" ip -4 2>/dev/null`, { 
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"]
    });
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const ip = line.trim();
      if (ip.startsWith("100.")) return ip;
    }
    return null;
  } catch {
    return null;
  }
}

function hasTailscaleCLI() {
  return !!findTailscale();
}

function getTailscaleStatus() {
  const bin = findTailscale();
  if (!bin) return null;
  try {
    const output = execSync(`"${bin}" status 2>/dev/null`, { encoding: "utf8", timeout: 5000 });
    return output.trim();
  } catch {
    return null;
  }
}

/** MagicDNS hostname, e.g. "mymac.tail-abcd.ts.net" (no trailing dot). */
function getTailscaleHostname() {
  const bin = findTailscale();
  if (!bin) return null;
  try {
    const output = execSync(`"${bin}" status --json 2>/dev/null`, {
      encoding: "utf8", timeout: 5000,
    });
    const status = JSON.parse(output);
    let dns = status?.Self?.DNSName;
    if (typeof dns !== "string" || !dns) return null;
    if (dns.endsWith(".")) dns = dns.slice(0, -1);
    return dns;
  } catch {
    return null;
  }
}

/**
 * Configures `tailscale serve` so Tailscale terminates HTTPS on :443 and
 * proxies to our local HTTP server. This gives iOS clients a real TLS cert
 * (auto-issued by Tailscale) against the MagicDNS hostname, with no cert
 * management on our side.
 *
 * Requires HTTPS to be enabled in the tailnet admin console.
 */
function enableTailscaleHttps(localPort) {
  const bin = findTailscale();
  if (!bin) return { ok: false, error: "tailscale CLI not found" };
  try {
    // Clear any prior serve config so we don't conflict with an old binding.
    try { execSync(`"${bin}" serve reset`, { timeout: 5000, stdio: "ignore" }); } catch {}
    execSync(
      `"${bin}" serve --bg --https=443 http://127.0.0.1:${localPort}`,
      { encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return { ok: true };
  } catch (e) {
    const msg = e?.stderr?.toString?.() || e.message || String(e);
    return { ok: false, error: msg.trim() };
  }
}

function disableTailscaleHttps() {
  const bin = findTailscale();
  if (!bin) return;
  try { execSync(`"${bin}" serve reset`, { timeout: 5000, stdio: "ignore" }); } catch {}
}

/**
 * Prints a scannable QR code for `url` to stdout using our vendored pure-JS
 * encoder (see src/qrcode.js). Zero runtime deps.
 */
function printQRCode(url) {
  try {
    process.stdout.write(qrToANSI(url));
    return true;
  } catch (e) {
    log(`⚠ could not render QR: ${e.message}`);
    return false;
  }
}

// ============================================================================
// SCHEDULER (CRON TRIGGERS)
// ============================================================================

function looksEmpty(result) {
  if (result == null) return true;
  if (typeof result === "string") return !result.trim() || result.startsWith("ERROR:");
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result === "object") {
    if (Array.isArray(result.items) && result.items.length === 0) return true;
    if (Array.isArray(result.messages) && result.messages.length === 0) return true;
    if (result.count === 0) return true;
  }
  return false;
}

async function hasWork(precheckTool) {
  if (!precheckTool) return { work: true };
  try {
    const tools = await getTools();
    const tool = tools[precheckTool];
    if (!tool) {
      log(`  ⚠ precheck tool "${precheckTool}" not found — firing anyway`);
      return { work: true };
    }
    const result = await tool.run({ dryRun: true }, { signal: null });
    const count = Array.isArray(result?.items)  ? result.items.length
                : Array.isArray(result?.messages) ? result.messages.length
                : typeof result?.count === "number" ? result.count
                : null;
    if (count !== null) return { work: count > 0, count };
    const data = result && typeof result === "object" && "content" in result ? result.content : result;
    return { work: !looksEmpty(data), count: null };
  } catch (e) {
    log(`  ⚠ precheck failed: ${e.message} — firing anyway`);
    return { work: true };
  }
}

async function fireTrigger(trigger) {
  const workflows = loadWorkflows();
  const workflow = workflows[trigger.workflow];
  if (!workflow) {
    log(`\x1b[38;2;20;184;166m✗\x1b[0m ${trigger.name}: workflow "${trigger.workflow}" not found`);
    recordRun(trigger.name, { startedAt: ts(), finishedAt: ts(), status: "error", error: `workflow "${trigger.workflow}" not found` });
    return;
  }
  const agents = loadAgents();
  const agent = agents[workflow.agent];
  if (!agent) {
    log(`\x1b[38;2;20;184;166m✗\x1b[0m ${trigger.name}: agent "${workflow.agent}" not found`);
    recordRun(trigger.name, { startedAt: ts(), finishedAt: ts(), status: "error", error: `agent "${workflow.agent}" not found` });
    return;
  }

  const task = trigger.task || workflow.task || `Run the ${workflow.name} workflow.`;
  const started = ts();
  log(`\x1b[38;2;20;184;166m→\x1b[0m firing ${trigger.name} (${workflow.name} → ${agent.name})`);
  try {
    const sub = await createAgent(mergeProfile(agent, workflow));
    // Trigger-fired runs shouldn't clutter the chat session history — they're
    // background automation. Their history already lives in `.tim/triggers/`
    // via recordRun() below. Turning off persistence keeps the sidebar clean.
    sub.state.persist = false;
    await sub.turn(task);
    const finished = ts();
    log(`\x1b[38;2;20;184;166m✓\x1b[0m ${trigger.name} done (${Math.round((new Date(finished) - new Date(started)) / 1000)}s)`);
    recordRun(trigger.name, { startedAt: started, finishedAt: finished, status: "ok" });
  } catch (e) {
    log(`\x1b[38;2;20;184;166m✗\x1b[0m ${trigger.name} failed: ${e.message}`);
    recordRun(trigger.name, { startedAt: started, finishedAt: ts(), status: "error", error: e.message });
  }
}

async function tick() {
  const now = new Date();
  const triggers = loadTriggers();
  for (const t of triggers) {
    if (!t.enabled) continue;
    if (!matches(t.schedule, now)) continue;

    const prev = getTriggerState(t.name);
    if (prev?.lastRunAt) {
      const prevDate = new Date(prev.lastRunAt);
      if (sameMinute(prevDate, now)) continue;
    }

    const workflows = loadWorkflows();
    const w = workflows[t.workflow];
    const precheck = t.precheck || w?.precheck || null;
    if (precheck) {
      const { work, count } = await hasWork(precheck);
      if (!work) {
        continue;
      }

    }

    await fireTrigger(t);
  }
}

function startScheduler() {
  const triggers = loadTriggers();
  for (const t of triggers) {
    log(`• \x1b[38;2;20;184;166m${t.name}\x1b[0m [${t.schedule}] → ${t.workflow}${t.enabled ? "" : " (disabled)"}`);
  }

  tick().catch((e) => log(`tick error: ${e.message}`));
  return setInterval(() => tick().catch((e) => log(`tick error: ${e.message}`)), TICK_MS);
}

// ============================================================================
// HTTP SERVER + WEBSOCKET
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function createHttpServer() {
  const connections = new Map();

  const httpServer = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost`);
    const path = url.pathname;

    try {
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (path === "/models" && req.method === "GET") {
        const catalog = getModelCatalog();
        const current = process.env.TIM_MODEL || catalog[0]?.id || "";
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ current, catalog }));
        return;
      }

      if (path === "/agents" && req.method === "GET") {
        const agents = Object.values(loadAgents()).map(a => ({ name: a.name, description: a.description, tools: a.tools }));
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ agents }));
        return;
      }

      if (path === "/workflows" && req.method === "GET") {
        const workflows = Object.values(loadWorkflows()).map(w => ({ name: w.name, agent: w.agent, description: w.description }));
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ workflows }));
        return;
      }

      if (path === "/sessions" && req.method === "GET") {
        const groupByFolder = url.searchParams.get("group") === "folder";
        if (groupByFolder) {
          res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ sessionsByFolder: listByFolder() }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ sessions: listSessions() }));
        }
        return;
      }

      if (path.startsWith("/sessions/") && req.method === "GET") {
        const id = path.split("/")[2];
        const session = loadSession(id);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ error: "session not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify(session));
        return;
      }

      if (path.startsWith("/sessions/") && req.method === "DELETE") {
        const id = path.split("/")[2] || "";
        const deleted = removeSession(id);
        res.writeHead(deleted ? 200 : 404, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ ok: deleted }));
        return;
      }

      if (path === "/chat" && req.method === "POST") {
        const body = await readBody(req);
        const { agent: agentName, message, sessionId, folder, model, attachments } = body;

        if (!agentName || !message) {
          res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ error: "agent and message required" }));
          return;
        }

        const agents = loadAgents();
        const agent = agents[agentName];
        if (!agent) {
          res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ error: `agent "${agentName}" not found` }));
          return;
        }

        let sub;
        if (sessionId) {
          const data = loadSession(sessionId);
          if (data) {
            chdirForRequest(folder, data.cwd);
            sub = await createAgent(agent);
            sub.resume(data);
          }
        }
        if (!sub) {
          chdirForRequest(folder);
          sub = await createAgent(agent);
        }

        if (model) sub.state.model = model;
        if (sub.state.session) sub.state.session.agent = agentName;

        let attachmentPaths = null;
        if (Array.isArray(attachments) && attachments.length > 0) {
          const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tim-upload-"));
          const images = [];
          const pdfs = [];
          for (const a of attachments) {
            if (!a?.name || !a?.data) continue;
            const safeName = String(a.name).replace(/[^a-zA-Z0-9._-]/g, "_") || "file.bin";
            const filepath = nodePath.join(tmpDir, safeName);
            fs.writeFileSync(filepath, Buffer.from(a.data, "base64"));
            if (a.mime === "application/pdf" || safeName.toLowerCase().endsWith(".pdf")) {
              pdfs.push(filepath);
            } else {
              images.push(filepath);
            }
          }
          if (images.length || pdfs.length) attachmentPaths = { images, pdfs };
        }

        await sub.turn(message, null, attachmentPaths);
        const last = sub.state.messages.filter(m => m.role === "assistant" && !m.tool_calls?.length && m.content).pop();
        const sessionData = sub.state.session;
        if (sessionData && sub.state.persist) saveSession(sessionData, sub.state.messages, sub.state.usage);

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ response: last?.content || "", sessionId: sessionData?.id, messages: sub.state.messages }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      log("HTTP error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // WebSocket upgrade
  httpServer.on("upgrade", async (req, socket) => {
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const agentName = url.searchParams.get("agent");
    const sessionId = url.searchParams.get("session");
    const folder = url.searchParams.get("folder");

    if (!agentName) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const agents = loadAgents();
    const agent = agents[agentName];
    if (!agent) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Compute Sec-WebSocket-Accept per RFC 6455 so real clients
    // (URLSessionWebSocketTask, browsers) accept the handshake.
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const acceptKey = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    const send = (data) => {
      const payload = Buffer.from(JSON.stringify(data));
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
        header.writeUInt32BE(len >>> 0, 6);
      }
      socket.write(Buffer.concat([header, payload]));
    };

    let sub;
    try {
      if (sessionId) {
        const data = loadSession(sessionId);
        if (data) {
          chdirForRequest(folder, data.cwd);
          sub = await createAgent(agent);
          sub.resume(data);
        }
      }
      if (!sub) {
        chdirForRequest(folder);
        sub = await createAgent(agent);
      }
      if (sub.state.session) sub.state.session.agent = agentName;
      connections.set(socket, { agent: sub, sessionId: sub.state.session?.id });
      send({ type: "connected", sessionId: sub.state.session?.id, agent: agentName, folder: folder || process.cwd() });
    } catch (e) {
      send({ type: "error", error: e.message });
      socket.end();
      return;
    }

    socket.on("data", async (data) => {
      try {
        const opcode = data[0] & 0x0f;
        if (opcode === 0x08) { socket.end(); return; }
        if (opcode !== 0x01 && opcode !== 0x02) return;

        const masked = data[1] & 0x80;
        let payloadLen = data[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) { payloadLen = data.readUInt16BE(2); offset = 4; }
        else if (payloadLen === 127) { payloadLen = data.readUInt32BE(2) * 0x100000000 + data.readUInt32BE(6); offset = 10; }

        let payload = data.slice(offset, offset + payloadLen);
        if (masked) {
          const mask = data.slice(offset, offset + 4);
          offset += 4;
          payload = data.slice(offset, offset + payloadLen);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }

        const msg = JSON.parse(payload.toString());

        if (msg.type === "message" && msg.content) {
          const onToken = (token) => send({ type: "token", content: token });
          try {
            await sub.turn(msg.content, undefined, null, onToken);
            if (sub.state.session && sub.state.persist) saveSession(sub.state.session, sub.state.messages, sub.state.usage);
            send({ type: "done" });
          } catch (e) {
            send({ type: "error", error: e.message });
          }
        }
      } catch (e) {
        send({ type: "error", error: e.message });
      }
    });

    socket.on("close", () => connections.delete(socket));
    socket.on("error", (err) => { log("WebSocket error:", err.message); connections.delete(socket); });
  });

  return {
    httpServer,
    listen: (host, port) => new Promise((resolve, reject) => {
      httpServer.listen(port, host, () => {
        log(`server listening on \x1b[38;2;20;184;166mhttp://${host}:${port}\x1b[0m`);
        resolve();
      });
      httpServer.on("error", reject);
    }),
    close: () => new Promise((resolve) => {
      for (const [socket] of connections) socket.end();
      httpServer.close(resolve);
    }),
  };
}

// ============================================================================
// MAIN ENTRY: tim start [--tailscale] [--watch]
// ============================================================================

const MAX_RESTART_ATTEMPTS = 10;
const RESTART_DELAY_MS = 5000;

async function runServer({ tailscale = false } = {}) {


  // Always bind to 0.0.0.0 so the Tailscale peer can reach us at the 100.x
  // IP and localhost clients still work. Tailscale "serve" (if enabled)
  // terminates HTTPS on :443 and proxies to 127.0.0.1:<port>.
  const bindHost = "0.0.0.0";
  let tsIp = null;
  let tsHost = null;
  let httpsEnabled = false;

  if (tailscale) {
    if (!hasTailscaleCLI()) {
      log("⚠ tailscale CLI not found");
      log("  Install: https://tailscale.com/download");
    } else {
      tsIp = getTailscaleIP();
      tsHost = getTailscaleHostname();
      if (!tsIp) {
        const status = getTailscaleStatus();
        if (status) log("⚠ tailscale running but no 100.x IP found");
        else log("⚠ tailscale not logged in — run: tailscale up");
      }
    }
  }

  const server = await createHttpServer();
  const port = await findAvailablePort(DEFAULT_PORT, bindHost);
  if (port !== DEFAULT_PORT) {
    log(`⚠ port ${DEFAULT_PORT} in use — using ${port} instead`);
  }
  await server.listen(bindHost, port);

  if (tailscale && tsHost) {
    const result = enableTailscaleHttps(port);
    if (result.ok) {
      httpsEnabled = true;
    } else {
      log(`⚠ could not enable Tailscale HTTPS: ${result.error}`);
      log("  Enable HTTPS certs: https://tailscale.com/kb/1153/enabling-https");
    }
  }

  // Friendly URL banner for the iOS app + any other remote clients.
  // Ports are spelled out so it's obvious localhost/LAN uses HTTP :${port}
  // while the Tailscale HTTPS endpoint is always on :443 (terminated by
  // `tailscale serve`, proxied back to 127.0.0.1:${port}).
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  log("──────────────────────────────────────────────");
  log(`  local    ${pad(`\x1b[38;2;20;184;166mhttp://localhost:${port}\x1b[0m`, 40)}  (HTTP :${port})`);
  if (tsIp) log(`  tailnet  ${pad(`\x1b[38;2;20;184;166mhttp://${tsIp}:${port}\x1b[0m`, 40)}  (HTTP :${port})`);
  if (tsHost) {
    if (httpsEnabled) {
      log(`  tailnet  ${pad(`\x1b[38;2;20;184;166mhttps://${tsHost}\x1b[0m`, 40)}  (HTTPS :443 ← use this in the iOS app)`);
    } else {
      log(`  tailnet  ${pad(`\x1b[38;2;20;184;166mhttp://${tsHost}:${port}\x1b[0m`, 40)}  (HTTP :${port})`);
    }
  }
  log("──────────────────────────────────────────────");

  // Print a QR code of the best URL for the iOS app to scan.
  const iosUrl = (tsHost && httpsEnabled) ? `https://${tsHost}`
               : tsHost                   ? `http://${tsHost}:${port}`
               : tsIp                      ? `http://${tsIp}:${port}`
               : `http://localhost:${port}`;
  log(`  scan in iOS app → \x1b[38;2;20;184;166m${iosUrl}\x1b[0m`);
  printQRCode(iosUrl);

  const schedulerHandle = startScheduler();

  const shutdown = (sig) => {
    log(`received ${sig} — shutting down`);
    clearInterval(schedulerHandle);
    if (httpsEnabled) disableTailscaleHttps();
    server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise(() => {});
}

export async function start({ tailscale = false } = {}) {
  // Auto-restart on crashes (up to 10 attempts)
  let attempts = 0;
  
  while (attempts < MAX_RESTART_ATTEMPTS) {
    attempts++;
    if (attempts > 1) {
      log(`\x1b[38;2;245;158;11m⚠ restart attempt ${attempts}/${MAX_RESTART_ATTEMPTS}\x1b[0m`);
    }
    
    try {
      await runServer({ tailscale });
      // If runServer returns cleanly, exit the loop
      break;
    } catch (e) {
      log(`\x1b[38;2;239;68;68m✗ server crashed: ${e.message}\x1b[0m`);
      
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        log(`\x1b[38;2;239;68;68m✗ max restart attempts reached, giving up\x1b[0m`);
        process.exit(1);
      }
      
      log(`\x1b[38;2;245;158;11m↻ waiting ${RESTART_DELAY_MS}ms before restart...\x1b[0m`);
      await new Promise(r => setTimeout(r, RESTART_DELAY_MS));
    }
  }
}
