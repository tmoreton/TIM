// Minimal Fireworks (OpenAI-compatible) client. Uses native fetch + SSE parsing.

const BASE_URL = "https://api.fireworks.ai/inference/v1";

const getKey = () => {
  const k = process.env.FIREWORKS_API_KEY;
  if (!k) {
    console.error("Set FIREWORKS_API_KEY in your environment.");
    process.exit(1);
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
  throw err;
};

export async function complete(body, { signal } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  await throwIfBad(res);
  return res.json();
}

export async function* stream(body, { signal } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
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
