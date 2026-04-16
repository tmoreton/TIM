// Image generation via OpenRouter (Gemini image models).
// Only registered when OPENROUTER_API_KEY is set.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { complete } from "../llm.js";

export const requiredEnv = "OPENROUTER_API_KEY";

const MODELS = {
  flash: "openrouter/google/gemini-3.1-flash-image-preview",
  pro: "openrouter/google/gemini-3-pro-image-preview",
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
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "image";

const encodeAsDataUrl = (filePath) => {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`reference image not found: ${filePath}`);
  return `data:${mimeFor(abs)};base64,${fs.readFileSync(abs).toString("base64")}`;
};

const extractImage = (msg) => {
  if (Array.isArray(msg?.images) && msg.images.length) {
    return msg.images[0]?.image_url?.url || msg.images[0]?.url || null;
  }
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      if (part?.type === "image_url" && part.image_url?.url) return part.image_url.url;
    }
  }
  return null;
};

const writeDataUrl = (dataUrl, outPath) => {
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) throw new Error("model returned non-data-url image");
  fs.writeFileSync(outPath, Buffer.from(m[2], "base64"));
};

export const schema = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Generate an image from a text prompt via OpenRouter Gemini models. Saves to $TIM_DIR/images/.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to generate" },
        reference_images: { type: "array", items: { type: "string" }, description: "Optional reference image paths" },
        quality: { type: "string", enum: ["flash", "pro"], description: "flash (fast) or pro (quality)" },
        output_name: { type: "string", description: "Optional base filename" },
      },
      required: ["prompt"],
    },
  },
};

export async function run({ prompt, reference_images = [], quality = "flash", output_name }, ctx = {}) {
  const model = MODELS[quality] || MODELS.flash;
  try {
    const content = [{ type: "text", text: prompt }];
    for (const ref of reference_images) {
      content.push({ type: "image_url", image_url: { url: encodeAsDataUrl(ref) } });
    }

    const data = await complete(
      { model, modalities: ["image", "text"], messages: [{ role: "user", content }] },
      { signal: ctx.signal },
    );

    const dataUrl = extractImage(data?.choices?.[0]?.message);
    if (!dataUrl) return `ERROR: no image in response`;

    const timDir = process.env.TIM_DIR || path.join(os.homedir(), ".tim");
    const dir = path.join(timDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${slugify(output_name || prompt)}-${Date.now()}.png`);
    writeDataUrl(dataUrl, outPath);

    return { content: `saved: ${outPath}`, attachImages: [outPath] };
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}
