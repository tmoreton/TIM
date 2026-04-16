// Image generation via OpenRouter using Google's gemini-2.5-flash-image-preview
// (a.k.a. "nano banana"). Supports optional reference images for editing/variation.
// Saves the result under $TIM_DIR/images/ and returns the path. The agent loop
// also auto-attaches the generated image to the next model turn so the model
// can see what it produced.

import fs from "node:fs";
import path from "node:path";
import { providers } from "../providers.js";
import { timPath } from "../paths.js";

const OPENROUTER = providers.openrouter;
const MODELS = {
  flash: "google/gemini-3.1-flash-image-preview",
  pro: "google/gemini-3-pro-image-preview",
};

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const mimeFor = (p) => MIME_BY_EXT[path.extname(p).toLowerCase()] || "image/png";

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";

const encodeAsDataUrl = (filePath) => {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`reference image not found: ${filePath}`);
  const b64 = fs.readFileSync(abs).toString("base64");
  return `data:${mimeFor(abs)};base64,${b64}`;
};

// Find the generated image inside the OpenRouter response. Different models
// place it in different shapes; check the most common ones.
const extractImage = (msg) => {
  if (Array.isArray(msg?.images) && msg.images.length) {
    const img = msg.images[0];
    return img?.image_url?.url || img?.url || null;
  }
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      if (part?.type === "image_url" && part.image_url?.url) return part.image_url.url;
      if (part?.type === "output_image" && part.image_url?.url) return part.image_url.url;
    }
  }
  return null;
};

const writeDataUrl = (dataUrl, outPath) => {
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) throw new Error("model returned non-data-url image");
  fs.writeFileSync(outPath, Buffer.from(m[2], "base64"));
};

export const generateImage = {
  schema: {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt using Google's Gemini 3 image models via OpenRouter. Optionally pass reference_images (local paths) to edit or compose them. Saves the result to $TIM_DIR/images/ and returns the path. The generated image is also auto-attached so you can see it on the next turn.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to generate, or how to edit the reference images.",
          },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional local file paths to use as references for editing, style, or composition.",
          },
          quality: {
            type: "string",
            enum: ["flash", "pro"],
            description:
              "flash (default, fast, gemini-3.1-flash-image) or pro (slower, higher fidelity, gemini-3-pro-image).",
          },
          output_name: {
            type: "string",
            description:
              "Optional base name for the output file (no extension). Defaults to a slug of the prompt.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  run: async ({ prompt, reference_images = [], quality = "flash", output_name }, ctx = {}) => {
    const model = MODELS[quality] || MODELS.flash;
    try {
      const content = [{ type: "text", text: prompt }];
      for (const ref of reference_images) {
        content.push({ type: "image_url", image_url: { url: encodeAsDataUrl(ref) } });
      }

      const res = await fetch(`${OPENROUTER.baseUrl}/chat/completions`, {
        method: "POST",
        headers: OPENROUTER.headers(),
        body: JSON.stringify({
          model,
          modalities: ["image", "text"],
          messages: [{ role: "user", content }],
        }),
        signal: ctx.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return `ERROR: OpenRouter ${res.status}: ${text.slice(0, 300)}`;
      }

      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      const dataUrl = extractImage(msg);
      if (!dataUrl) {
        const textOut = typeof msg?.content === "string" ? msg.content : "";
        return `ERROR: no image in response${textOut ? ` (model said: ${textOut.slice(0, 200)})` : ""}`;
      }

      const dir = timPath("images");
      fs.mkdirSync(dir, { recursive: true });
      const base = slugify(output_name || prompt);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outPath = path.join(dir, `${base}-${stamp}.png`);
      writeDataUrl(dataUrl, outPath);

      return {
        content: `saved: ${outPath}`,
        attachImages: [outPath],
      };
    } catch (e) {
      return `ERROR: ${e.message}`;
    }
  },
};
