// Email tool - unified email sending and receiving for agents
// Supports: AgentMail (bidirectional), Resend API, and Custom SMTP (zero-dep fallback)

import { sendMail as sendSmtpMail, smtpConfig as getSmtpConfig } from "../smtp.js";

// ============== SCHEMAS ==============

export const notifyEmailSchema = {
  type: "function",
  function: {
    name: "notify_email",
    description: "Send email via AgentMail (if AGENTMAIL_API_KEY+AGENTMAIL_INBOX_ID set), Resend API, or custom SMTP. Renders markdown body to HTML with text fallback. Priority: AgentMail > Resend > SMTP.",
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
        body: { type: "string", description: "Email body in markdown (will be rendered to HTML with text fallback)" },
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

// ============== RESEND IMPLEMENTATION ==============

async function sendViaResend({ to, cc, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";

  const recipients = Array.isArray(to) ? to : [to];
  const ccList = cc || [];

  const payload = {
    from,
    to: recipients,
    subject,
    text,
    html,
  };

  if (ccList.length > 0) {
    payload.cc = ccList;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${res.status} - ${err}`);
  }

  return await res.json();
}

// ============== SMTP IMPLEMENTATION ==============

async function sendViaSmtp({ to, cc, subject, text, html }) {
  // Validate config exists
  getSmtpConfig();
  return sendSmtpMail({ to, cc, subject, text, html });
}

// ============== AGENTMAIL IMPLEMENTATION ==============

const AGENTMAIL_BASE_URL = "https://api.agentmail.to/v1";

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

async function sendViaAgentMail({ inboxId, to, cc, subject, text, html }) {
  const payload = {
    to,
    subject,
    text,
    html,
  };
  if (cc && cc.length > 0) {
    payload.cc = cc;
  }
  const result = await fetchAgentMail(`/inboxes/${inboxId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return result;
}

// ============== TOOL IMPLEMENTATIONS ==============

export async function notifyEmailRun(args) {
  const { to, cc, subject, body } = args;

  const html = markdownToHtml(body);
  const text = markdownToText(body);

  // Priority: 1) AgentMail if configured with inbox, 2) Resend, 3) SMTP
  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
    const result = await sendViaAgentMail({
      inboxId: process.env.AGENTMAIL_INBOX_ID,
      to,
      cc,
      subject,
      text,
      html,
    });
    return `Email sent via AgentMail from ${result.from?.address || process.env.AGENTMAIL_INBOX_ID}. ID: ${result.id}`;
  }
  if (process.env.RESEND_API_KEY) {
    const result = await sendViaResend({ to, cc, subject, text, html });
    return `Email sent via Resend. ID: ${result.id}`;
  }
  await sendViaSmtp({ to, cc, subject, text, html });
  return `Email sent via SMTP to ${Array.isArray(to) ? to.join(", ") : to}`;
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
  const markAsRead = args.markAsRead !== false;

  // Fetch unread messages
  const inbox = await fetchAgentMail(`/inboxes/${inboxId}`);

  if (!inbox.messages || inbox.messages.length === 0) {
    return { emails: [], message: "No new emails in inbox" };
  }

  // Filter by whitelist and unread status
  const filtered = inbox.messages
    .filter(msg => msg.status === "unread" || !markAsRead)
    .filter(msg => isWhitelisted(msg.from.address))
    .slice(0, limit);

  if (filtered.length === 0) {
    return { emails: [], message: "No new emails from whitelisted senders" };
  }

  // Mark as read if requested
  if (markAsRead) {
    for (const msg of filtered) {
      try {
        await fetchAgentMail(`/inboxes/${inboxId}/messages/${msg.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "read" }),
        });
      } catch (e) {
        console.warn(`[email] Failed to mark message ${msg.id} as read:`, e.message);
      }
    }
  }

  // Format for return
  const emails = filtered.map(msg => ({
    id: msg.id,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    body: msg.body?.text || msg.body?.html || "",
    date: msg.created_at,
    attachments: (msg.attachments || []).map(a => ({
      filename: a.filename,
      contentType: a.content_type,
      size: a.size,
    })),
  }));

  return {
    emails,
    count: emails.length,
    inbox: inbox.address,
    whitelist: getWhitelist(),
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
