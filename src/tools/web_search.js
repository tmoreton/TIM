// Web search via Tavily. Only registered when TAVILY_API_KEY is set.
// If the key is missing, the model falls back to web_fetch for URL retrieval.

export const requiredEnv = "TAVILY_API_KEY";

const TAVILY_BASE = "https://api.tavily.com";
const MAX_OUTPUT = 30_000;

const truncate = (s) => s.length <= MAX_OUTPUT ? s : s.slice(0, MAX_OUTPUT) + `\n...[truncated]`;

const post = async (path, body, signal) => {
  const res = await fetch(`${TAVILY_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
};

export const schema = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web via Tavily. Returns titles, URLs, and content snippets. Pair with web_fetch to read the full pages.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "number", description: "1-10, defaults to 5" },
        search_depth: { type: "string", enum: ["basic", "advanced"], description: "advanced for deeper search" },
      },
      required: ["query"],
    },
  },
};

export async function run({ query, max_results = 5, search_depth = "basic" }, ctx = {}) {
  try {
    const data = await post("/search", { query, max_results, search_depth }, ctx.signal);
    const results = data.results || [];
    if (!results.length) return "(no results)";
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || ""}`);
    const answer = data.answer ? `Answer: ${data.answer}\n\n` : "";
    return truncate(answer + lines.join("\n\n"));
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}
