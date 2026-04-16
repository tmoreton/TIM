// Fetch web content via raw HTTP (no API key required)
// Simple HTML-to-text extraction for reading articles, docs, etc.

const MAX_OUTPUT = 30_000;

const truncate = (s) =>
  s.length <= MAX_OUTPUT ? s : s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]`;

const htmlToText = (html) => {
  // Remove script/style tags and their contents
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  
  // Convert block elements to newlines
  text = text
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "\n- ")
    .replace(/<\/h[1-6]>/gi, "\n\n");
  
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, " ");
  
  // Clean up entities and whitespace
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const fetchOne = async (url, signal) => {
  const res = await fetch(url, { 
    signal, 
    headers: { 
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    } 
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return htmlToText(html);
};

export const schema = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch and extract text content from one or more URLs. No API key required.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          oneOf: [
            { type: "string", description: "Single URL to fetch" },
            { type: "array", items: { type: "string" }, description: "Multiple URLs to fetch" },
          ],
          description: "URL(s) to fetch content from",
        },
      },
      required: ["urls"],
    },
  },
};

export async function run({ urls }, ctx = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  const parts = [];
  
  for (const url of list) {
    try {
      const text = await fetchOne(url, ctx.signal);
      parts.push(`--- ${url} ---\n${text}`);
    } catch (e) {
      parts.push(`--- ${url} (failed) ---\n${e.message}`);
    }
  }
  
  return truncate(parts.join("\n\n"));
}
