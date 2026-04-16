// Minimal zero-dep SMTP client. Supports implicit TLS (typically :465) and
// STARTTLS (typically :587), AUTH LOGIN, and multipart/alternative bodies.
// Designed for the notify_email tool — not a general-purpose mail library.

import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import crypto from "node:crypto";

const CRLF = "\r\n";

const requireEnv = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} not set. Run \`/env set ${k}=...\``);
  return v;
};

export const smtpConfig = () => {
  const port = Number(process.env.SMTP_PORT || 587);
  // Port 465 is implicit TLS by convention. Allow override via SMTP_SECURE
  // for the rare server that uses 465 plain, or to force TLS on a non-465 port.
  const secureEnv = process.env.SMTP_SECURE;
  const secure = secureEnv
    ? /^(1|true|yes)$/i.test(secureEnv)
    : port === 465;
  return {
    host: requireEnv("SMTP_HOST"),
    port,
    user: requireEnv("SMTP_USER"),
    pass: requireEnv("SMTP_PASS"),
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    secure,
  };
};

// Reads SMTP responses line-by-line. A response is one or more lines all
// starting with the same 3-digit code; lines using `XXX-` continue, the
// final line uses `XXX `.
const makeReader = (socket) => {
  let buffer = "";
  const queue = [];
  let resolver = null;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf(CRLF)) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      queue.push(line);
      if (resolver) {
        const r = resolver;
        resolver = null;
        r(queue.shift());
      }
    }
  });

  const nextLine = () =>
    new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      resolver = resolve;
      socket.once("error", reject);
      socket.once("close", () => resolver && reject(new Error("socket closed")));
    });

  return async () => {
    const lines = [];
    while (true) {
      const line = await nextLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) break;
      if (!/^\d{3}[- ]/.test(line)) throw new Error(`bad SMTP line: ${line}`);
    }
    const code = Number(lines[lines.length - 1].slice(0, 3));
    return { code, lines };
  };
};

const send = (socket, line) =>
  new Promise((resolve, reject) =>
    socket.write(line + CRLF, (err) => (err ? reject(err) : resolve())),
  );

const expect = async (read, ok) => {
  const r = await read();
  const okList = Array.isArray(ok) ? ok : [ok];
  if (!okList.includes(r.code)) {
    throw new Error(`SMTP error: ${r.lines.join(" | ")}`);
  }
  return r;
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Wrap a body for SMTP DATA: dot-stuff lines starting with ".", normalize CRLF.
const dotStuff = (body) =>
  body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith(".") ? "." + l : l))
    .join(CRLF);

const formatAddrList = (addrs) =>
  (Array.isArray(addrs) ? addrs : [addrs]).filter(Boolean);

const buildMessage = ({ from, to, cc, subject, text, html }) => {
  const boundary = `=_tim_${crypto.randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${from}`,
    `To: ${formatAddrList(to).join(", ")}`,
    cc?.length ? `Cc: ${formatAddrList(cc).join(", ")}` : null,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString("hex")}@${os.hostname()}>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    text,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    html,
    `--${boundary}--`,
  ];

  return headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
};

const connect = ({ host, port, secure }) =>
  new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.once("error", reject);
    socket.setEncoding("utf8");
  });

const upgradeToTls = (socket, host) =>
  new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.setEncoding("utf8");
    secure.once("error", reject);
  });

const supportsStartTls = (lines) =>
  lines.some((l) => /^\d{3}[- ]STARTTLS\b/i.test(l));

export async function sendMail({ to, cc, subject, text, html }) {
  const cfg = smtpConfig();
  const ehloHost = os.hostname() || "localhost";
  let socket = await connect(cfg);
  let read = makeReader(socket);

  try {
    await expect(read, 220);
    await send(socket, `EHLO ${ehloHost}`);
    let ehlo = await expect(read, 250);

    if (!cfg.secure && supportsStartTls(ehlo.lines)) {
      await send(socket, "STARTTLS");
      await expect(read, 220);
      socket = await upgradeToTls(socket, cfg.host);
      read = makeReader(socket);
      await send(socket, `EHLO ${ehloHost}`);
      ehlo = await expect(read, 250);
    }

    await send(socket, "AUTH LOGIN");
    await expect(read, 334);
    await send(socket, b64(cfg.user));
    await expect(read, 334);
    await send(socket, b64(cfg.pass));
    await expect(read, 235);

    await send(socket, `MAIL FROM:<${cfg.from}>`);
    await expect(read, 250);

    const recipients = [...formatAddrList(to), ...formatAddrList(cc)];
    for (const rcpt of recipients) {
      await send(socket, `RCPT TO:<${rcpt}>`);
      await expect(read, [250, 251]);
    }

    await send(socket, "DATA");
    await expect(read, 354);

    const message = buildMessage({ from: cfg.from, to, cc, subject, text, html });
    await send(socket, dotStuff(message));
    await send(socket, ".");
    await expect(read, 250);

    await send(socket, "QUIT");
  } finally {
    socket.end();
    socket.destroy();
  }
}
