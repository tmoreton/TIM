// Email tool - unified email sending and receiving for agents
// Supports: AgentMail (bidirectional) and SMTP (zero-dep fallback)

import { sendMail as sendSmtpMail, smtpConfig as getSmtpConfig } from "../smtp.js";

// ============== SCHEMAS ==============

export const notifyEmailSchema = {
  type: "function",
  function: {
    name: "notify_email",
    description: "Send email via AgentMail or SMTP. Renders markdown body to HTML. Supports file attachments (images show inline via ![alt](cid:filename.png)) and in-thread replies via reply_to.",
    parameters: {
      type: "object",
      properties: {
        to: {
          oneOf: [
            { type: "string", description: "Recipient email address" },
            { type: "array", items: { type: "string" }, description: "Multiple recipient email addresses" }
          ]
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC recipients"
        },
        subject: { type: "string" },
        body: { type: "string", description: "Email body in markdown. Reference attached images inline with ![alt](cid:filename.png)." },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths to attach. Images referenced as cid:<filename> in the body will display inline."
        },
        reply_to: {
          type: "string",
          description: "Message ID of an email being replied to. When set, the email is sent in the same thread instead of starting a new one. Use the `id` field from receive_email output."
        },
      },
      required: ["to", "subject", "body"],
    },
  },
};

export const receiveEmailSchema = {
  type: "function",
  function: {
    name: "receive_email",
    description: "Poll AgentMail inbox for new emails. Only returns emails from whitelisted senders (configured via AGENTMAIL_WHITELIST). Returns empty array if no new emails.",
    parameters: {
      type: "object",
      properties: {
        inboxId: {
          type: "string",
          description: "AgentMail inbox ID to poll. If not provided, uses AGENTMAIL_INBOX_ID env var."
        },
        limit: {
          type: "number",
          description: "Max emails to return (default: 10)",
          default: 10
        },
        markAsRead: {
          type: "boolean",
          description: "Whether to mark fetched emails as read (default: true)",
          default: true
        }
      }
    }
  }
};

export const createInboxSchema = {
  type: "function",
  function: {
    name: "create_email_inbox",
    description: "Create a new AgentMail inbox for receiving emails. Returns the inbox ID and email address.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Username for the inbox (e.g., 'my-agent' creates my-agent@agentmail.to)"
        },
        domain: {
          type: "string",
          description: "Domain for the inbox (default: agentmail.to)",
          default: "agentmail.to"
        }
      },
      required: ["username"]
    }
  }
};

// ============== MARKDOWN TO HTML ==============

function markdownToHtml(md) {
  return md
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    .replace(/\*\*(.*)\*\*/gim, "<b>$1</b>")
    .replace(/\*(.*)\*/gim, "<i>$1</i>")
    // Images before links (more specific pattern first)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/gim, '<img src="$2" alt="$1" style="max-width:100%;display:block;margin:8px 0">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, '<a href="$2">$1</a>')
    .replace(/```\n?([\s\S]*?)```/gm, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/gim, "<code>$1</code>")
    .replace(/\n/gim, "<br>");
}

function markdownToText(md) {
  return md
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gim, "$1 ($2)")
    .replace(/```[\s\S]*?```/gm, "[code block]")
    .replace(/`([^`]+)`/gim, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/[*_]/g, "");
}

// ============== ATTACHMENT HELPERS ==============

import fs from "node:fs";
import path from "node:path";

const MIME_BY_EXT = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
};

function readAttachments(filePaths = []) {
  return filePaths.map(fp => {
    const abs = path.resolve(fp);
    if (!fs.existsSync(abs)) throw new Error(`attachment not found: ${fp}`);
    const filename = path.basename(abs);
    const contentType = MIME_BY_EXT[path.extname(abs).toLowerCase()] || "application/octet-stream";
    const content = fs.readFileSync(abs).toString("base64");
    return { filename, contentType, content, cid: filename };
  });
}

// ============== SMTP IMPLEMENTATION ==============

async function sendViaSmtp({ to, cc, subject, text, html, attachments = [], replyTo }) {
  getSmtpConfig();
  return sendSmtpMail({ to, cc, subject, text, html, attachments, replyTo });
}

// ============== AGENTMAIL IMPLEMENTATION ==============

const AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";

function getAgentMailHeaders() {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY not set. Get one at https://agentmail.to");
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function getWhitelist() {
  const raw = process.env.AGENTMAIL_WHITELIST || "";
  if (!raw) return [];
  return raw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}

function isWhitelisted(fromEmail) {
  const whitelist = getWhitelist();
  if (whitelist.length === 0) {
    console.warn("[email] No AGENTMAIL_WHITELIST set - rejecting all incoming emails");
    return false;
  }
  const normalized = fromEmail.toLowerCase().trim();
  return whitelist.some(allowed => normalized === allowed || normalized.endsWith(`@${allowed}`));
}

async function fetchAgentMail(endpoint, options = {}) {
  const url = `${AGENTMAIL_BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getAgentMailHeaders(),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AgentMail error: ${res.status} - ${err}`);
  }

  return res.json();
}

// ============== AGENTMAIL SEND ==============

async function sendViaAgentMail({ inboxId, to, cc, subject, text, html, attachments = [], replyTo }) {
  // AgentMail doesn't support CID inline — embed images as base64 data URIs instead
  let finalHtml = html;
  if (attachments.length) {
    const isImage = (ct) => ct.startsWith("image/");
    const extraImgs = attachments
      .filter(a => isImage(a.contentType))
      .map(a => `<img src="data:${a.contentType};base64,${a.content}" alt="${a.filename}" style="max-width:100%;display:block;margin:8px 0">`)
      .join("\n");
    for (const a of attachments) {
      finalHtml = finalHtml.replace(new RegExp(`cid:${a.cid}`, "g"), `data:${a.contentType};base64,${a.content}`);
    }
    if (extraImgs && !attachments.some(a => html.includes(`cid:${a.cid}`))) {
      finalHtml += `\n<hr>\n${extraImgs}`;
    }
  }

  const payload = { to, subject, text, html: finalHtml };
  if (cc && cc.length > 0) payload.cc = cc;
  // in_reply_to threads automatically via the send endpoint. Works for both
  // internally-sent messages and externally-received ones (where AgentMail's
  // dedicated /reply endpoint 404s because it only knows its own message IDs).
  if (replyTo) payload.in_reply_to = replyTo;

  const result = await fetchAgentMail(
    `/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return { id: result.message_id, threadId: result.thread_id, ...result };
}

// ============== TOOL IMPLEMENTATIONS ==============

export async function notifyEmailRun(args) {
  const { to, cc, subject, body, attachments: attachmentPaths = [], reply_to: replyTo } = args;

  const html = markdownToHtml(body);
  const text = markdownToText(body);
  const attachments = readAttachments(attachmentPaths);

  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
    const result = await sendViaAgentMail({
      inboxId: process.env.AGENTMAIL_INBOX_ID,
      to, cc, subject, text, html, attachments, replyTo,
    });
    const thread = replyTo ? " (in-thread reply)" : "";
    return `Email sent via AgentMail${thread} from ${process.env.AGENTMAIL_INBOX_ID}. ID: ${result.id}`;
  }
  await sendViaSmtp({ to, cc, subject, text, html, attachments, replyTo });
  return `Email sent via SMTP to ${Array.isArray(to) ? to.join(", ") : to}`;
}

// AgentMail returns `from` as a display string like 'Name <addr@example.com>'.
// Extract the raw email address for whitelist matching.
function extractEmail(fromStr) {
  if (!fromStr) return "";
  const m = String(fromStr).match(/<([^>]+)>/);
  return (m ? m[1] : fromStr).toLowerCase().trim();
}

// Local processed-message tracking. Avoids the agent re-responding to the same
// email every minute. AgentMail's API doesn't expose per-message read/unread
// flags, so we keep our own ledger at $TIM_DIR/email-processed.json.
import { timPath } from "../paths.js";

const processedPath = () => timPath("email-processed.json");

function loadProcessed() {
  try {
    return new Set(JSON.parse(fs.readFileSync(processedPath(), "utf8")));
  } catch {
    return new Set();
  }
}

function markProcessed(ids) {
  const set = loadProcessed();
  for (const id of ids) set.add(id);
  try {
    fs.writeFileSync(processedPath(), JSON.stringify([...set]));
  } catch (e) {
    console.warn(`[email] couldn't persist processed IDs: ${e.message}`);
  }
}

export async function receiveEmailRun(args = {}) {
  if (!process.env.AGENTMAIL_API_KEY) {
    throw new Error("AGENTMAIL_API_KEY not set. Configure it to receive emails, or use /env set AGENTMAIL_API_KEY=...");
  }

  const inboxId = args.inboxId || process.env.AGENTMAIL_INBOX_ID;
  if (!inboxId) {
    throw new Error("No inboxId provided and AGENTMAIL_INBOX_ID not set");
  }

  const limit = args.limit || 10;
  // Set dryRun: true to inspect without marking messages as processed.
  // Used by the scheduler's precheck so the agent's later call still sees the emails.
  const dryRun = args.dryRun === true;

  // List messages in the inbox. The list endpoint returns summaries (preview,
  // not full body); fetch each message individually for full text/html.
  const list = await fetchAgentMail(`/inboxes/${encodeURIComponent(inboxId)}/messages`);
  const messages = list.messages || [];
  if (!messages.length) return { emails: [], message: "No messages in inbox" };

  // Only incoming mail — skip anything we sent ourselves.
  const incoming = messages.filter((m) => !(m.labels || []).includes("sent"));

  // Whitelist + not-already-processed filter.
  const processed = loadProcessed();
  const filtered = incoming
    .filter((m) => isWhitelisted(extractEmail(m.from)))
    .filter((m) => !processed.has(m.message_id))
    .slice(0, limit);

  if (!filtered.length) {
    return {
      content: "No new emails in the inbox.",
      emails: [], count: 0, inbox: inboxId,
    };
  }

  // Fetch full body for each whitelisted message (list endpoint only gives previews).
  const emails = await Promise.all(filtered.map(async (m) => {
    let full = m;
    try {
      full = await fetchAgentMail(`/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(m.message_id)}`);
    } catch (e) {
      console.warn(`[email] couldn't fetch full body for ${m.message_id}: ${e.message}`);
    }
    return {
      id: m.message_id,          // pass this to notify_email's reply_to
      threadId: m.thread_id,
      from: full.from || m.from,
      to: full.to || m.to,
      subject: full.subject || m.subject || "(no subject)",
      body: full.text || full.extracted_text || m.preview || "",
      html: full.html || "",
      date: m.timestamp || m.created_at,
    };
  }));

  // Mark these IDs processed immediately so parallel polls don't re-serve them.
  // (Agent will respond in this turn; if it crashes mid-turn, worst case is we
  // miss a reply — preferable to looping and emailing the same person every minute.)
  if (!dryRun) markProcessed(emails.map((e) => e.id));

  // Render a human-readable summary as `content` — the ReAct loop passes this
  // to the LLM. Include the message `id` so the agent can pass it to reply_to.
  const content = `${emails.length} new email(s):\n\n` + emails.map((e, i) =>
    `### Email ${i + 1}\n`
    + `- From: ${e.from}\n`
    + `- Subject: ${e.subject}\n`
    + `- Message ID (for reply_to): ${e.id}\n`
    + `- Thread ID: ${e.threadId}\n`
    + `- Date: ${e.date}\n\n`
    + `${e.body.slice(0, 2000)}\n`
  ).join("\n---\n\n");

  return {
    content,
    emails, count: emails.length, inbox: inboxId,
  };
}

export async function createInboxRun(args) {
  if (!process.env.AGENTMAIL_API_KEY) {
    throw new Error("AGENTMAIL_API_KEY not set. Get one at https://agentmail.to");
  }

  const { username, domain = "agentmail.to" } = args;

  const inbox = await fetchAgentMail("/inboxes", {
    method: "POST",
    body: JSON.stringify({ username, domain }),
  });

  // Store the inbox ID if this is the first one
  if (!process.env.AGENTMAIL_INBOX_ID) {
    console.log(`[email] Created inbox ${inbox.id} (${inbox.address}). Set AGENTMAIL_INBOX_ID to use it as default.`);
  }

  return {
    id: inbox.id,
    address: inbox.address,
    username: inbox.username,
    domain: inbox.domain,
    message: `Inbox created: ${inbox.address}. Store the ID (${inbox.id}) in AGENTMAIL_INBOX_ID to receive emails here.`,
  };
}
