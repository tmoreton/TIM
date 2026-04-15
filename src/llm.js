// Fireworks AI client (OpenAI-compatible API).
// complete() for single-shot, stream() for SSE streaming with retry logic.

const BASE_URL = "https://api.fireworks.ai/inference/v1";

const getKey = () => {
  const k = process.env.FIREWORKS_API_KEY;
  if (!k) {
    throw new Error(
      "FIREWORKS_API_KEY not set. Export it in your shell, or add `FIREWORKS_API_KEY=...` to ~/.tim/.env",
    );
  }
  return k;
};

const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${getKey()}`,
});

const throwIfBad = async (res) => {
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  const err = new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  err.status = res.status;
  err.retryAfter = Number(res.headers.get("retry-after")) || 0;
  throw err;
};

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const ESC = "\x1b[";

// Clear current line and move to start (for cleaning up spinner before writing)
const clearLine = () => process.stdout.write(`\r${ESC}K`);

const fetchWithRetry = async (url, init) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !RETRY_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS - 1) return res;
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const wait = retryAfter * 1000 || backoff(attempt);
      clearLine();
      process.stderr.write(`  retrying in ${Math.round(wait)}ms (HTTP ${res.status}, attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
      await sleep(wait, init.signal);
      clearLine();
    } catch (e) {
      if (init.signal?.aborted || attempt >= MAX_ATTEMPTS - 1) {
        if (e?.cause?.code) e.message = `${e.message} (${e.cause.code})`;
        throw e;
      }
      const wait = backoff(attempt);
      clearLine();
      process.stderr.write(`  retrying in ${Math.round(wait)}ms (${e.cause?.code || e.message}, attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
      await sleep(wait, init.signal);
      clearLine();
    }
  }
};

const backoff = (attempt) => 250 * 2 ** attempt + Math.floor(Math.random() * 250);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function complete(body, { signal } = {}) {
  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  await throwIfBad(res);
  return res.json();
}

export async function* stream(body, { signal } = {}) {
  const res = await fetchWithRetry(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  await throwIfBad(res);

  const decoder = new TextDecoder();
  let buffer = "";
  let lineBuffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    
    // Process line by line to handle events split across chunks
    const lines = buffer.split("\n");
    // Keep the last (potentially incomplete) line in buffer
    buffer = lines.pop() ?? "";
    
    for (const line of lines) {
      lineBuffer += line;
      
      // Empty line means end of SSE event
      if (line === "") {
        // Parse the accumulated event data
        const dataMatch = lineBuffer.match(/data: (.+)/);
        if (dataMatch) {
          const payload = dataMatch[1].trim();
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload);
          } catch {
            // skip malformed chunk
          }
        }
        lineBuffer = "";
      } else {
        lineBuffer += "\n";
      }
    }
  }
  
  // Process any remaining data
  if (buffer) {
    lineBuffer += buffer;
    const dataMatch = lineBuffer.match(/data: (.+)/);
    if (dataMatch) {
      const payload = dataMatch[1].trim();
      if (payload !== "[DONE]") {
        try {
          yield JSON.parse(payload);
        } catch {
          // skip malformed chunk
        }
      }
    }
  }
}
